'use strict';

/**
 * Conferencia rapida da planilha do Google, sem abrir o navegador.
 * Le as ultimas linhas gravadas pelo Web App do Apps Script.
 *
 * Rodar:
 *   npm run planilha          ultimas 20 linhas
 *   npm run planilha -- 50    ultimas 50 linhas
 *
 * O segredo vai no corpo do POST (nunca na URL): o Web App e publico e dado de
 * lead nao pode trafegar numa query string.
 */

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
  }
}
loadEnv();

const url = (process.env.SHEETS_WEBHOOK_URL || '').trim();
const secret = process.env.SHEETS_SECRET || '';
const limit = parseInt(process.argv[2], 10) || 20;

if (!url) {
  console.error('SHEETS_WEBHOOK_URL nao esta definido no .env.');
  process.exit(1);
}

function coluna(valor, largura) {
  const texto = String(valor === null || valor === undefined ? '' : valor);
  const corte = texto.length > largura ? `${texto.slice(0, largura - 1)}…` : texto;
  return corte.padEnd(largura);
}

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ secret, action: 'read', limit }),
  redirect: 'follow',
  signal: AbortSignal.timeout(20000),
})
  .then(async (res) => {
    const texto = await res.text();
    let data;
    try {
      data = JSON.parse(texto);
    } catch (err) {
      throw new Error('resposta nao e JSON (confira a URL e o acesso do Web App)');
    }
    if (!data.ok) throw new Error(data.error || 'recusado pela planilha');
    if (!data.rows) {
      throw new Error('a implantacao ainda e a versao antiga: publique "Nova versao" no Apps Script');
    }

    if (!data.rows.length) {
      console.log('Planilha vazia (so o cabecalho).');
      return;
    }

    console.log('');
    console.log(
      coluna('data_hora', 21) + coluna('nome', 22) + coluna('whatsapp', 16) +
      coluna('giro', 5) + coluna('premio', 34) + coluna('cupom', 10) + 'ganhou'
    );
    console.log('-'.repeat(115));
    for (const l of data.rows) {
      console.log(
        coluna(String(l.data_hora).slice(0, 19).replace('T', ' '), 21) +
        coluna(l.nome, 22) + coluna(l.whatsapp, 16) + coluna(l.giro, 5) +
        coluna(l.premio || '(sem giro)', 34) + coluna(l.cupom || '-', 10) + (l.ganhou || '-')
      );
    }
    console.log('');
    console.log(`${data.rows.length} linha(s).`);
  })
  .catch((err) => {
    console.error('Falhou:', err.message);
    process.exit(1);
  });
