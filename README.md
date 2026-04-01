# SkillFlow Node 9321

Projeto isolado que copia o chat de [index.html](/E:/CODEX-testing/chat-lite/skillflow-llm-chat/index.html) para uma stack Node simples, servida por HTTP na porta `9321`.

## Objetivo

- manter o chat funcionando como ja estava
- colocar frontend e backend na mesma origem
- escapar de CORS com rotas internas `/api/*`
- adicionar login local antes do chat
- salvar dados por usuario no servidor

## Como a app funciona

Tudo roda no mesmo servidor:

- site: `http://127.0.0.1:9321/`
- login: `http://127.0.0.1:9321/login`
- health: `http://127.0.0.1:9321/health`
- APIs internas: `http://127.0.0.1:9321/api/*`

O browser continua sendo limitado por CORS. Quando uma API externa nao aceita chamada direta do navegador, o chat usa uma rota interna do backend em vez de fazer `fetch()` direto para fora.

## O que existe agora

### 1. Login local antes do chat

Arquivos principais:

- [login.html](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/login.html)
- [account.js](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/account.js)
- [server.js](/E:/CODEX-testing/chat-lite/skillflow-node-9321/server.js)

Fluxo:

- usuario entra por `/login`
- `POST /auth/register` cria conta local
- `POST /auth/login` abre sessao por cookie
- `GET /auth/me` identifica a conta atual
- `/` so entrega o chat para usuario autenticado

Os dados das contas ficam em:

- [workspace/.system/users.json](/E:/CODEX-testing/chat-lite/skillflow-node-9321/workspace/.system/users.json)

O estado salvo por usuario fica em:

- [workspace/.system/state](/E:/CODEX-testing/chat-lite/skillflow-node-9321/workspace/.system/state)

### 2. Estado do chat salvo por usuario

`account.js` hidrata e sincroniza estes dados:

- configuracoes do modelo e chave
- tema
- conversas
- memoria do usuario
- approvals pendentes
- packs de skill
- preferencias de TTS
- estado visual da sidebar

Tudo isso vai para `POST /api/state` e volta por `GET /api/state`.

### 3. Proxy do Ghost Search

Rota:

- `POST /api/ghost-search`

Fluxo:

- frontend chama `/api/ghost-search`
- backend chama `https://api.ghost1.cloud/search`
- o browser nao fala direto com `api.ghost1.cloud/search`

Isso resolve o problema de CORS para `ghost_search`.

### 4. Skills custom persistidas por usuario

Pasta raiz:

- [skills](/E:/CODEX-testing/chat-lite/skillflow-node-9321/skills)

Cada usuario recebe sua propria subpasta:

- `skills/<user-id>/`

Rotas:

- `GET /api/skills`
- `POST /api/skills`
- `DELETE /api/skills/:id`

Comportamento:

- skills padrao continuam hardcoded no HTML
- skills novas ficam no backend, separadas por usuario
- o frontend mistura skills padrao com as skills custom da conta logada

### 5. Filesystem real por usuario

Pasta raiz:

- [workspace](/E:/CODEX-testing/chat-lite/skillflow-node-9321/workspace)

Cada usuario recebe sua propria subpasta:

- `workspace/<user-id>/`

Rotas:

- `GET /api/fs/list`
- `GET /api/fs/read`
- `POST /api/fs/write`
- `POST /api/fs/mkdir`
- `POST /api/fs/rename`
- `DELETE /api/fs/delete`

Comportamento:

- o chat pode listar, ler, criar, editar, mover e apagar arquivos reais
- tudo fica restrito a pasta do usuario logado
- o backend bloqueia saida para fora dessa raiz

## Estrutura

- [server.js](/E:/CODEX-testing/chat-lite/skillflow-node-9321/server.js): auth, sessao, proxy do Ghost Search, API de state, API de skills e API de filesystem
- [public/index.html](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/index.html): chat principal
- [public/login.html](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/login.html): tela de login e cadastro
- [public/account.js](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/account.js): bootstrap da sessao, hidratacao do estado e sync silencioso
- [skills](/E:/CODEX-testing/chat-lite/skillflow-node-9321/skills): skills custom persistidas em disco por usuario
- [workspace](/E:/CODEX-testing/chat-lite/skillflow-node-9321/workspace): arquivos reais e dados internos
- [Dockerfile](/E:/CODEX-testing/chat-lite/skillflow-node-9321/Dockerfile): imagem para deploy

## Rodar localmente

```bash
cd E:\CODEX-testing\chat-lite\skillflow-node-9321
npm start
```

Abrir:

```text
http://127.0.0.1:9321/login
```

Depois do login:

```text
http://127.0.0.1:9321/
```

## Docker

```bash
docker build -t skillflow-node-9321 .
docker run --rm -p 9321:9321 skillflow-node-9321
```

## Coolify

Para persistir dados entre deploys, monte volume nestas duas pastas:

- `/app/skills`
- `/app/workspace`

Sem isso:

- contas continuam existindo so ate o container ser recriado
- skills custom somem
- arquivos criados pelo chat somem
- estado salvo dos usuarios some

## API resumida

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`

Exemplo de body:

```json
{
  "login": "antonio",
  "password": "1234"
}
```

### Estado do usuario

- `GET /api/state`
- `POST /api/state`

Exemplo:

```json
{
  "state": {
    "gc_theme": "dark",
    "gc_cfg": {
      "model": "gemini-2.5-flash-lite"
    }
  }
}
```

### Ghost Search

`POST /api/ghost-search`

Body exemplo:

```json
{
  "query": "ultimas noticias sobre IA",
  "model": "best",
  "focus": "web",
  "time_range": "all",
  "citation_mode": "markdown"
}
```

### Skills

`GET /api/skills`

`POST /api/skills`

Body exemplo:

```json
{
  "id": "minha_skill",
  "name": "minha_skill",
  "description": "Faz alguma coisa",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "input": { "type": "STRING", "description": "Entrada" }
    },
    "required": ["input"]
  },
  "code": "return { ok: true, echo: args.input };"
}
```

`DELETE /api/skills/minha_skill`

### Filesystem

Listar:

```text
GET /api/fs/list?path=docs
```

Ler:

```text
GET /api/fs/read?path=docs/arquivo.txt
```

Ler com truncamento controlado:

```text
GET /api/fs/read?path=docs/arquivo.txt&max_bytes=32768
```

### Chat jobs persistentes

Criar um job de chat no backend:

```text
POST /api/chat/jobs
```

Exemplo Gemini:

```json
{
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "request": {
    "contents": [
      { "role": "user", "parts": [{ "text": "ola" }] }
    ]
  }
}
```

Consultar status e snapshot:

```text
GET /api/chat/jobs/<job_id>
```

O backend responde com:

- `job.status`: `running`, `completed` ou `failed`
- `raw_sse`: stream bruto salvo do Gemini
- `result`: payload final salvo do Codex
- `job.error`: erro persistido quando o job falha

Escrever:

```json
POST /api/fs/write
{
  "path": "docs/arquivo.txt",
  "content": "ola mundo",
  "create_dirs": true
}
```

Criar pasta:

```json
POST /api/fs/mkdir
{
  "path": "docs/releases"
}
```

Renomear ou mover:

```json
POST /api/fs/rename
{
  "path": "docs/arquivo.txt",
  "next_path": "docs/arquivo-final.txt"
}
```

Apagar:

```text
DELETE /api/fs/delete?path=docs/arquivo-final.txt
```

## Como o LLM deve pensar sobre requests

Regra pratica para tools neste projeto:

- se for consulta externa sujeita a CORS, use rota interna do backend
- se for acessar arquivos reais, use rota interna do backend
- se for skill puramente local, pode rodar no browser

Exemplos:

- usar `ghost_search` por `/api/ghost-search`
- usar tools `server_*` para arquivos
- nao assumir que o browser pode chamar qualquer API externa diretamente

## Limites atuais

- autenticacao e local, sem provedor externo
- sessoes ficam em memoria do processo
- nao existe permissao por papel
- execucao arbitraria foi endurecida por politica basica de comandos permitidos
- operacoes de arquivo ficam restritas a pasta do usuario
- skills custom persistem como JSON, nao como um sistema de plugins distribuido

## Hardening recente

- requests JSON agora possuem limite de tamanho e retornam `413` quando excedem o limite
- bodies JSON invalidos retornam `400` em vez de erro generico
- `GET /api/fs/read` aceita `max_bytes` e retorna `truncated`
- rotas e assets agora enviam headers basicos de seguranca
- login e cadastro possuem rate limit basico em memoria por IP
- o fluxo Gemini REST agora passa pelo backend em `/api/chat`, evitando expor a chave na query string do navegador
- o frontend agora cria `chat jobs` persistentes em `/api/chat/jobs` para nao perder a resposta quando a aba cai no meio

## Gemini pelo backend

Para o fluxo REST normal do Gemini, o backend aceita:

- `GEMINI_API_KEY` no ambiente do servidor
- ou `api_key` enviada pelo cliente como fallback de compatibilidade

Recomendado para deploy:

- definir `GEMINI_API_KEY` no servidor
- evitar depender da chave no navegador

## Respostas persistentes no backend

O fluxo simples implementado agora funciona assim:

1. no clique em enviar, o frontend persiste imediatamente a mensagem do usuario e um placeholder de resposta no `localStorage`
2. depois disso, o frontend cria um job em `POST /api/chat/jobs`
3. o backend continua a chamada ao provider mesmo se a aba sumir
4. o progresso fica salvo em disco por usuario
5. ao voltar, o frontend consulta `GET /api/chat/jobs/:id` e remonta a resposta
6. se a aba cair antes de existir `job_id`, o frontend reconstrói o request salvo e cria o job na retomada

Na pratica, isso resolve dois casos:

- perder a resposta no meio da geracao
- perder a propria mensagem se a aba fechar cedo, antes da criacao do job
- perder a ultima mensagem ao usar duas abas na mesma conversa, porque o `gc_convs` agora faz merge antes de salvar
- deixar a outra aba desatualizada, porque mudancas em `gc_convs` agora rerenderizam a conversa aberta via evento `storage`

Limites desta versao:

- o job e persistente por chamada ao provider, nao por workflow inteiro
- function calling continua sendo orquestrado pelo frontend quando ele volta
- o botao de parar interrompe o acompanhamento local, mas o job no backend pode continuar ate terminar
- a UI recompõe a resposta por polling curto do job; o Gemini agora atualiza a bolha com mais frequencia, mas ainda nao usa SSE reanexavel por `job_id`

## Microfone e camera

Os headers de seguranca do servidor agora permitem microfone e camera para o proprio site (`self`).

Se o navegador ainda mostrar bloqueio, os motivos passam a ser os usuais do browser:

- permissao negada anteriormente para o site
- pagina fora de contexto seguro (`https` ou `localhost`)
- outro app ou aba segurando o dispositivo

## TTS

O pipeline de TTS agora mantem uma janela de prefetch com pelo menos 2 chunks a frente para reduzir o silencio entre geracoes.

Ao clicar em parar, a sessao inteira de TTS e invalidada:

- o audio atual e pausado
- os fetches pendentes dos proximos chunks sao abortados
- URLs temporarias de audio sao revogadas
- respostas atrasadas da sessao anterior deixam de ser aproveitadas

## Execucao no servidor

Por padrao, `/api/exec` aceita apenas comandos em uma allowlist minima:

- `node`
- `npm`
- `npx`
- `python`
- `python3`
- `py`
- `deno`
- `bash`
- `sh`

Por padrao, `shell=true` fica bloqueado.

Variaveis de ambiente:

- `SKILLFLOW_EXEC_ALLOW_SHELL=true` para liberar `shell=true`
- `SKILLFLOW_EXEC_ALLOWED_BINS=node,python,python3,bash` para customizar a allowlist
- `SKILLFLOW_EXEC_ALLOWED_BINS=*` para liberar qualquer binario
