'use strict';

/**
 * Mensagem de agradecimento via webhook do agente (z-whitelabel).
 *
 * Dispara DEPOIS que o cadastro e o giro terminam (nao no cadastro sozinho),
 * ou seja: sempre em handleSpin, uma vez por giro concluido.
 *
 * Mesmo padrao do sheets.js: fila em disco, nao trava a resposta do giro por
 * padrao (so espera de verdade no modo `sync`, usado no deploy serverless da
 * Vercel, porque a instancia congela assim que a resposta sai).
 *
 * ATENCAO - formato do payload assumido, nao confirmado com a doc do parceiro:
 *   { nome, whatsapp, segmento, idioma, premio, ganhou, cupom }
 * Ajuste os nomes de campo abaixo se a z-whitelabel esperar outro formato.
 */

const fs = require('fs');

const BATCH = 20;
const TIMEOUT_MS = 15000;
const BACKOFF_MS = [3000, 10000, 30000, 60000, 120000];
const MAX_QUEUE = 5000;

function isSupported(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  } catch (err) {
    return false;
  }
}

function createThankYou(options) {
  const url = String((options && options.url) || '').trim();
  const queueFile = options && options.queueFile;
  const sync = !!(options && options.sync);
  const enabled = isSupported(url);

  let queue = [];
  let sending = false;
  let timer = null;
  let attempt = 0;
  const stats = { sent: 0, lastOkAt: null, lastError: null, lastErrorAt: null };

  function persist() {
    if (!queueFile) return;
    try {
      const body = queue.map((row) => JSON.stringify(row)).join('\n');
      const tmp = `${queueFile}.tmp`;
      fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
      fs.renameSync(tmp, queueFile);
    } catch (err) {
      console.error('[agradecimento] falha ao gravar a fila:', err.message);
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
      if (queue.length) console.log(`  agradecimento: ${queue.length} evento(s) pendente(s) da sessao anterior`);
    } catch (err) {
      console.error('[agradecimento] falha ao ler a fila:', err.message);
    }
  }

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
      // Um evento por chamada: a API espera um payload por requisicao, nao lote.
      for (const evento of batch) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(evento),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }

      queue = queue.slice(batch.length);
      persist();
      stats.sent += batch.length;
      stats.lastOkAt = new Date().toISOString();
      stats.lastError = null;
      attempt = 0;
    } catch (err) {
      stats.lastError = err.message;
      stats.lastErrorAt = new Date().toISOString();
      console.error('[agradecimento] envio falhou:', err.message);
      attempt = Math.min(attempt + 1, BACKOFF_MS.length - 1);
    } finally {
      sending = false;
    }
    schedule(stats.lastError ? BACKOFF_MS[attempt] : 250);
  }

  return {
    enabled,
    sync,

    enqueue(evento) {
      if (!enabled || !evento || !evento.chave) return false;
      const at = queue.findIndex((item) => item.chave === evento.chave);
      if (at >= 0) queue[at] = evento;
      else queue.push(evento);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      persist();
      schedule(200);
      return true;
    },

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

module.exports = { createThankYou };
