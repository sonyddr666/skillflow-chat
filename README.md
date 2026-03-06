# SkillFlow Node 9321

Projeto isolado que copia o chat de [index.html](/E:/CODEX-testing/chat-lite/skillflow-llm-chat/index.html) para uma stack simples em Node, servida na porta `9321`.

Objetivo:

- expor o chat por HTTP em vez de `file://`
- colocar frontend e backend na mesma origem
- escapar de CORS usando rotas internas `/api/*`
- permitir que o chat use function calling com mais liberdade
- persistir skills custom e arquivos reais no deploy

## Como funciona

Tudo roda no mesmo servidor e na mesma porta:

- site: `http://127.0.0.1:9321/`
- health: `http://127.0.0.1:9321/health`
- proxy/search/filesystem/skills: `http://127.0.0.1:9321/api/*`

Isso importa porque o browser não consegue chamar qualquer API externa livremente. Quando uma API externa bloqueia CORS, o chat deve usar a rota interna do backend em vez de fazer `fetch()` direto para fora.

Em outras palavras:

- browser: limitado por CORS
- backend local: livre para chamar APIs externas e escrever no disco
- tools/skills do chat: devem preferir rotas internas `/api/*` quando precisarem de request externo ou acesso real ao servidor

## O que já existe

### 1. Chat servido por Node

O arquivo principal da interface está em:

- [public/index.html](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/index.html)

### 2. Proxy do Ghost Search

Rota:

- `POST /api/ghost-search`

Fluxo:

- frontend chama `/api/ghost-search`
- backend chama `https://api.ghost1.cloud/search`
- o browser nunca fala direto com `api.ghost1.cloud/search`

Isso resolve o problema de CORS para `ghost_search`.

### 3. Skills custom persistidas em disco

Pasta:

- [skills](/E:/CODEX-testing/chat-lite/skillflow-node-9321/skills)

Rotas:

- `GET /api/skills`
- `POST /api/skills`
- `DELETE /api/skills/:id`

Comportamento:

- skills padrão continuam hardcoded no HTML
- skills novas/custom são gravadas como `.json` em `./skills`
- na inicialização, o frontend mistura:
  - skills padrão
  - skills custom vindas do backend

### 4. Filesystem real para o chat

Pasta:

- [workspace](/E:/CODEX-testing/chat-lite/skillflow-node-9321/workspace)

Rotas:

- `GET /api/fs/list`
- `GET /api/fs/read`
- `POST /api/fs/write`
- `POST /api/fs/mkdir`
- `POST /api/fs/rename`
- `DELETE /api/fs/delete`

Comportamento:

- o chat pode listar, ler, criar, editar, mover e apagar arquivos reais
- tudo fica restrito à pasta `./workspace`
- o backend bloqueia saída para fora dessa raiz

## Estrutura

- [server.js](/E:/CODEX-testing/chat-lite/skillflow-node-9321/server.js): servidor HTTP, proxy do Ghost Search, API de skills e API de filesystem
- [public/index.html](/E:/CODEX-testing/chat-lite/skillflow-node-9321/public/index.html): cópia adaptada do chat original
- [skills](/E:/CODEX-testing/chat-lite/skillflow-node-9321/skills): skills custom persistidas em disco
- [workspace](/E:/CODEX-testing/chat-lite/skillflow-node-9321/workspace): arquivos reais manipulados pelo chat
- [Dockerfile](/E:/CODEX-testing/chat-lite/skillflow-node-9321/Dockerfile): imagem para deploy

## Rodar localmente

```bash
cd E:\CODEX-testing\chat-lite\skillflow-node-9321
npm start
```

Abrir:

```text
http://127.0.0.1:9321
```

Health:

```text
http://127.0.0.1:9321/health
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

- skills custom somem ao recriar o container
- arquivos criados/editados pelo chat também somem

## API resumida

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

Regra prática para tools neste projeto:

- se for consulta externa sujeita a CORS, use rota interna do backend
- se for acessar arquivos reais, use rota interna do backend
- se for skill padrão puramente local, pode rodar no browser

Exemplos:

- usar `ghost_search` pela rota interna `/api/ghost-search`
- usar tools `server_*` para arquivos
- não assumir que o browser pode chamar qualquer API externa diretamente

## Limites atuais

- não existe autenticação
- não existe controle de permissão por usuário
- não existe sandbox de execução arbitrária no servidor
- as operações de arquivo ficam restritas à pasta `./workspace`
- skills custom persistem como JSON, não como código distribuído em múltiplos arquivos

## O que esta base já resolve

- CORS do `ghost_search`
- chat servido por HTTP
- custom skills persistidas em disco
- arquivos reais manipuláveis pelo chat
- caminho claro para function calling usar backend interno quando precisar de mais liberdade
