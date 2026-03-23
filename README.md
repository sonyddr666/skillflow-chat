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
- nao existe sandbox de execucao arbitraria no servidor
- operacoes de arquivo ficam restritas a pasta do usuario
- skills custom persistem como JSON, nao como um sistema de plugins distribuido
