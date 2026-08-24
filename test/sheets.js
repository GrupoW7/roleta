'use strict';

/**
 * Teste do envio para a planilha do Google.
 * Sobe um mock do Web App do Apps Script (mesma logica de upsert por `chave`)
 * e verifica, atraves do fluxo real de cadastro + giro:
 *  1. o cadastro ja cria a linha do giro 1, sem premio
 *  2. o giro completa a MESMA linha (nao duplica) com premio e cupom
 *  3. quem ganha sai com ganhou=sim e cupom preenchido; quem nao ganha, sem cupom
 *  4. o segredo compartilhado e enviado em toda requisicao
 *  5. planilha fora do ar nao derruba o giro: a linha fica na fila e sobe depois
 *
 * Rodar: node test/sheets.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SECRET = 'segredo-de-teste';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roleta-sheets-'));

/* ------------------------------------------------------------------ */
/* Mock do Apps Script                                                 */
/* ------------------------------------------------------------------ */
const sheet = new Map(); // chave -> linha (mesmo upsert do Codigo.gs)
let recebidas = 0;
let offline = true; // comeca recusando, para exercitar a fila

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    if (offline) {
      res.writeHead(500).end('indisponivel');
      return;
    }
    const body = JSON.parse(raw);
    assert.strictEqual(body.secret, SECRET, 'segredo compartilhado precisa ir no payload');
    for (const row of body.rows || []) {
      sheet.set(row.chave, row);
      recebidas += 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saved: (body.rows || []).length }));
  });
});

function esperar(condicao, mensagem, limiteMs = 8000) {
  const inicio = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condicao()) return resolve();
      if (Date.now() - inicio > limiteMs) return reject(new Error(`timeout: ${mensagem}`));
      return setTimeout(tick, 50);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */
/* Servidor da roleta apontando para o mock                            */
/* ------------------------------------------------------------------ */
let base = '';

function post(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
}

function novoLead(n) {
  return post('/api/lead', {
    name: `Visitante ${n}`,
    whatsapp: `5519900${String(n).padStart(5, '0')}`,
    segment: 'tecnologia',
    consent: true,
    lang: 'pt',
  });
}

async function run() {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;

  process.env.DATA_DIR = TMP;
  process.env.ADMIN_TOKEN = 'test-token';
  process.env.SHEETS_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/exec`;
  process.env.SHEETS_SECRET = SECRET;

  const { server, adminStats } = require('../server.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  /* 5. planilha fora do ar: o giro tem que passar mesmo assim */
  const primeiro = await novoLead(1);
  assert.strictEqual(primeiro.status, 201, 'cadastro deve funcionar com a planilha fora do ar');
  const giroOffline = await post('/api/spin', { leadId: primeiro.data.leadId });
  assert.strictEqual(giroOffline.status, 200, 'giro nao pode depender da planilha');

  await esperar(() => adminStats().sheets.lastError, 'erro de envio registrado no painel');
  assert.ok(adminStats().sheets.pending >= 1, 'linha precisa ficar na fila enquanto a planilha nao responde');
  assert.ok(fs.existsSync(path.join(TMP, 'sheets-queue.jsonl')), 'fila precisa ser gravada em disco');

  /* a fila sobe sozinha quando a planilha volta */
  offline = false;
  await esperar(() => sheet.size >= 1, 'fila enviada depois que a planilha voltou', 15000);

  /* 1 e 2. cadastro cria a linha; o giro completa a mesma linha */
  const segundo = await novoLead(2);
  const leadId = segundo.data.leadId;
  await esperar(() => sheet.has(`${leadId}#1`), 'linha do cadastro chegou na planilha');

  const linhaCadastro = sheet.get(`${leadId}#1`);
  assert.strictEqual(linhaCadastro.nome, 'Visitante 2');
  assert.strictEqual(linhaCadastro.whatsapp, '+551990000002', 'whatsapp vai com + para o Sheets');
  assert.strictEqual(linhaCadastro.premio, '', 'antes de girar a linha nao tem premio');
  assert.strictEqual(linhaCadastro.cupom, '', 'antes de girar a linha nao tem cupom');
  assert.strictEqual(linhaCadastro.giro, 1);

  const antes = sheet.size;
  const giro = await post('/api/spin', { leadId });
  await esperar(
    () => (sheet.get(`${leadId}#1`) || {}).premio,
    'linha do cadastro completada pelo giro'
  );
  assert.strictEqual(sheet.size, antes, 'o giro atualiza a linha do cadastro, nao cria outra');

  const linhaGiro = sheet.get(`${leadId}#1`);
  assert.ok(linhaGiro.premio, 'premio precisa sair por extenso');
  assert.strictEqual(linhaGiro.ganhou, giro.data.isPrize ? 'sim' : 'nao');
  assert.strictEqual(linhaGiro.cupom, giro.data.code || '');
  assert.strictEqual(linhaGiro.lead_id, leadId);

  /* 3. em varios giros, cupom e ganhou tem que andar sempre juntos */
  let ganhou = 0;
  let perdeu = 0;
  for (let i = 3; i < 33; i += 1) {
    const lead = await novoLead(i);
    const r = await post('/api/spin', { leadId: lead.data.leadId });
    if (r.data.isPrize) ganhou += 1;
    else perdeu += 1;
  }

  await esperar(() => adminStats().sheets.pending === 0, 'fila zerada apos os giros', 20000);

  let comCupom = 0;
  for (const linha of sheet.values()) {
    if (!linha.premio) continue; // cadastro sem giro
    if (linha.ganhou === 'sim') {
      assert.ok(/^JU-[A-Z2-9]{5}$/.test(linha.cupom), `premiado sem cupom valido: ${linha.cupom}`);
      comCupom += 1;
    } else {
      assert.strictEqual(linha.cupom, '', 'quem nao ganhou nao pode receber cupom');
    }
    assert.ok(/^[0-9a-f-]+#\d+$/.test(linha.chave), 'chave precisa ser leadId#giro');
  }

  assert.ok(ganhou > 0, 'o teste precisa ter pelo menos um premiado');
  assert.ok(perdeu > 0, 'o teste precisa ter pelo menos um nao premiado');
  assert.ok(comCupom >= 1, 'nenhum cupom chegou na planilha');
  assert.ok(recebidas >= sheet.size, 'contagem de linhas recebidas inconsistente');

  const status = adminStats().sheets;
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.pending, 0);
  assert.strictEqual(status.lastError, null, 'erro antigo deve ser limpo apos envio bem sucedido');

  console.log(`ok - planilha: ${sheet.size} linhas, ${comCupom} com cupom (${ganhou} premiados / ${perdeu} nao premiados)`);

  server.close();
  mock.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

run().catch((err) => {
  console.error('FALHOU:', err.message);
  process.exit(1);
});
