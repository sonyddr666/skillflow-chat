# Analise Tecnica Senior - skillflow-chat

Repositorio analisado: `sonyddr666/skillflow-chat`
Commit local analisado: `62e23f4`
Data da leitura: `2026-03-30`

## 1. Resumo executivo

O projeto e um monolito Node.js + frontend estatico que concentra, no mesmo processo, autenticacao local, persistencia em disco, chat com Gemini, proxy para Codex, function calling, execucao remota, manipulacao de arquivos por usuario, TTS, STT e modo Live via WebSocket.

Como prova de conceito funcional, o resultado e acima da media: ha ambicao real de produto, ha varios fluxos completos funcionando, e a base sem dependencias de runtime simplifica deploy e reduz risco de supply chain.

Como base para producao multiusuario, o repositorio ainda esta fragil. O problema central nao e "falta de feature"; e falta de contencao arquitetural. As partes existem, mas estao fortemente acopladas, com responsabilidade demais em poucos arquivos, pouca validacao defensiva em rotas criticas e alguns riscos severos de seguranca.

Veredito senior:

- Muito forte como prototipo operacional.
- Fraco como base de producao exposta.
- Promissor como fundacao de um runtime de agente, desde que a camada de execucao e artifacts seja endurecida e modularizada.

## 2. Estrutura real do projeto

Arquivos principais observados:

- `server.js` - 1767 linhas / 61 KB
- `public/index.html` - 7518 linhas / 371 KB
- `public/account.js` - 312 linhas
- `public/login.html` - 145 linhas
- `public/mobile.css` - 585 linhas
- `.tmp-index-script-check.js` - 5119 linhas / 290 KB
- `package.json` - apenas script `start`
- `Dockerfile` - imagem minima baseada em `node:20-alpine`

Leitura arquitetural direta:

- O backend inteiro mora em um unico arquivo.
- O frontend inteiro do produto mora praticamente em um unico HTML com CSS e JS inline.
- O projeto nao tem pasta `src/`, nao tem separacao entre dominio, servicos, middlewares e rotas.
- Nao ha testes, lint, tipagem estatica nem pipeline de validacao local.

Achado objetivo importante:

- O arquivo temporario `.tmp-index-script-check.js` esta versionado no Git e nao esta coberto pelo `.gitignore`.

Isso nao derruba o sistema, mas mostra baixa higiene de repositorio e aumenta ruido historico e manutencao desnecessaria.

## 3. Arquitetura e organizacao

### 3.1 Estilo arquitetural

O sistema segue um modelo de "monolito intencional":

- Um servidor HTTP puro de Node.
- Sem framework web.
- Sem ORM.
- Sem banco de dados.
- Sem bundler no frontend.
- Persistencia baseada em JSON e arquivos reais no disco.

Essa decisao traz ganhos reais:

- deploy simples
- baixo atrito para rodar
- pouca magia
- dependencia quase zero

Mas os custos ja aparecem com forca:

- crescimento horizontal dificil
- pouca isolacao entre contextos
- risco de regressao alto
- baixa testabilidade
- manutencao concentrada em arquivos gigantes

### 3.2 Contextos que hoje estao colados em `server.js`

O `server.js` mistura pelo menos estes contextos:

1. HTTP e roteamento
2. autenticacao e sessao
3. persistencia de usuarios
4. persistencia de estado
5. CRUD de skills
6. CRUD de system prompts
7. filesystem por usuario
8. runtime de execucao
9. proxy de Ghost Search
10. proxy / parser de Codex SSE
11. entrega de arquivos estaticos

Cada um desses blocos seria razoavel como modulo proprio. No formato atual, qualquer alteracao em `server.js` exige entendimento global do arquivo inteiro.

### 3.3 Organizacao do frontend

O `public/index.html` acumula:

- HTML estrutural
- CSS principal
- registro de plugins
- providers Gemini e Codex
- renderer Markdown
- sistema de conversa
- upload de anexos
- traces de ferramentas
- TTS
- STT
- Gemini Live
- configuracoes e localStorage
- UI de configuracao

Na pratica, ele funciona como:

- `App`
- `Store`
- `Plugin registry`
- `LLM runtime`
- `Voice engine`
- `Filesystem client`
- `Execution client`
- `View layer`

tudo ao mesmo tempo.

Isso acelera o prototipo, mas torna qualquer mudanca um risco sistêmico.

## 4. Fluxo de execucao do sistema

### 4.1 Boot

Fluxo real:

1. `ensureBaseDirs()` cria `skills/`, `workspace/`, `workspace/.system/`, `state/` e `system-prompts/`.
2. `users.json` e inicializado se nao existir.
3. O servidor HTTP sobe em `0.0.0.0:9321`.

Ponto positivo:

- bootstrap simples e previsivel

Risco:

- o processo depende de IO de disco direto desde o boot e em varios caminhos criticos

### 4.2 Autenticacao

Fluxo real:

1. `POST /auth/register` cria usuario e grava em `workspace/.system/users.json`.
2. `POST /auth/login` valida com `scryptSync` + `timingSafeEqual`.
3. `startSession()` cria token e guarda a sessao em `Map` em memoria.
4. Cookie `sf_session` e enviado com `HttpOnly` e `SameSite=Lax`.
5. `GET /auth/me` resolve usuario a partir do cookie.

Pontos positivos:

- senha hasheada corretamente
- comparacao com `timingSafeEqual`
- cookie `HttpOnly`

Fragilidades:

- sessao so existe em memoria
- reinicio do processo invalida tudo
- nao ha `Secure` no cookie
- nao ha rate limit em login
- `loadUsers()` relê o JSON do disco continuamente

### 4.3 Chat Gemini

Fluxo observado no frontend:

1. `send()` coleta texto, anexos e configuracao.
2. Arquivos pendentes sao persistidos primeiro em `/api/fs/write`.
3. O historico e reformatado no shape da API Gemini.
4. `buildTools()` declara tools dinamicamente a partir dos plugins habilitados.
5. A chamada vai direto do navegador para:
   `https://generativelanguage.googleapis.com/...:streamGenerateContent?alt=sse&key=...`
6. O browser consome SSE, renderiza streaming e, se vier `functionCall`, executa tools com `executePlugin()`.
7. As respostas das ferramentas voltam para o modelo de forma recursiva.

Pontos fortes:

- streaming real
- suporte a function calling paralelo
- preservacao de `thoughtSignature` nas partes da Gemini

Problemas:

- a API key do Gemini fica no frontend
- a key vai na query string
- cada tool pode disparar acoes locais, HTTP ou exec
- a recursao esta no mesmo fluxo de UI, sem isolamento

### 4.4 Chat Codex

Fluxo real:

1. `send()` detecta modelo Codex.
2. O frontend monta `input` no formato Responses API.
3. `POST /api/chat` manda auth, historico, tools e instrucoes ao backend.
4. `runCodexChat()` refresca token se preciso, chama a API interna SSE e faz `response.text()`.
5. `parseCodexSsePayload()` reconstrui texto final e tool calls.
6. O frontend executa ferramentas e reenvia o contexto ate concluir.

Ponto forte:

- parser SSE robusto para uma integracao nao trivial

Limitacao importante:

- o backend pede `stream: true`, mas nao faz stream para o frontend
- o usuario recebe a resposta consolidada, nao streaming progressivo

Em UX, isso e pior que o fluxo Gemini.

### 4.5 Filesystem por usuario

Rotas reais:

- `GET /api/fs/list`
- `GET /api/fs/read`
- `GET /api/fs/download`
- `POST /api/fs/write`
- `POST /api/fs/mkdir`
- `POST /api/fs/rename`
- `DELETE /api/fs/delete`

Ponto muito positivo:

- `workspacePath()` protege contra path traversal com `resolve()` + `relative()`

Pontos fracos:

- `read` carrega o arquivo inteiro em memoria
- `delete` remove recursivamente
- nao ha camada de policy alem do escopo do workspace

### 4.6 Runtime de execucao

O runtime de execucao e mais maduro do que o resto aparenta.

O que ja existe:

- `normalizeExecPayload()`
- `generateRunId()`
- `buildExecutionMeta()`
- `createExecution()`
- `persistExecutionMeta()`
- `readExecutionLog()`
- `cancelExecution()`
- `listExecutionHistory()`

Capacidades reais:

- stdout e stderr separados
- logs persistidos em `.runs/<runId>/`
- timeout com `SIGTERM` e fallback para `SIGKILL`
- consulta de status
- cancelamento

Gap principal:

- nao existe contrato nativo de `artifacts[]`
- a execucao persiste logs, mas nao materializa saidas como arquivos oficiais do chat

## 5. Explicacao ampliada dos arquivos principais

### 5.1 `server.js`

#### Papel no sistema

E o nucleo operacional do projeto. Tudo o que for backend passa por ele.

#### Funcoes que mais importam

- `readRequestBody()`:
  simples, mas sem limite de tamanho

- `hashPassword()` e `verifyPassword()`:
  implementacao correta para um sistema caseiro

- `workspacePath()`:
  uma das melhores funcoes do backend; faz validacao real de escopo

- `normalizeExecPayload()`:
  valida formato do payload de execucao, mas nao valida politica do que pode ser executado

- `createExecution()`:
  melhor bloco do backend; gerencia processo filho, logs, timeout e persistencia de meta

- `parseCodexSsePayload()`:
  parser util e relativamente bem pensado para eventos SSE irregulares

- `handleFsApi()`:
  expoe filesystem real por usuario

- `handleExecApi()`:
  expoe runtime de execucao via HTTP

#### Leitura sênior

O backend mostra criterio tecnico em alguns pontos importantes, mas e inconsistente. Em areas sensiveis como senha, path traversal e lifecycle de processo, o codigo esta razoavelmente bom. Em areas igualmente sensiveis como tamanho de payload, politica de execucao, rate limit e tratamento de JSON invalido, ele esta fraco.

### 5.2 `public/index.html`

#### Papel no sistema

E, de fato, a aplicacao principal.

#### Blocos mais importantes

- `readCfg()` / `writeCfg()`
- `requestCodexChat()`
- `buildGeminiToolEntries()` / `buildCodexTools()`
- `executePlugin()`
- `persistPendingAttachments()`
- `send()`
- `callAPI()`
- `callCodexAPI()`
- `ttsSpeakMsg()`
- `startLiveForCurrentModel()`

#### Pontos positivos

- engine de chat funcional
- tools dinamicas
- traces de ferramentas
- fluxo multimodal
- anexos persistidos em workspace
- boa ambicao de UX

#### Problemas severos

- responsabilidades demais
- escopo global enorme
- duplicacoes reais de funcao
- `new Function()` para executar plugins
- armazenamento de credenciais sensiveis em `localStorage`
- integracoes externas e regras de negocio misturadas com DOM

### 5.3 `public/account.js`

Este e o arquivo mais equilibrado do projeto.

Pontos bons:

- IIFE para encapsulamento
- funcoes curtas
- sync com retry e backoff
- `sendBeacon()` em unload/visibilitychange
- compactacao de conversas para reduzir pressao de storage

Observacao:

- o `STATE_KEYS` esta duplicado entre frontend e backend

### 5.4 `public/login.html`

Cumpre bem o papel de entrada do sistema.

Pontos positivos:

- fluxo simples
- UX clara
- redirecionamento se ja autenticado

Limitacao:

- a seguranca real continua toda no backend; o frontend so orquestra

### 5.5 `.tmp-index-script-check.js`

Esse arquivo nao deveria estar versionado.

Sinais tecnicos:

- nome de arquivo temporario
- tamanho maior que varios arquivos principais
- nao ha referencia operacional a ele
- `.gitignore` nao o cobre

Conclusao:

- ruido de repositorio
- sinal de higiene fraca de versionamento

## 6. Qualidade de codigo e padroes usados

### 6.1 Padroes positivos

- nomes de funcoes geralmente descritivos
- boa legibilidade geral apesar do tamanho
- uso correto de `async/await`
- validacao de alguns payloads com funcoes dedicadas
- separacao basica de concerns dentro dos blocos grandes
- `account.js` e um bom exemplo de modulo pequeno e coeso

### 6.2 Anti-padroes e code smells

- god file no backend
- god file no frontend
- ausencia de modulos internos
- ausencia de tipagem
- ausencia de testes
- duplicacao de constantes entre arquivos
- duplicacao literal de funcoes no `index.html`
- execucao dinamica via `new Function()`
- `Function()` no builtin `calculate`
- regras de negocio acopladas a UI
- grande dependencia de `localStorage` como store primario

### 6.3 Consistencia

O projeto e inconsistente em maturidade:

- algumas funcoes parecem prontas para produto
- outras parecem prova de conceito sem endurecimento

Esse contraste e um dos principais riscos de manutencao.

## 7. Falhas, gargalos e riscos tecnicos

## 7.1 Riscos criticos

### RCE pelo endpoint de execucao

`createExecution()` aceita `payload.command`, `payload.args` e `payload.shell`.
Quando `shell` e true, o backend faz `spawn(payload.command, { shell: true })`.

Isso significa que um usuario autenticado consegue pedir execucao arbitraria no host.

Esse e o risco numero 1 do repositorio.

### API key Gemini exposta no navegador

A integracao Gemini e feita diretamente do browser, com a key indo na URL.

Impactos:

- exfiltracao por DevTools
- vazamento em logs/proxies
- impossibilidade de politicas server-side

### Credenciais Codex em `localStorage`

O frontend persiste `codexAuth` e `codexAuthRaw` na configuracao.

Impactos:

- qualquer XSS passa a ser comprometimento de conta externa
- o navegador vira cofre de token

### Payload sem limite

`readRequestBody()` concatena tudo o que chega sem limite.

Impacto:

- DoS por consumo de memoria
- erro de processo por payload grande

## 7.2 Riscos altos

### `fs/read` sem limite de leitura

`GET /api/fs/read` faz `readFile(absolute, "utf8")`.

Impacto:

- um arquivo muito grande pode consumir memoria demais
- o modelo pode requisitar leitura de arquivos inadequados sem protecao

### Sessao em memoria

O `Map sessions` resolve rapido, mas:

- perde sessoes a cada restart
- nao escala horizontalmente
- nao e auditavel

### `saveUserState()` e `saveUsers()` sem lock

O fluxo e do tipo load-modify-save em arquivo JSON.

Impactos:

- corrida entre gravacoes
- perda silenciosa de estado

### System prompts globais

Os prompts ficam em `workspace/.system/system-prompts`, nao por usuario.

Impactos:

- escopo compartilhado entre contas
- risco de edicao cruzada

## 7.3 Gargalos de performance

- `public/index.html` com 371 KB
- sem code split
- sem pipeline de compressao explicita no app
- sem cache inteligente para HTML/CSS/JS
- `loadUsers()` lendo disco repetidamente
- `listExecutionHistory()` lendo `result.json` por run em serie
- anexos ainda vivem parte do tempo em memoria/base64 no frontend

## 8. Seguranca

### 8.1 O que esta bom

- hash de senha com `scryptSync`
- comparacao com `timingSafeEqual`
- isolamento de workspace via `workspacePath()`
- `HttpOnly` no cookie de sessao
- download com `Content-Disposition` controlado

### 8.2 O que esta faltando

- rate limiting
- lockout ou throttling de login
- `Secure` no cookie
- CSP
- HSTS
- `X-Frame-Options`
- `X-Content-Type-Options`
- limite de body
- politicas por ferramenta
- allowlist de execucao
- segregacao segura de credenciais

### 8.3 Observacao sobre CORS

O backend responde JSON com `Access-Control-Allow-Origin: *`.
Como a app e essencialmente same-origin e baseada em cookie, isso e amplo demais e nao agrega valor real ao produto.

Nao e, isoladamente, o maior risco do sistema, mas e um sinal de politica permissiva demais.

## 9. Performance e escalabilidade

### 9.1 Backend

O backend aguenta bem cenario pequeno e controlado.

Vai sofrer quando houver:

- muitos logins por minuto
- muitos estados sendo gravados
- muitas execucoes por usuario
- arquivos grandes
- muitas chamadas simultaneas de listagem/historico

### 9.2 Frontend

O frontend tende a sofrer com:

- tempo de parse de um HTML enorme
- custo de re-render em pagina unica muito carregada
- dependencia de `localStorage`
- risco de regressao por acoplamento entre areas distantes

### 9.3 Escalabilidade de produto

Hoje o sistema esta mais proximo de:

- single host
- poucos usuarios
- uso assistido

do que de:

- SaaS multiusuario
- execucao concorrente pesada
- governanca operacional

## 10. Manutenibilidade

O maior problema de manutencao nao e o estilo "sem framework". O problema e a falta de fronteiras.

Sintomas:

- uma mudanca de auth exige tocar no mesmo arquivo que mexe com exec e Codex
- uma mudanca de TTS divide espaco com tool registry, chat e live mode
- nao ha superficie clara de testes
- nao ha contratos tipados entre frontend e backend

Consequencia:

- onboarding lento
- alto medo de mudar
- maior probabilidade de regressao lateral

## 11. Divida tecnica

### 11.1 Divida estrutural

- `server.js` monolitico
- `index.html` monolitico
- sem `src/`
- sem modulos por dominio

### 11.2 Divida operacional

- sem testes
- sem lint
- sem verificacao automatica
- sem observabilidade real

### 11.3 Divida de seguranca

- execucao arbitraria
- credenciais no cliente
- sem rate limit
- sem headers de seguranca

### 11.4 Divida de consistencia

- `STATE_KEYS` duplicado
- funcoes duplicadas no frontend
- arquivo temporario commitado

## 12. Sugestoes concretas de refatoracao

## 12.1 Prioridade imediata - seguranca

1. Endurecer `/api/exec`

- bloquear `shell: true` por default
- permitir apenas perfis controlados: `python`, `node`, `bash`
- criar allowlist de binarios
- registrar politica por usuario

2. Tirar a Gemini do browser

- criar proxy backend para Gemini
- guardar chave em variavel de ambiente
- fazer streaming server-to-client se quiser manter UX

3. Limitar payload

- `readRequestBody(req, maxBytes)`
- retornar `413` quando exceder

4. Rate limit em auth e exec

- por IP em login
- por usuario em execucao

5. Parar de persistir auth sensivel no cliente

- remover refresh/access token bruto do `localStorage`
- usar sessao server-side ou armazenamento mais restrito

## 12.2 Prioridade alta - confiabilidade

1. Extrair modulos do backend

Estrutura sugerida:

- `src/server.js`
- `src/routes/auth.js`
- `src/routes/chat.js`
- `src/routes/fs.js`
- `src/routes/exec.js`
- `src/services/users.js`
- `src/services/sessions.js`
- `src/services/executions.js`
- `src/services/codex.js`
- `src/lib/http.js`

2. Extrair frontend em modulos

Estrutura sugerida:

- `public/index.html` so com shell
- `public/js/app.js`
- `public/js/chat.js`
- `public/js/providers/gemini.js`
- `public/js/providers/codex.js`
- `public/js/plugins.js`
- `public/js/filesystem.js`
- `public/js/exec.js`
- `public/js/voice/tts.js`
- `public/js/voice/live.js`
- `public/js/store.js`

3. Criar contrato unico de artifacts

Toda tool e toda execucao deveria poder retornar:

```json
{
  "ok": true,
  "summary": "Arquivo gerado com sucesso",
  "artifacts": [
    {
      "path": "outputs/relatorio.csv",
      "name": "relatorio.csv",
      "mimeType": "text/csv",
      "size": 4823
    }
  ]
}
```

Isso encaixa muito bem com o runtime que o projeto ja tem.

## 12.3 Prioridade media - higiene e sustentabilidade

1. Eliminar duplicacoes

- `ttsSpeakMsg`
- `ttsStop`
- `liveSpeak`
- `STATE_KEYS`

2. Remover `.tmp-index-script-check.js` do repositorio e incluir no `.gitignore`

3. Adicionar testes minimos

Casos prioritarios:

- `workspacePath()`
- `normalizeExecPayload()`
- `verifyPassword()`
- `parseCodexSsePayload()`
- `compactConversationState()`

4. Melhorar `fs/read`

- `max_bytes`
- `truncated`
- leitura segura por tipo

5. Persistir sessao em disco ou storage dedicado

## 13. Roadmap recomendado

### Fase 1 - 1 semana

- limitar body
- limitar `fs/read`
- endurecer `/api/exec`
- remover credenciais do cliente onde possivel
- adicionar headers basicos de seguranca

### Fase 2 - 2 semanas

- extrair backend por modulos
- consolidar contrato de artifacts
- adicionar wrappers de execucao tipados

### Fase 3 - 2 a 4 semanas

- modularizar frontend
- separar store, chat, tools e voice
- criar testes de regressao
- adicionar observabilidade minima

## 14. Pontos fortes reais do projeto

Mesmo com as criticas, o projeto tem varios acertos reais:

- ambicao tecnica acima da media
- runtime de execucao ja com lifecycle razoavel
- protecao de path traversal bem feita
- parser SSE do Codex util e maduro
- sync de estado em `account.js` bem resolvido
- UX rica e com varios modos de interacao
- deploy simples por usar quase so Node puro

Esses pontos importam porque mostram que nao se trata de uma base ruim. Trata-se de uma base boa, mas ainda sem os limites necessarios para virar plataforma robusta.

## 15. Conclusao final

O `skillflow-chat` nao parece um chat trivial. Ele ja caminha para algo mais proximo de um "agent workspace", porque combina:

- contexto conversacional
- ferramentas reais
- workspace por usuario
- execucao server-side
- anexos persistidos

O salto que falta nao e de imaginacao de produto. E de engenharia de contencao.

Hoje:

- o sistema funciona
- o prototipo impressiona
- o codigo mostra capacidade tecnica

Mas tambem:

- a superficie de ataque esta aberta demais
- a estrutura esta acoplada demais
- a manutencao ja esta cara

Se eu tivesse que resumir em uma frase:

> A fundacao e promissora, mas antes de crescer em feature, o projeto precisa crescer em fronteiras.

## 16. Prioridades praticas finais

Se houver so tempo para atacar 5 itens, eu faria nesta ordem:

1. travar `/api/exec`
2. mover Gemini para o backend
3. limitar body e leitura de arquivo
4. remover tokens sensiveis do `localStorage`
5. quebrar `server.js` e `index.html` em modulos reais

