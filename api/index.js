'use strict';

/**
 * Adaptador para a Vercel: reaproveita o mesmo servidor http do estande.
 * server.js so chama listen() quando e executado direto, entao aqui basta
 * entregar a requisicao para os handlers dele.
 *
 * Os defaults ficam AQUI e nao no bloco `env` do vercel.json: aquele bloco
 * substitui as variaveis de ambiente do projeto, e era o que impedia
 * SHEETS_WEBHOOK_URL/SHEETS_SECRET (cadastradas no painel) de chegarem na funcao.
 *
 * ATENCAO: na Vercel o estado (cotas do dia, dedup de whatsapp) vive em memoria
 * de cada instancia - serve para demonstracao, nao para o evento de verdade.
 */

// Unico caminho gravavel numa funcao serverless.
if (!process.env.DATA_DIR) process.env.DATA_DIR = '/tmp/roleta';

// O token do painel vem das variaveis de ambiente do projeto na Vercel.
// Sem ele o server.js cai no default dele, que so serve para rodar local.

// A instancia congela quando a resposta sai: o envio para a planilha tem que
// acontecer antes de responder, senao a linha nunca sobe.
process.env.SHEETS_SYNC = '1';

const { server } = require('../server.js');

module.exports = (req, res) => server.emit('request', req, res);
