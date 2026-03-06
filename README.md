# SkillFlow Node 9321

Pasta isolada que copia o chat de `skillflow-llm-chat/index.html`, serve a interface por Node e cria um proxy local para:

- `POST /api/ghost-search` -> `https://api.ghost1.cloud/search`

## Rodar localmente

```bash
npm start
```

Abre em:

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
