# Roleta Hello Júlia — estande de eventos

Roleta de brindes para o estande: o visitante deixa os dados, gira uma roleta animada
e descobre na hora o que ganhou. Três idiomas (ES padrão, PT e EN) e **as cotas de prêmios
são controladas no backend**, distribuídas ao longo das 8h de evento — o navegador
nunca decide o resultado.

Roda em um tablet **sem depender do wifi do evento**: servidor Node local, zero dependências
(só `http`/`fs`/`crypto`), nenhuma fonte ou CSS de CDN.

## Como rodar

```bash
npm start
```

- Roleta (tela do visitante): <http://localhost:4400>
- Painel do operador: <http://localhost:4400/admin.html>

> **Antes de abrir o estande:** confira o horário do evento no painel do operador.
> O padrão é **09:00–17:00**; se o seu evento for 10:00–18:00, ajuste lá (leva 5 segundos
> e não precisa reiniciar). É esse horário que define o ritmo de liberação dos brindes.

Configuração em `.env` (copie de `.env.example`):

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `PORT` | `4400` | Porta do servidor |
| `ADMIN_TOKEN` | `julia-gofest` | Senha do painel do operador |
| `TZ_EVENT` | `America/Sao_Paulo` | Fuso que define a virada do dia e o relógio do evento |

No tablet: abra o Chrome em tela cheia (modo quiosque) apontando para a porta.
Se o tablet for outro aparelho na mesma rede local, use o IP da máquina que roda
o servidor (`http://192.168.x.x:4400`) — ainda sem precisar de internet.

## Fluxo do visitante

1. **Dados** — nome, DDI + WhatsApp, segmento e aceite LGPD (todos obrigatórios).
   O idioma padrão é o espanhol; o DDI é preenchido conforme o idioma (ES 57, PT 55, EN 1)
   e o visitante pode trocar. O número é gravado completo, com DDI.
2. **Roleta** — toca no centro (`RODAR`), a roleta gira 5 a 7 voltas com som de catraca
   e para no prêmio que o backend sorteou.
3. **Resultado** — prêmio, descrição e um **código de resgate** (`JU-XXXXX`) para mostrar
   à equipe. Volta sozinho para o início após 45s de inatividade, ou no botão
   "Nova participação".

Se sair **Tente outra vez**, o visitante ganha 1 giro extra — e nesse giro extra
"tente outra vez" sai do sorteio, para ninguém ficar em loop. Máximo de 2 giros por pessoa
por dia (`maxSpinsPerLead` em `config/prizes.json`).

O mesmo WhatsApp no mesmo dia **não gera lead duplicado**: o servidor devolve a sessão
que já existia, com os giros que ainda restam.

## Cotas e ritmo do dia

Em `config/prizes.json`:

| Prêmio | Cota/dia | Peso | Ritmo em 8h |
| --- | --- | --- | --- |
| 1 mês grátis de assinatura | 10 | 14 | ~1 a cada 48 min |
| Teste grátis da Júlia com setup | 10 | 14 | ~1 a cada 48 min |
| 10% no plano anual | 10 | 14 | ~1 a cada 48 min |
| Tente outra vez | 20 | 24 | ~1 a cada 24 min |
| Não foi dessa vez | ilimitado | 34 | — |

São 5 gomos: 42% de chance de sair um prêmio de verdade, 24% de rodada extra e
34% de "não foi dessa vez". A roleta lê a quantidade de gomos de `wheelOrder` —
tirar ou acrescentar um prêmio na config já muda o desenho, sem mexer no front.

**A cota não fica toda disponível na abertura.** Sem isso, os 30 brindes sairiam na
primeira hora e as 7 horas seguintes seriam só "não foi dessa vez". O servidor libera
a cota proporcionalmente ao tempo decorrido da janela do evento:

```
liberado = min(cota, floor(cota × progresso_do_dia) + buffer)
```

- `progresso_do_dia` = quanto já passou entre a abertura e o fechamento (0 a 1)
- `buffer` (padrão 1) = quantos já ficam disponíveis na abertura, para o estande não
  começar travado
- antes da abertura o progresso é 0; **depois do fechamento é 1**, então o que sobrou
  de cota fica todo liberado se o estande varar o horário

Regras do sorteio, na ordem:

1. entram no bolo só os prêmios com **cota já liberada** e ainda não consumida;
2. entre eles, sorteio ponderado com `crypto.randomInt` (aleatoriedade criptográfica);
3. prêmio sem cota liberada no momento sai do bolo, e o peso é redistribuído;
4. "Não foi dessa vez" é ilimitado, então absorve o excedente — em horário de pico
   a proporção de "não foi dessa vez" sobe naturalmente, e volta a cair quando a
   próxima leva é liberada.

Para brindes mais fáceis no começo, aumente o `buffer`. Para desligar a distribuição
e liberar tudo desde a abertura, use `"pacing": { "enabled": false }`.

A virada do dia usa `TZ_EVENT`, não o fuso do sistema — evento de vários dias funciona
sem ninguém precisar zerar nada na virada da meia-noite.

## Painel do operador (`/admin.html`)

- **Janela do evento** editável no dia (início e fim), com barra de progresso do dia
- **Liberado**: quanto de cada prêmio já pode ter saído a esta altura. Fica em âmbar
  quando o prêmio está sendo segurado até a próxima liberação
- Quanto já saiu e quanto resta de cada prêmio, atualizado a cada 10s
- Total de leads e de giros do dia
- **Ajuste manual**: corrige quantos já saíram (ex.: acabou o estoque físico do brinde
  antes da cota — coloque o número da cota e ele para de sair)
- **Exportar CSV** com todos os leads e prêmios (abre direto no Excel, com acentos)
- **Planilha do Google**: quantas linhas já subiram, quantas estão na fila e o último
  erro, com o botão **Reenviar para a planilha**
- **Zerar o dia** para testes antes de abrir o estande (o horário ajustado é preservado)

## Planilha do Google

Cada cadastro e cada giro sobem para uma planilha do Google, com o cupom de quem
ganhou. O servidor não fala com a API do Google: ele faz POST num **Web App do
Apps Script publicado dentro da própria planilha**, então não há service account,
chave privada nem dependência para instalar.

### Publicar o Web App (uma vez)

1. Abra a planilha → **Extensões → Apps Script**
2. Apague o conteúdo de `Codigo.gs` e cole o arquivo `google-apps-script/Codigo.gs`
3. Troque a constante `SEGREDO` por um valor seu (o mesmo que vai no `.env`)
4. **Implantar → Nova implantação → Tipo: App da Web**
   - *Executar como*: **Eu**
   - *Quem pode acessar*: **Qualquer pessoa**
5. Copie a URL terminada em `/exec` e preencha o `.env`:

```
SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfy.../exec
SHEETS_SECRET=o-mesmo-valor-de-SEGREDO
```

Reinicie o servidor: o log de abertura mostra `planilha: ligada`. Abrir a URL
`/exec` no navegador deve responder `{"ok":true,...}` — se responder HTML de login,
a implantação não está como "Qualquer pessoa".

Sem `SHEETS_WEBHOOK_URL` o envio fica desligado e o estande roda normalmente só
com o CSV do painel.

> Ao editar o Apps Script depois, use **Implantar → Gerenciar implantações → editar
> → Nova versão**, senão a URL continua servindo a versão antiga.

### Como as linhas ficam

Aba `Roleta`, uma linha por giro:

| data_hora | dia | nome | whatsapp | segmento | idioma | giro | premio | cupom | ganhou | lead_id | chave |
|---|---|---|---|---|---|---|---|---|---|---|---|

- O **cadastro** já cria a linha do giro 1, com `premio` e `cupom` vazios — quem
  preenche o formulário e desiste de girar não se perde.
- O **giro** completa a mesma linha (prêmio por extenso, cupom, `ganhou` = sim/não).
  O "tente outra vez" gera uma segunda linha (`giro` = 2).
- `chave` é `leadId#giro`: reenviar a mesma chave **atualiza** a linha, nunca duplica.
  É o que torna o reenvio seguro depois de uma queda de internet.

### Conferir o que subiu

```bash
npm run planilha
```

Mostra as últimas 20 linhas da planilha no terminal (`npm run planilha -- 50` para
mais). Útil para conferir no meio do evento sem sair da tela do estande.

A leitura vai por **POST com o segredo**, nunca por URL: o Web App é público, então
dado de lead não pode trafegar numa query string de navegador. Abrir a URL `/exec`
no navegador continua respondendo só `{"ok":true,...}`, sem nenhum dado.

### Se o wi-fi do evento cair

O envio é assíncrono — a roleta **nunca** espera a planilha para responder o giro.
Falhou? A linha fica em `data/sheets-queue.jsonl` e sobe sozinha quando a conexão
volta (backoff de 3s até 2min), inclusive depois de reiniciar o servidor. O painel
mostra quantas linhas estão na fila e o último erro, com o botão **Reenviar para a
planilha** para forçar a tentativa.

## Deploy na Vercel (só demonstração)

> **O evento roda no tablet local, não na Vercel.** Lá o filesystem é efêmero e cada
> requisição pode cair numa instância diferente: a cota diária deixa de valer (cada
> instância conta a sua) e o estande entregaria mais brindes do que existe de estoque.
> A versão hospedada serve para mostrar a roleta, testar no celular e validar o visual.

O projeto já está ligado ao projeto `roleta-gofest` da Vercel (`.vercel/project.json`):

```bash
npx vercel@latest login
```

```bash
npx vercel@latest deploy --prod
```

O que já está configurado:

- `api/index.js` — adaptador que entrega as requisições ao mesmo `server.js`
- `vercel.json` — roteia tudo para a função e define `DATA_DIR=/tmp/roleta`,
  `TZ_EVENT`; o `ADMIN_TOKEN` da demo fica nas variáveis de ambiente do projeto
- `.vercelignore` — impede que `.env`, `data/`, testes e o Apps Script subam.
  Sem `SHEETS_WEBHOOK_URL` lá, **a demo não escreve na planilha de produção**

Para ligar a planilha na demo também, use `npx vercel@latest env add SHEETS_WEBHOOK_URL`
e `SHEETS_SECRET` — lembrando que aí os testes de quem abrir o link viram linhas na planilha.

## Robustez no estande

- **Falha de disco não derruba o giro.** No Windows, o `rename` do arquivo de estado
  falha de forma intermitente com `EPERM` quando antivírus/indexador/OneDrive seguram
  o arquivo (a pasta fica dentro de `Documents`). O servidor tenta de novo com backoff,
  e se ainda assim falhar, registra o erro e reagenda — o visitante recebe o prêmio
  normalmente, porque o sorteio já está em memória e no `draws.jsonl`.
- **Tela bloqueada no meio do giro** não trava a roleta: um watchdog conclui a animação
  e mostra o resultado mesmo se o navegador congelar o `requestAnimationFrame`.
- **Estado corrompido** (queda de energia no meio da gravação) é arquivado como
  `state.json.corrupt-*` e o dia recomeça, em vez de impedir o servidor de subir.

## Dados gravados

`data/` (criado na primeira execução, fora do git):

- `leads.jsonl` — um lead por linha, com o aceite LGPD e o horário do consentimento
- `draws.jsonl` — um giro por linha (prêmio, código, idioma, segmento) — é a fonte do CSV
- `state.json` — cotas do dia, janela do evento e sessões; escrito de forma atômica
- `sheets-queue.jsonl` — linhas ainda não confirmadas pela planilha do Google

Antes do evento, rode o teste e depois limpe a pasta `data/` para começar zerado.

## Teste

```bash
npm test
```

Sobe o servidor num diretório temporário e verifica cotas, deduplicação de lead,
giro extra do "tente outra vez", validação do aceite LGPD, se o gomo devolvido
corresponde ao prêmio sorteado e a liberação progressiva em três momentos do dia
(abertura, metade e após o fechamento), manipulando a janela do evento em vez do relógio.

Também sobe um mock do Apps Script para verificar o envio à planilha: cadastro e giro
na mesma linha, cupom só para quem ganhou, e a fila segurando as linhas enquanto a
planilha está fora do ar.

## Estrutura

```
server.js              backend (API + arquivos estáticos)
sheets.js              envio para a planilha do Google (fila + retentativa)
api/index.js           adaptador da Vercel (demo hospedada)
vercel.json            build e variaveis da demo na Vercel
tools/planilha.js      conferência das últimas linhas da planilha no terminal
google-apps-script/    Codigo.gs para colar no Apps Script da planilha
config/prizes.json     cotas, pesos, janela do evento, cores e ordem dos gomos
public/index.html      tela do visitante
public/app.js          fluxo, roleta em SVG, animação, confete e som
public/i18n.js         textos ES / PT / EN (o primeiro é o padrão)
public/styles.css      identidade da Júlia (violeta + ciano, dark premium)
public/admin.html      painel do operador
test/smoke.js          teste do backend
test/sheets.js         teste do envio para a planilha
```

## Personalizar

- **Trocar prêmio, cota ou cor**: `config/prizes.json`. Mexer em `wheelOrder` muda a ordem
  dos gomos — o front lê a config, então não há nada duplicado no código.
- **Horário do evento**: `eventWindow` na config define o padrão; o painel sobrescreve
  para o dia corrente sem reiniciar o servidor.
- **Trocar texto ou adicionar idioma**: `public/i18n.js` (cada prêmio tem `wheel` para o
  gomo, `title` e `desc` para o resultado). Um idioma novo só precisa ser adicionado ao
  objeto `I18N` — o seletor de idioma se monta a partir das chaves dele.
- **Ajustar duração do giro / tempo de reset**: `SPIN_MS` e `IDLE_RESET_S` em `public/app.js`.
