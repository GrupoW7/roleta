'use strict';

/**
 * Roleta de brindes Hello Julia - servidor do estande.
 *
 * - Serve o front estatico de public/
 * - POST /api/lead   : valida e grava o lead (nome, whatsapp, segmento, aceite LGPD)
 * - POST /api/spin   : sorteia o premio respeitando as cotas do dia e devolve o gomo
 * - GET  /api/config : ordem/cores dos gomos e opcoes de segmento para o front
 * - /api/admin/*     : painel do operador (estoque do dia, export CSV, reset)
 *
 * Cada cadastro/giro tambem sobe para a planilha do Google (veja sheets.js).
 *
 * Sem frameworks e sem dependencias: apenas http/fs/crypto do Node.
 * O sorteio acontece SEMPRE no backend; o front so anima ate o gomo devolvido.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSheets } = require('./sheets.js');
const { createThankYou } = require('./thankyou.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.jsonl');
const DRAWS_FILE = path.join(DATA_DIR, 'draws.jsonl');
const CONFIG_FILE = path.join(ROOT, 'config', 'prizes.json');
const SHEETS_QUEUE_FILE = path.join(DATA_DIR, 'sheets-queue.jsonl');
const THANKYOU_QUEUE_FILE = path.join(DATA_DIR, 'thankyou-queue.jsonl');

/* ------------------------------------------------------------------ */
/* .env loader simples                                                 */
/* ------------------------------------------------------------------ */
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT, 10) || 4400;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'julia-gofest';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const TIMEZONE = process.env.TZ_EVENT || config.timezone || 'America/Sao_Paulo';
const MAX_SPINS = config.maxSpinsPerLead || 2;
const PACING = Object.assign({ enabled: true, buffer: 1 }, config.pacing || {});
const PRIZES = config.prizes;

/**
 * Planilha do Google. Fica desligada enquanto SHEETS_WEBHOOK_URL nao estiver no
 * .env - o estande continua funcionando normalmente com o CSV do painel.
 */
const sheets = createSheets({
  url: process.env.SHEETS_WEBHOOK_URL,
  secret: process.env.SHEETS_SECRET,
  queueFile: SHEETS_QUEUE_FILE,
  // SHEETS_SYNC=1 so na demo serverless (veja api/index.js).
  sync: process.env.SHEETS_SYNC === '1',
});

/** No modo sync a resposta espera a planilha; no estande isso e no-op. */
async function flushSheetsIfSync() {
  if (sheets.sync) await sheets.flushNow();
}

/**
 * Webhook do agente (z-whitelabel) para disparar a mensagem de agradecimento.
 * So dispara depois que cadastro + giro terminam (ver handleSpin). URL default
 * e a combinacao agentIncomingWebhookId=5753 + key fornecidas; pode ser
 * substituida por THANKYOU_WEBHOOK_URL no .env sem tocar no codigo.
 */
const THANKYOU_DEFAULT_URL =
  'https://api.z-whitelabel.com/v1/webhook/agent-incoming-webhook-event/create?agentIncomingWebhookId=5753&key=ef4af34d-2b8d-4e60-8bd2-1caa0cd5e7b9';
const thankYou = createThankYou({
  url: process.env.THANKYOU_WEBHOOK_URL || THANKYOU_DEFAULT_URL,
  queueFile: THANKYOU_QUEUE_FILE,
  sync: process.env.SHEETS_SYNC === '1',
});

async function flushThankYouIfSync() {
  if (thankYou.sync) await thankYou.flushNow();
}

function thankYouRow({ lead, prize, code }) {
  return {
    chave: `${lead.id}#agradecimento`,
    nome: lead.name,
    whatsapp: `+${lead.phone}`,
    segmento: lead.segment,
    idioma: lead.lang,
    premio: prize ? prize.label || prize.id : '',
    ganhou: prize ? (prize.isPrize ? 'sim' : 'nao') : '',
    cupom: code || '',
    lead_id: lead.id,
  };
}
const PRIZE_BY_ID = new Map(PRIZES.map((p) => [p.id, p]));
const WHEEL_ORDER = config.wheelOrder;

for (const id of WHEEL_ORDER) {
  if (!PRIZE_BY_ID.has(id)) throw new Error(`wheelOrder cita premio inexistente: ${id}`);
}
if (WHEEL_ORDER.length !== PRIZES.length) {
  throw new Error('wheelOrder precisa listar todos os premios exatamente uma vez');
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Chave do dia (YYYY-MM-DD) no fuso do evento - e o que faz a cota virar. */
function dayKey(date) {
  return dayFormatter.format(date || new Date());
}

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Segundos desde a meia-noite no fuso do evento. */
function secondsNow() {
  const [h, m, s] = clockFormatter.format(new Date()).split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** "09:00" -> 32400 segundos. Retorna null se o formato for invalido. */
function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 3600 + m * 60;
}

/* ------------------------------------------------------------------ */
/* Estado persistido                                                   */
/* ------------------------------------------------------------------ */
let state = { days: {}, leads: {}, byId: {} };

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = {
      days: parsed.days || {},
      leads: parsed.leads || {},
      byId: parsed.byId || {},
    };
  } catch (err) {
    // Nao derruba o estande por estado corrompido: arquiva e recomeca o dia.
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(STATE_FILE, backup);
    console.error(`[state] arquivo invalido, movido para ${backup}`);
  }
}

const sleepSlot = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepSlot, 0, 0, ms);
}

const LOCK_ERRORS = ['EPERM', 'EACCES', 'EBUSY'];

/**
 * Escrita atomica (tmp + rename) para o estado nunca ficar truncado.
 * No Windows o rename sobre um arquivo existente falha de forma intermitente com
 * EPERM quando antivirus/indexador/sync segura o destino por um instante - por isso
 * a tentativa e repetida antes de desistir.
 */
function writeStateOnce() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(tmp, STATE_FILE);
      return true;
    } catch (err) {
      if (!LOCK_ERRORS.includes(err.code)) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
  return false;
}

let saveScheduled = false;

/**
 * Persiste o estado. NUNCA lanca: uma falha de disco nao pode derrubar o giro do
 * visitante, ja que o sorteio esta na memoria e o registro vai para draws.jsonl.
 * Se falhar, agenda nova tentativa.
 */
function saveState() {
  try {
    if (writeStateOnce()) {
      saveScheduled = false;
      return true;
    }
    console.error('[state] disco ocupado, nova tentativa em instantes');
  } catch (err) {
    console.error('[state] falha ao gravar:', err.message);
  }
  if (!saveScheduled) {
    saveScheduled = true;
    const retry = setTimeout(() => {
      saveScheduled = false;
      saveState();
    }, 500);
    if (retry.unref) retry.unref();
  }
  return false;
}

/** Log de auditoria (append-only). Falha aqui tambem nao derruba o atendimento. */
function appendJsonl(file, obj) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.error(`[${path.basename(file)}] falha ao gravar:`, err.message);
    return false;
  }
}

function today() {
  const key = dayKey();
  if (!state.days[key]) state.days[key] = { counts: {}, spins: 0, leads: 0 };
  const day = state.days[key];
  for (const p of PRIZES) if (typeof day.counts[p.id] !== 'number') day.counts[p.id] = 0;
  return { key, day };
}

/* ------------------------------------------------------------------ */
/* Sorteio                                                            */
/* ------------------------------------------------------------------ */

/** Janela do estande: a do dia (ajustada no painel) ou a padrao da config. */
function dayWindow(day) {
  return (day && day.window) || config.eventWindow || { start: '09:00', end: '17:00' };
}

/**
 * Quanto do dia de evento ja passou (0 = abertura, 1 = fechamento).
 * Antes da abertura fica em 0; depois do fechamento, em 1 - assim, se o estande
 * varar o horario, o que sobrou de cota fica todo liberado.
 */
function eventProgress(day) {
  if (!PACING.enabled) return 1;
  const win = dayWindow(day);
  const start = parseClock(win.start);
  const end = parseClock(win.end);
  if (start === null || end === null || end <= start) return 1;
  return Math.max(0, Math.min(1, (secondsNow() - start) / (end - start)));
}

/**
 * Quantas unidades do premio ja podem ter saido a esta altura do dia.
 * A cota e liberada aos poucos ao longo da janela do evento, com um colchao
 * (`buffer`) disponivel logo na abertura para o estande nao comecar travado.
 * Retorna null para premio ilimitado.
 */
function releasedFor(prize, progress) {
  if (prize.dailyLimit === null || prize.dailyLimit === undefined) return null;
  if (!PACING.enabled) return prize.dailyLimit;
  return Math.min(prize.dailyLimit, Math.floor(prize.dailyLimit * progress) + PACING.buffer);
}

/** Premios que ainda tem cota liberada agora (respeitando exclusoes do re-giro). */
function availablePrizes(day, exclude, progress) {
  return PRIZES.filter((p) => {
    if (exclude && exclude.includes(p.id)) return false;
    const released = releasedFor(p, progress);
    if (released === null) return true;
    return (day.counts[p.id] || 0) < released;
  });
}

/** Sorteio ponderado com aleatoriedade criptografica. */
function weightedPick(pool) {
  const total = pool.reduce((acc, p) => acc + (p.weight > 0 ? p.weight : 0), 0);
  if (total <= 0) return pool[pool.length - 1];
  // randomInt e uniforme; escalamos por 1000 para aceitar pesos fracionados.
  let ticket = crypto.randomInt(0, Math.round(total * 1000)) / 1000;
  for (const p of pool) {
    ticket -= p.weight > 0 ? p.weight : 0;
    if (ticket < 0) return p;
  }
  return pool[pool.length - 1];
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I/O/0/1
function prizeCode() {
  let out = '';
  for (let i = 0; i < 5; i += 1) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return `JU-${out}`;
}

/* ------------------------------------------------------------------ */
/* Validacao do lead                                                   */
/* ------------------------------------------------------------------ */
const LANGS = ['pt', 'en', 'es'];

function normalizePhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function validateLead(body) {
  const errors = [];
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const phone = normalizePhone(body.whatsapp);
  const segment = String(body.segment || '').trim();
  const lang = LANGS.includes(body.lang) ? body.lang : 'pt';

  if (name.length < 2 || name.length > 80) errors.push('name');
  if (phone.length < 8 || phone.length > 15) errors.push('whatsapp');
  if (!segment || segment.length > 40) errors.push('segment');
  if (body.consent !== true) errors.push('consent');

  return { errors, lead: { name, phone, segment, lang } };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch (err) {
        return reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
  });
  return fs.createReadStream(target).pipe(res);
}

/* ------------------------------------------------------------------ */
/* Rotas de API                                                        */
/* ------------------------------------------------------------------ */
function publicConfig() {
  return {
    wheelOrder: WHEEL_ORDER,
    prizes: PRIZES.map((p) => ({
      id: p.id,
      isPrize: !!p.isPrize,
      color: p.color,
      colorDark: p.colorDark,
    })),
    segments: config.segments,
    maxSpinsPerLead: MAX_SPINS,
  };
}

/* ------------------------------------------------------------------ */
/* Planilha do Google                                                  */
/* ------------------------------------------------------------------ */

/**
 * Uma linha por giro, identificada por leadId#giro.
 * O cadastro ja cria a linha do giro 1 (sem premio); o giro completa a mesma
 * linha com premio e cupom. Assim quem cadastra e nao gira nao se perde.
 */
function sheetRow({ lead, spin, at, prize, code }) {
  return {
    chave: `${lead.id}#${spin}`,
    data_hora: at,
    dia: lead.day,
    nome: lead.name,
    whatsapp: `+${lead.phone}`,
    segmento: lead.segment,
    idioma: lead.lang,
    giro: spin,
    premio: prize ? prize.label || prize.id : '',
    cupom: code || '',
    ganhou: prize ? (prize.isPrize ? 'sim' : 'nao') : '',
    lead_id: lead.id,
  };
}

/* ------------------------------------------------------------------ */
/* Token do lead                                                       */
/* ------------------------------------------------------------------ */

/**
 * O cadastro tem que sobreviver a troca de processo entre o /api/lead e o
 * /api/spin: num deploy serverless cada requisicao pode cair numa instancia
 * diferente, e no estande o servidor pode ser reiniciado no meio do atendimento.
 * O token assinado leva os dados do lead com o visitante; o giro so o usa quando
 * nao encontra o lead em memoria (que continua sendo a fonte da verdade).
 *
 * A assinatura impede forjar um lead, mas nao impede reenviar um token antigo
 * com menos giros usados. No estande isso nao vale nada, porque o lead esta em
 * memoria e tem prioridade; num deploy sem estado compartilhado, o limite de
 * giros por pessoa e melhor esforco - por isso a Vercel e so demonstracao.
 */
const LEAD_KEY = crypto.createHmac('sha256', ADMIN_TOKEN).update('lead-token').digest();

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signLead(record) {
  const payload = b64url(JSON.stringify({
    id: record.id,
    day: record.day,
    name: record.name,
    phone: record.phone,
    segment: record.segment,
    lang: record.lang,
    at: record.consentAt,
    allowed: record.spinsAllowed,
    used: record.spinsUsed,
  }));
  const sig = b64url(crypto.createHmac('sha256', LEAD_KEY).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyLeadToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;

  const expected = b64url(crypto.createHmac('sha256', LEAD_KEY).update(payload).digest());
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

/** Recria o lead a partir do token, so para o dia corrente. */
function rehydrateLead(token) {
  const data = verifyLeadToken(token);
  if (!data || data.day !== dayKey()) return null;

  const record = {
    id: data.id,
    day: data.day,
    name: data.name,
    phone: data.phone,
    segment: data.segment,
    lang: data.lang,
    consentAt: data.at,
    spinsAllowed: Math.min(Math.max(1, data.allowed || 1), MAX_SPINS),
    spinsUsed: Math.max(0, data.used || 0),
    draws: [],
  };

  const key = `${record.day}:${record.phone}`;
  state.leads[key] = record;
  state.byId[record.id] = key;
  return record;
}

async function handleLead(req, res) {
  const body = await readBody(req);
  const { errors, lead } = validateLead(body);
  if (errors.length) return sendJson(res, 400, { error: 'validation', fields: errors });

  const { key, day } = today();
  const leadKey = `${key}:${lead.phone}`;
  const existing = state.leads[leadKey];

  if (existing) {
    // Mesmo whatsapp no mesmo dia: devolve a sessao em vez de duplicar o lead.
    return sendJson(res, 200, {
      leadId: existing.id,
      leadToken: signLead(existing),
      spinsLeft: Math.max(0, Math.min(existing.spinsAllowed, MAX_SPINS) - existing.spinsUsed),
      returning: true,
      draws: existing.draws,
    });
  }

  const record = {
    id: crypto.randomUUID(),
    day: key,
    name: lead.name,
    phone: lead.phone,
    segment: lead.segment,
    lang: lead.lang,
    consentAt: new Date().toISOString(),
    spinsAllowed: 1,
    spinsUsed: 0,
    draws: [],
  };

  state.leads[leadKey] = record;
  state.byId[record.id] = leadKey;
  day.leads += 1;
  saveState();
  appendJsonl(LEADS_FILE, {
    id: record.id,
    day: key,
    createdAt: record.consentAt,
    name: record.name,
    whatsapp: record.phone,
    segment: record.segment,
    lang: record.lang,
    consent: true,
  });
  sheets.enqueue(sheetRow({ lead: record, spin: 1, at: record.consentAt }));
  await flushSheetsIfSync();

  return sendJson(res, 201, {
    leadId: record.id,
    leadToken: signLead(record),
    spinsLeft: 1,
    returning: false,
    draws: [],
  });
}

async function handleSpin(req, res) {
  const body = await readBody(req);
  const leadKey = state.byId[String(body.leadId || '')];
  const lead = (leadKey ? state.leads[leadKey] : null) || rehydrateLead(body.leadToken);
  if (!lead) return sendJson(res, 404, { error: 'lead_not_found' });

  const { day } = today();
  if (lead.day !== dayKey()) return sendJson(res, 409, { error: 'stale_day' });
  if (lead.spinsUsed >= lead.spinsAllowed || lead.spinsUsed >= MAX_SPINS) {
    return sendJson(res, 409, { error: 'no_spins_left' });
  }

  // No re-giro, "tente outra vez" sai do bolo para nao prender o visitante em loop.
  const exclude = lead.spinsUsed > 0 ? ['tente_outra_vez'] : [];
  const pool = availablePrizes(day, exclude, eventProgress(day));
  const picked = weightedPick(pool.length ? pool : [PRIZE_BY_ID.get('nao_foi_dessa_vez')]);

  day.counts[picked.id] = (day.counts[picked.id] || 0) + 1;
  day.spins += 1;
  lead.spinsUsed += 1;
  lead.draws.push(picked.id);

  const code = picked.needsCode ? prizeCode() : null;
  if (code) lead.lastCode = code;
  if (picked.id === 'tente_outra_vez' && lead.spinsAllowed < MAX_SPINS) lead.spinsAllowed += 1;

  const at = new Date().toISOString();

  saveState();
  appendJsonl(DRAWS_FILE, {
    at,
    day: lead.day,
    leadId: lead.id,
    name: lead.name,
    whatsapp: lead.phone,
    segment: lead.segment,
    lang: lead.lang,
    prize: picked.id,
    code,
    spin: lead.spinsUsed,
  });
  sheets.enqueue(sheetRow({ lead, spin: lead.spinsUsed, at, prize: picked, code }));
  await flushSheetsIfSync();

  // So dispara o agradecimento quando o visitante nao tiver mais giros (cadastro
  // + giro(s) encerrados de vez) - evita mandar a mensagem no meio de um "tente outra vez".
  const spinsLeftNow = Math.max(0, Math.min(lead.spinsAllowed, MAX_SPINS) - lead.spinsUsed);
  if (spinsLeftNow <= 0) {
    thankYou.enqueue(thankYouRow({ lead, prize: picked, code }));
    await flushThankYouIfSync();
  }

  return sendJson(res, 200, {
    prizeId: picked.id,
    leadToken: signLead(lead),
    segmentIndex: WHEEL_ORDER.indexOf(picked.id),
    isPrize: !!picked.isPrize,
    code,
    spinsLeft: Math.max(0, Math.min(lead.spinsAllowed, MAX_SPINS) - lead.spinsUsed),
  });
}

function adminAuthorized(url, req) {
  const token = url.searchParams.get('token') || req.headers['x-admin-token'];
  return token === ADMIN_TOKEN;
}

function adminStats() {
  const { key, day } = today();
  const progress = eventProgress(day);
  const seconds = secondsNow();
  const pad = (n) => String(n).padStart(2, '0');

  return {
    day: key,
    timezone: TIMEZONE,
    now: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}`,
    window: dayWindow(day),
    pacing: PACING.enabled,
    progress,
    spins: day.spins,
    leads: day.leads,
    sheets: sheets.status(),
    prizes: PRIZES.map((p) => {
      const used = day.counts[p.id] || 0;
      const released = releasedFor(p, progress);
      return {
        id: p.id,
        isPrize: !!p.isPrize,
        dailyLimit: p.dailyLimit,
        used,
        // released: quanto ja pode ter saido a esta altura do dia
        released,
        available: released === null ? null : Math.max(0, released - used),
        left: p.dailyLimit === null ? null : Math.max(0, p.dailyLimit - used),
      };
    }),
  };
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function adminCsv() {
  const header = ['data_hora', 'dia', 'nome', 'whatsapp', 'segmento', 'idioma', 'premio', 'codigo', 'giro'];
  const rows = [header.join(';')];
  if (fs.existsSync(DRAWS_FILE)) {
    for (const line of fs.readFileSync(DRAWS_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const prize = PRIZE_BY_ID.get(d.prize);
        rows.push([d.at, d.day, d.name, `+${d.whatsapp}`, d.segment, d.lang, (prize && prize.label) || d.prize, d.code, d.spin]
          .map(csvCell)
          .join(';'));
      } catch (err) {
        /* ignora linha invalida */
      }
    }
  }
  // BOM para o Excel abrir os acentos corretamente.
  return `\ufeff${rows.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /api/config') return sendJson(res, 200, publicConfig());
    if (route === 'POST /api/lead') return await handleLead(req, res);
    if (route === 'POST /api/spin') return await handleSpin(req, res);

    if (url.pathname.startsWith('/api/admin/')) {
      if (!adminAuthorized(url, req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (route === 'GET /api/admin/stats') return sendJson(res, 200, adminStats());

      if (route === 'POST /api/admin/sheets-flush') {
        await sheets.flushNow();
        return sendJson(res, 200, adminStats());
      }

      if (route === 'GET /api/admin/export.csv') {
        const csv = adminCsv();
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="roleta-julia-${dayKey()}.csv"`,
        });
        return res.end(csv);
      }

      if (route === 'POST /api/admin/reset-day') {
        const { key, day } = today();
        const keepWindow = day.window; // o horario ajustado do estande sobrevive ao reset
        state.days[key] = { counts: {}, spins: 0, leads: 0 };
        if (keepWindow) state.days[key].window = keepWindow;
        for (const leadKey of Object.keys(state.leads)) {
          if (state.leads[leadKey].day === key) {
            delete state.byId[state.leads[leadKey].id];
            delete state.leads[leadKey];
          }
        }
        saveState();
        return sendJson(res, 200, adminStats());
      }

      if (route === 'POST /api/admin/event-window') {
        // O horario do estande costuma mudar no dia: ajustavel sem reiniciar.
        const body = await readBody(req);
        const start = parseClock(body.start);
        const end = parseClock(body.end);
        if (start === null || end === null || end <= start) return sendJson(res, 400, { error: 'validation' });
        const { day } = today();
        day.window = { start: String(body.start).trim(), end: String(body.end).trim() };
        saveState();
        return sendJson(res, 200, adminStats());
      }

      if (route === 'POST /api/admin/set-count') {
        const body = await readBody(req);
        const prize = PRIZE_BY_ID.get(String(body.prizeId));
        const used = parseInt(body.used, 10);
        if (!prize || Number.isNaN(used) || used < 0) return sendJson(res, 400, { error: 'validation' });
        const { day } = today();
        day.counts[prize.id] = used;
        saveState();
        return sendJson(res, 200, adminStats());
      }

      return sendJson(res, 404, { error: 'not_found' });
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const known = ['invalid_json', 'payload_too_large'];
    if (known.includes(err.message)) return sendJson(res, 400, { error: err.message });
    console.error('[erro]', err);
    return sendJson(res, 500, { error: 'internal' });
  }
});

loadState();
sheets.start();
thankYou.start();

if (require.main === module) {
  server.listen(PORT, () => {
    const { key, day } = today();
    console.log('');
    console.log('  Roleta Hello Julia');
    console.log(`  -> roleta:  http://localhost:${PORT}`);
    console.log(`  -> painel:  http://localhost:${PORT}/admin.html`);
    console.log(`  dia ${key} (${TIMEZONE}) | giros hoje: ${day.spins}`);
    console.log(`  planilha: ${sheets.enabled ? 'ligada' : 'desligada (defina SHEETS_WEBHOOK_URL no .env)'}`);
    console.log(`  agradecimento: ${thankYou.enabled ? 'ligado' : 'desligado (defina THANKYOU_WEBHOOK_URL no .env)'}`);
    console.log('');
  });
}

module.exports = { server, config, adminStats, dayKey, PORT };
