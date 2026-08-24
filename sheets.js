'use strict';

/**
 * Envio dos cadastros/giros para a planilha do Google.
 *
 * O servidor NAO fala com a API do Google direto: ele faz POST num Web App do
 * Apps Script publicado na propria planilha (veja google-apps-script/Codigo.gs).
 * Assim o estande nao precisa de service account, chave privada nem dependencia.
 *
 * Regras de estande:
 *  - o envio e assincrono: a roleta nunca espera a planilha para responder o giro;
 *  - excecao: num deploy serverless a instancia congela assim que a resposta sai,
 *    e o envio agendado nunca roda - por isso existe o modo `sync`, que espera o
 *    envio antes de responder. So a demo hospedada usa isso; o estande nao;
 *  - se o wi-fi do evento cair, as linhas ficam numa fila em disco e sobem depois
 *    (a fila sobrevive a reinicio do servidor);
 *  - cada linha tem uma `chave` (leadId#giro): reenviar a mesma chave atualiza a
 *    linha existente em vez de duplicar.
 */

const fs = require('fs');
const path = require('path');

const BATCH = 20;
const TIMEOUT_MS = 15000;
const BACKOFF_MS = [3000, 10000, 30000, 60000, 120000];
const MAX_QUEUE = 5000;

/**
 * Aceita apenas https (o Web App do Apps Script sempre e https). http vale so
 * para localhost, usado pelo mock dos testes - dado de lead nao pode trafegar
 * em claro na rede do evento.
 */
function isSupported(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  } catch (err) {
    return false;
  }
}

function createSheets(options) {
  const url = String((options && options.url) || '').trim();
  const secret = String((options && options.secret) || '');
  const queueFile = options && options.queueFile;
  const sync = !!(options && options.sync);
  const enabled = isSupported(url);

  let queue = [];
  let sending = false;
  let timer = null;
  let attempt = 0;
  const stats = { sent: 0, lastOkAt: null, lastError: null, lastErrorAt: null };

  /* -------------------------------------------------- */
  /* Fila em disco                                       */
  /* -------------------------------------------------- */
  function persist() {
    if (!queueFile) return;
    try {
      const body = queue.map((row) => JSON.stringify(row)).join('\n');
      const tmp = `${queueFile}.tmp`;
      fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
      fs.renameSync(tmp, queueFile);
    } catch (err) {
      // Fila e rede de seguranca; falhar aqui nao pode derrubar o atendimento.
      console.error('[planilha] falha ao gravar a fila:', err.message);
    }
  }

  function restore() {
    if (!queueFile || !fs.existsSync(queueFile)) return;
    try {
      for (const line of fs.readFileSync(queueFile, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          queue.push(JSON.parse(line));
        } catch (err) {
          /* ignora linha invalida */
        }
      }
      if (queue.length) console.log(`  planilha: ${queue.length} linha(s) pendente(s) da sessao anterior`);
    } catch (err) {
      console.error('[planilha] falha ao ler a fila:', err.message);
    }
  }

  /* -------------------------------------------------- */
  /* Envio                                               */
  /* -------------------------------------------------- */
  function schedule(ms) {
    if (timer || !queue.length) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, ms);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (!enabled || sending || !queue.length) return;
    sending = true;
    try {
      const batch = queue.slice(0, BATCH);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, rows: batch }),
        redirect: 'follow', // o Web App do Apps Script responde via redirect
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        // HTML no lugar de JSON = Web App sem acesso "qualquer pessoa" ou URL errada.
        throw new Error('resposta nao e JSON (confira a URL e o acesso do Web App)');
      }
      if (!data.ok) throw new Error(data.error || 'recusado pela planilha');

      queue = queue.slice(batch.length);
      persist();
      stats.sent += batch.length;
      stats.lastOkAt = new Date().toISOString();
      stats.lastError = null;
      attempt = 0;
    } catch (err) {
      stats.lastError = err.message;
      stats.lastErrorAt = new Date().toISOString();
      console.error('[planilha] envio falhou:', err.message);
      attempt = Math.min(attempt + 1, BACKOFF_MS.length - 1);
    } finally {
      sending = false;
    }
    schedule(stats.lastError ? BACKOFF_MS[attempt] : 250);
  }

  /* -------------------------------------------------- */
  /* API do modulo                                       */
  /* -------------------------------------------------- */
  return {
    enabled,
    sync,

    /**
     * Enfileira uma linha. Mesma `chave` substitui a pendente (o cadastro entra
     * como linha em branco de premio e o giro completa a mesma linha).
     */
    enqueue(row) {
      if (!enabled || !row || !row.chave) return false;
      const at = queue.findIndex((item) => item.chave === row.chave);
      if (at >= 0) queue[at] = row;
      else queue.push(row);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      persist();
      schedule(200);
      return true;
    },

    /** Forca uma tentativa imediata (botao do painel, e o modo sync). */
    flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
      return flush();
    },

    status() {
      return {
        enabled,
        pending: queue.length,
        sent: stats.sent,
        lastOkAt: stats.lastOkAt,
        lastError: stats.lastError,
        lastErrorAt: stats.lastErrorAt,
      };
    },

    start() {
      if (!enabled) return;
      restore();
      schedule(1000);
    },
  };
}

module.exports = { createSheets };
