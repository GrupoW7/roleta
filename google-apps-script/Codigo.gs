/**
 * Roleta Hello Julia -> Google Sheets
 *
 * Como publicar (uma vez, dentro da planilha que vai receber os dados):
 *   1. Extensoes > Apps Script
 *   2. Apague o conteudo do arquivo Codigo.gs e cole este arquivo
 *   3. Troque SEGREDO pelo mesmo valor que estiver em SHEETS_SECRET no .env
 *   4. Implantar > Nova implantacao > Tipo: App da Web
 *        Executar como: Eu
 *        Quem pode acessar: Qualquer pessoa
 *   5. Copie a URL /exec gerada e coloque em SHEETS_WEBHOOK_URL no .env
 *
 * Toda vez que editar este arquivo, use "Implantar > Gerenciar implantacoes >
 * editar > Nova versao", senao a URL continua servindo a versao antiga.
 *
 * O POST aceita duas acoes:
 *   { secret, rows: [...] }                  grava/atualiza linhas (padrao)
 *   { secret, action: 'read', limit: 20 }    devolve as ultimas linhas (conferencia)
 * A leitura tambem exige o segredo e vai por POST de proposito: o Web App e
 * publico, entao dado de lead nunca pode sair numa URL de navegador.
 */

var SEGREDO = 'troque-por-um-segredo-seu';
var ABA = 'Roleta';

var CABECALHO = [
  'data_hora',
  'dia',
  'nome',
  'whatsapp',
  'segmento',
  'idioma',
  'giro',
  'premio',
  'cupom',
  'ganhou',
  'lead_id',
  'chave',
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return resposta({ ok: false, error: 'planilha ocupada' });
  }

  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (SEGREDO && body.secret !== SEGREDO) {
      return resposta({ ok: false, error: 'unauthorized' });
    }

    var aba = pegarAba();

    if (body.action === 'read') {
      return resposta({ ok: true, rows: ultimasLinhas(aba, body.limit) });
    }

    var linhas = body.rows || (body.row ? [body.row] : []);
    var chaves = indiceDeChaves(aba);
    var gravadas = 0;

    for (var i = 0; i < linhas.length; i++) {
      gravar(aba, chaves, linhas[i]);
      gravadas++;
    }

    return resposta({ ok: true, saved: gravadas });
  } catch (err) {
    return resposta({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Teste rapido no navegador: abrir a URL /exec deve responder ok.
 * Nao devolve dado nenhum de lead - conferencia so pelo POST com segredo.
 */
function doGet() {
  return resposta({ ok: true, service: 'roleta-hello-julia' });
}

/** Ultimas linhas gravadas, como objetos {coluna: valor}, para conferencia. */
function ultimasLinhas(aba, limite) {
  var quantas = Math.min(Math.max(parseInt(limite, 10) || 20, 1), 200);
  var ultima = aba.getLastRow();
  if (ultima < 2) return [];

  var inicio = Math.max(2, ultima - quantas + 1);
  var valores = aba.getRange(inicio, 1, ultima - inicio + 1, CABECALHO.length).getValues();

  return valores.map(function (linha) {
    var obj = {};
    for (var i = 0; i < CABECALHO.length; i++) obj[CABECALHO[i]] = linha[i];
    return obj;
  });
}

function pegarAba() {
  var planilha = SpreadsheetApp.getActiveSpreadsheet();
  var aba = planilha.getSheetByName(ABA);
  if (!aba) aba = planilha.insertSheet(ABA);
  if (aba.getLastRow() === 0) {
    aba.appendRow(CABECALHO);
    aba.getRange(1, 1, 1, CABECALHO.length).setFontWeight('bold');
    aba.setFrozenRows(1);
    // whatsapp e cupom como texto para o Sheets nao comer o "+" nem o zero.
    aba.getRange(2, 4, aba.getMaxRows() - 1, 1).setNumberFormat('@');
    aba.getRange(2, 9, aba.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  return aba;
}

/** Mapa chave -> numero da linha, para atualizar em vez de duplicar. */
function indiceDeChaves(aba) {
  var mapa = {};
  var ultima = aba.getLastRow();
  if (ultima < 2) return mapa;
  var coluna = CABECALHO.indexOf('chave') + 1;
  var valores = aba.getRange(2, coluna, ultima - 1, 1).getValues();
  for (var i = 0; i < valores.length; i++) {
    var chave = String(valores[i][0] || '');
    if (chave) mapa[chave] = i + 2;
  }
  return mapa;
}

function gravar(aba, chaves, linha) {
  var valores = [
    linha.data_hora || '',
    linha.dia || '',
    linha.nome || '',
    linha.whatsapp || '',
    linha.segmento || '',
    linha.idioma || '',
    linha.giro || '',
    linha.premio || '',
    linha.cupom || '',
    linha.ganhou || '',
    linha.lead_id || '',
    linha.chave || '',
  ];

  var existente = chaves[linha.chave];
  if (existente) {
    aba.getRange(existente, 1, 1, valores.length).setValues([valores]);
    return;
  }

  aba.appendRow(valores);
  chaves[linha.chave] = aba.getLastRow();
}

function resposta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
