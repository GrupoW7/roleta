'use strict';

/**
 * Teste de fumaca do backend da roleta.
 * Sobe o servidor num diretorio de dados temporario e verifica:
 *  1. validacao do lead (LGPD obrigatorio, whatsapp valido)
 *  2. deduplicacao: mesmo whatsapp no mesmo dia nao gera lead novo
 *  3. cotas do dia nunca sao estouradas, mesmo com muito mais giros que cota
 *  4. "tente outra vez" da exatamente 1 giro extra e nao repete no re-giro
 *  5. o gomo devolvido corresponde ao premio sorteado
 *  6. a liberacao progressiva segura os brindes ao longo das 8h do evento
 *  7. o token assinado deixa o giro acontecer mesmo sem o lead em memoria
 *
 * Rodar: npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roleta-test-'));
process.env.DATA_DIR = TMP;
process.env.ADMIN_TOKEN = 'test-token';
// Teste NUNCA escreve na planilha de verdade: o .env do estande tem a URL real,
// e o servidor le esse .env quando a variavel nao esta definida no processo.
process.env.SHEETS_WEBHOOK_URL = '';

const { server, config } = require('../server.js');

const PRIZE_BY_ID = new Map(config.prizes.map((p) => [p.id, p]));
let base = '';

function post(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
}

function get(pathname) {
  return fetch(base + pathname).then(async (res) => ({ status: res.status, data: await res.json() }));
}

function admin(pathname, body) {
  return fetch(base + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'test-token' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
}

/** Move a janela do evento para controlar o `progress` sem mexer no relogio. */
function setWindow(start, end) {
  return admin('/api/admin/event-window', { start, end });
}

/** "HH:MM" deslocado em minutos, com clamp no dia (nao vira a meia-noite). */
function clockShift(hhmm, deltaMinutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + deltaMinutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function newLead(i) {
  const res = await post('/api/lead', {
    name: `Visitante ${i}`,
    whatsapp: `5511${String(900000000 + i)}`,
    segment: 'tecnologia',
    consent: true,
    lang: ['pt', 'en', 'es'][i % 3],
  });
  assert.strictEqual(res.status, 201, `lead ${i} deveria ser criado`);
  return res.data.leadId;
}

/** Roda N participacoes (lead + 1 giro) e devolve quanto saiu de cada premio. */
async function runSpins(count, offset) {
  const counts = {};
  config.prizes.forEach((p) => { counts[p.id] = 0; });
  for (let i = 0; i < count; i += 1) {
    const leadId = await newLead(offset + i);
    const spin = await post('/api/spin', { leadId });
    assert.strictEqual(spin.status, 200, `giro ${offset + i} deveria funcionar`);
    counts[spin.data.prizeId] += 1;
  }
  return counts;
}

async function run() {
  /* 1. validacao ------------------------------------------------------ */
  const noConsent = await post('/api/lead', {
    name: 'Sem Aceite', whatsapp: '5511999998888', segment: 'saude', consent: false, lang: 'pt',
  });
  assert.strictEqual(noConsent.status, 400, 'lead sem aceite LGPD deve ser rejeitado');
  assert.ok(noConsent.data.fields.includes('consent'));

  const badPhone = await post('/api/lead', {
    name: 'Telefone Curto', whatsapp: '123', segment: 'saude', consent: true, lang: 'pt',
  });
  assert.strictEqual(badPhone.status, 400, 'whatsapp invalido deve ser rejeitado');

  /* 2. deduplicacao --------------------------------------------------- */
  const first = await post('/api/lead', {
    name: 'Maria Teste', whatsapp: '5511911112222', segment: 'varejo', consent: true, lang: 'pt',
  });
  const again = await post('/api/lead', {
    name: 'Maria Teste', whatsapp: '+55 (11) 91111-2222', segment: 'varejo', consent: true, lang: 'pt',
  });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(again.status, 200, 'mesmo whatsapp no mesmo dia devolve a sessao existente');
  assert.strictEqual(again.data.leadId, first.data.leadId, 'nao deve duplicar o lead');
  assert.strictEqual(again.data.returning, true);

  /* Janela ja encerrada => cota do dia toda liberada -------------------- */
  const opened = await setWindow('00:00', '00:01');
  assert.strictEqual(opened.status, 200, 'ajuste da janela do evento deve funcionar');
  assert.strictEqual(
    opened.data.progress,
    1,
    'com a janela encerrada a cota fica 100% liberada (falha só se o teste rodar no 1º minuto do dia)',
  );

  const badWindow = await setWindow('18:00', '09:00');
  assert.strictEqual(badWindow.status, 400, 'janela invertida deve ser rejeitada');

  /* 3 + 4. giros em volume ------------------------------------------- */
  const TOTAL_LEADS = 150;
  const counts = {};
  const retryLeads = [];
  config.prizes.forEach((p) => { counts[p.id] = 0; });

  for (let i = 0; i < TOTAL_LEADS; i += 1) {
    const leadId = await newLead(i);
    const spin = await post('/api/spin', { leadId });
    assert.strictEqual(spin.status, 200, `giro ${i} deveria funcionar`);

    const prize = PRIZE_BY_ID.get(spin.data.prizeId);
    assert.ok(prize, 'premio sorteado precisa existir na config');
    assert.strictEqual(
      spin.data.segmentIndex,
      config.wheelOrder.indexOf(spin.data.prizeId),
      'o gomo devolvido tem de ser o do premio sorteado',
    );
    assert.strictEqual(!!spin.data.code, !!prize.needsCode, 'codigo so nos premios resgataveis');
    counts[spin.data.prizeId] += 1;

    if (spin.data.prizeId === 'tente_outra_vez') {
      assert.strictEqual(spin.data.spinsLeft, 1, '"tente outra vez" precisa liberar 1 giro extra');
      retryLeads.push(leadId);
    } else {
      assert.strictEqual(spin.data.spinsLeft, 0, 'demais resultados encerram a participacao');
      const blocked = await post('/api/spin', { leadId });
      assert.strictEqual(blocked.status, 409, 'nao pode girar duas vezes sem ganhar giro extra');
      assert.strictEqual(blocked.data.error, 'no_spins_left');
    }
  }

  for (const leadId of retryLeads) {
    const respin = await post('/api/spin', { leadId });
    assert.strictEqual(respin.status, 200, 'o giro extra deve funcionar');
    assert.notStrictEqual(respin.data.prizeId, 'tente_outra_vez', 're-giro nao pode cair em "tente outra vez"');
    assert.strictEqual(respin.data.spinsLeft, 0, 'o giro extra e unico');
    counts[respin.data.prizeId] += 1;

    const third = await post('/api/spin', { leadId });
    assert.strictEqual(third.status, 409, 'maximo de 2 giros por pessoa por dia');
  }

  /* 3. cotas ---------------------------------------------------------- */
  const stats = await fetch(`${base}/api/admin/stats`, { headers: { 'X-Admin-Token': 'test-token' } })
    .then((r) => r.json());

  const totalSpins = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(stats.spins, totalSpins, 'contagem de giros do painel tem de casar');
  assert.strictEqual(stats.leads, TOTAL_LEADS + 1, 'leads do dia (inclui o lead da deduplicacao)');

  for (const prize of config.prizes) {
    if (prize.dailyLimit === null) continue;
    assert.ok(
      counts[prize.id] <= prize.dailyLimit,
      `${prize.id} estourou a cota: ${counts[prize.id]} > ${prize.dailyLimit}`,
    );
  }

  /* Sem token o painel nao responde ----------------------------------- */
  const unauth = await get('/api/admin/stats');
  assert.strictEqual(unauth.status, 401, 'painel exige token');

  /* 6. liberacao progressiva ao longo das 8h --------------------------- */
  const buffer = config.pacing.buffer;
  const limited = config.prizes.filter((p) => p.dailyLimit !== null);
  const now = stats.now;
  const nowMin = Number(now.split(':')[0]) * 60 + Number(now.split(':')[1]);
  const paceReport = [];

  // Abertura do estande (progresso 0): so o colchao inicial pode sair.
  if (nowMin <= 21 * 60) {
    const future = await setWindow(clockShift(now, 60), clockShift(now, 120));
    assert.strictEqual(future.data.progress, 0, 'antes da abertura o progresso e 0');
    await admin('/api/admin/reset-day', {});
    const atOpen = await runSpins(40, 5000);
    for (const prize of limited) {
      assert.ok(
        atOpen[prize.id] <= buffer,
        `na abertura ${prize.id} devia sair no maximo ${buffer}x em 40 giros, saiu ${atOpen[prize.id]}`,
      );
      paceReport.push([`abertura  ${prize.id}`, atOpen[prize.id], buffer]);
    }
  } else {
    console.log('  (teste de abertura pulado: horario atual nao permite janela futura)');
  }

  // Metade do evento: no maximo metade da cota pode ter saido.
  if (nowMin >= 4 * 60 && nowMin <= 19 * 60) {
    const mid = await setWindow(clockShift(now, -240), clockShift(now, 240));
    assert.ok(Math.abs(mid.data.progress - 0.5) < 0.01, 'no meio da janela o progresso e ~0,5');
    await admin('/api/admin/reset-day', {});
    const atMid = await runSpins(220, 20000);
    for (const prize of limited) {
      // +1 de folga: o relogio anda enquanto o teste roda e pode liberar mais um.
      const cap = Math.floor(prize.dailyLimit * 0.5) + buffer + 1;
      assert.ok(
        atMid[prize.id] <= cap,
        `na metade do evento ${prize.id} devia sair no maximo ${cap}x, saiu ${atMid[prize.id]}`,
      );
      paceReport.push([`metade    ${prize.id}`, atMid[prize.id], cap]);
    }
    const totalPrizes = limited.reduce((acc, p) => acc + atMid[p.id], 0);
    assert.ok(totalPrizes > 0, 'a liberacao progressiva nao pode travar tudo');
  } else {
    console.log('  (teste de meio de evento pulado: horario atual nao permite a janela)');
  }

  /* 7. token do lead: o giro sobrevive a perda do estado em memoria ----- */
  // Vale para deploy serverless (cada requisicao numa instancia) e para
  // reinicio do servidor no meio do atendimento. O reset-day limpa os leads
  // da memoria, que e exatamente o que a outra instancia "nao conhece".
  const tokenLead = await post('/api/lead', {
    name: 'Token Teste', whatsapp: '5511977776666', segment: 'tecnologia', consent: true, lang: 'pt',
  });
  assert.strictEqual(tokenLead.status, 201);
  assert.ok(tokenLead.data.leadToken, 'o cadastro precisa devolver o token do lead');

  await admin('/api/admin/reset-day', {});

  const semToken = await post('/api/spin', { leadId: tokenLead.data.leadId });
  assert.strictEqual(semToken.status, 404, 'sem token, lead perdido continua 404');

  const comToken = await post('/api/spin', {
    leadId: tokenLead.data.leadId,
    leadToken: tokenLead.data.leadToken,
  });
  assert.strictEqual(comToken.status, 200, 'com token, o giro precisa acontecer mesmo sem o lead em memoria');
  assert.ok(comToken.data.leadToken, 'o giro devolve o token atualizado');

  // o giro acima reidratou o lead na memoria: limpa de novo para testar a assinatura
  await admin('/api/admin/reset-day', {});

  const adulterado = await post('/api/spin', {
    leadId: tokenLead.data.leadId,
    leadToken: `${tokenLead.data.leadToken.split('.')[0]}.assinaturafalsa`,
  });
  assert.strictEqual(adulterado.status, 404, 'token com assinatura invalida tem que ser recusado');

  await admin('/api/admin/reset-day', {});

  /* Relatorio --------------------------------------------------------- */
  console.log('');
  console.log(`  ${TOTAL_LEADS} leads / ${totalSpins} giros (${retryLeads.length} giros extras)`);
  console.log('  ------------------------------------------------');
  for (const prize of config.prizes) {
    const limit = prize.dailyLimit === null ? 'ilimitado' : prize.dailyLimit;
    console.log(`  ${prize.id.padEnd(20)} ${String(counts[prize.id]).padStart(4)}  / cota ${limit}`);
  }
  console.log('  ------------------------------------------------');

  if (paceReport.length) {
    console.log('');
    console.log('  Liberacao progressiva (saiu / teto no momento)');
    console.log('  ------------------------------------------------');
    for (const [label, got, cap] of paceReport) {
      console.log(`  ${label.padEnd(32)} ${String(got).padStart(3)} / ${cap}`);
    }
    console.log('  ------------------------------------------------');
  }

  console.log('  OK: cotas respeitadas, dedup, giro extra, validacao, ritmo do dia e token do lead.');
  console.log('');
}

server.listen(0, async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('  FALHOU:', err.message);
    console.error('');
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
});
