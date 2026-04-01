# SkillFlow Chat - Roadmap para Backend-First Completo

## Objetivo

Este documento descreve a futura feature de transformar o SkillFlow Chat em um sistema realmente backend-first, onde o frontend deixa de orquestrar o fluxo de tools e passa a ser apenas interface de visualizacao, acompanhamento e controle.

Hoje o projeto ja avancou bastante em persistencia de resposta e jobs de chat no backend, mas o loop completo de tool calling ainda depende do cliente.

Em resumo:

- hoje: backend executa chamadas reais e persiste jobs, frontend orquestra a tarefa
- alvo: backend executa chamadas reais, orquestra tools, valida o resultado final e expõe so o estado da tarefa para o frontend

---

## Estado Atual

### O que ja esta no backend

- `POST /api/chat/jobs`
  - cria jobs persistentes de chat
- `GET /api/chat/jobs/:id`
  - devolve snapshot do job
- Gemini/Codex
  - chamados pelo backend
- Filesystem e workspace
  - executados pelo backend
- `exec`
  - executado pelo backend
- persistencia de estado e resposta
  - feita no backend

### O que ainda esta no frontend

- detectar `functionCall`
- chamar `executePlugin(...)`
- transformar retorno de tool em `functionResponse`
- reinjetar a resposta no modelo
- decidir se precisa de mais uma rodada
- encerrar a tarefa

Esse ponto e a limitacao central atual.

---

## Problema Atual

Mesmo com jobs persistentes no backend, o sistema ainda nao trata uma solicitacao como workflow fechado de ponta a ponta.

Exemplo real:

1. usuario pede para apagar varios arquivos
2. modelo chama tool de listagem
3. modelo chama delete varias vezes
4. frontend executa esse encadeamento
5. modelo responde

Isso funciona em muitos casos, mas tem fragilidades:

- a tarefa pode terminar cedo demais
- a verificacao final pode nao acontecer
- a resposta pode resumir antes de confirmar o estado real
- se o frontend cair num momento ruim, o workflow pode ficar incompleto
- o sistema nao tem uma nocao forte de "plano", "etapa", "conclusao validada"

Em outras palavras:

- `status=200` da tool significa que a chamada funcionou
- mas nao significa necessariamente que a intencao inteira do usuario foi concluida e confirmada

---

## Meta da Feature

Passar todo o loop de trabalho para o backend.

O frontend deve ficar responsavel apenas por:

- enviar pedido do usuario
- acompanhar o andamento do job
- mostrar texto parcial/final
- mostrar ferramentas usadas
- mostrar artefatos
- permitir cancelar, retomar ou reinspecionar

O backend deve ficar responsavel por:

- chamar o modelo
- detectar tool calls
- executar tools
- registrar cada etapa
- decidir se o modelo precisa de nova rodada
- validar o estado final quando necessario
- produzir a resposta final consolidada

---

## Arquitetura Alvo

### Fluxo desejado

1. frontend envia `POST /api/chat/jobs`
2. backend cria `job_id`
3. backend roda o modelo
4. backend recebe `tool_call`
5. backend executa a tool
6. backend registra `tool_result`
7. backend devolve o resultado da tool ao modelo
8. backend continua o loop quantas vezes forem necessarias
9. backend produz resposta final
10. frontend apenas acompanha o job por polling ou stream

### Diferenca pratica

Hoje:

```text
Frontend -> Modelo -> Frontend executa tool -> Frontend chama modelo de novo
```

Alvo:

```text
Frontend -> Backend job -> Backend chama modelo -> Backend executa tool -> Backend chama modelo -> Backend conclui
```

---

## Componentes Necessarios

### 1. Executor de Workflow no Backend

Criar um executor central para jobs conversacionais.

Responsabilidades:

- manter `job_id`
- manter `step_id`
- controlar profundidade e limites
- serializar historico do workflow
- impedir loops infinitos
- centralizar erros

Estrutura minima:

- `pending`
- `running`
- `waiting_tool`
- `resuming_model`
- `completed`
- `failed`
- `cancelled`

### 2. Registro Estruturado de Etapas

Cada job precisa gravar etapas com estrutura clara.

Exemplo:

```json
{
  "step_id": "step_07",
  "type": "tool_call",
  "tool": "server_delete_path",
  "input": { "path": "uploads/2026-03/imagens/a.png" },
  "started_at": "2026-03-31T22:00:00Z",
  "finished_at": "2026-03-31T22:00:01Z",
  "status": "completed",
  "result": { "ok": true, "status": 200 }
}
```

Isso resolve:

- auditoria
- replay
- debug
- renderizacao rica no frontend

### 3. Runtime de Tools no Backend

As tools precisam deixar de ser dependentes do loop do frontend.

Backend precisa conhecer:

- nome da tool
- schema de entrada
- executor real
- timeout
- politica de erro
- se a tool pode rodar em lote

Idealmente cada tool built-in deve virar um executor backend registrado.

Exemplos:

- `server_list_files`
- `server_read_file`
- `server_write_file`
- `server_delete_path`
- `server_exec`
- `server_attach_artifact`

### 4. Loop de Tool Calling no Backend

Pseudo-fluxo:

```js
while (job.notFinished) {
  const modelResult = await callModel(context);

  if (!modelResult.toolCalls.length) {
    job.final = modelResult.text;
    break;
  }

  for (const toolCall of modelResult.toolCalls) {
    const toolResult = await runTool(toolCall);
    context.push(toolResult);
    job.steps.push(toolResult);
  }
}
```

### 5. Validacao Final de Tarefa

Esse e um ponto importante para casos como "apaga todos esses arquivos".

Nao basta executar deletes.

O backend precisa permitir um passo final de verificacao, por exemplo:

- listar novamente a pasta
- confirmar que os arquivos sumiram
- registrar a prova no job

Isso pode ser:

- forçado por tipo de task
- sugerido pelo modelo
- ou aplicado por politica em tools destrutivas

---

## Modelo de Dados Proposto

### Job

```json
{
  "id": "job_123",
  "type": "chat_workflow",
  "provider": "gemini",
  "status": "running",
  "created_at": "...",
  "updated_at": "...",
  "finished_at": null,
  "user_id": "user_1",
  "conversation_id": "conv_1",
  "message_id": "msg_9",
  "steps": [],
  "final_text": "",
  "final_artifacts": [],
  "error": null
}
```

### Step

Tipos sugeridos:

- `thinking`
- `model_output`
- `tool_call`
- `tool_result`
- `verification`
- `final`
- `error`

---

## API Proposta

### Criar job

`POST /api/chat/jobs`

Entrada:

```json
{
  "provider": "gemini",
  "conversation_id": "conv_1",
  "message_id": "msg_9",
  "messages": [...]
}
```

### Snapshot do job

`GET /api/chat/jobs/:id`

Saida:

```json
{
  "job": {
    "id": "job_123",
    "status": "running"
  },
  "steps": [...],
  "final_text": "",
  "artifacts": []
}
```

### Stream do job

Futuro ideal:

`GET /api/chat/jobs/:id/stream`

Uso:

- texto parcial
- etapas do workflow
- status online do job
- anexos/artifacts assim que surgirem

### Cancelar job

`POST /api/chat/jobs/:id/cancel`

### Reexecutar job

`POST /api/chat/jobs/:id/retry`

---

## Mudancas no Frontend

Quando essa feature estiver completa, o frontend deve simplificar muito.

### Sai do frontend

- loop de function calling
- execucao direta de tools do workflow principal
- continuidade manual do modelo apos resultado de tool

### Fica no frontend

- enviar mensagem
- renderizar texto parcial
- renderizar etapas
- renderizar artifacts
- polling/stream do job
- cancelamento
- retomada visual

### Beneficios

- menos logica critica no cliente
- menos chance de perder workflow ao fechar aba
- mais previsibilidade
- mais consistencia entre abas
- mais facilidade para debug

---

## Roadmap Sugerido

### Fase 1 - Backend executa o loop principal

- mover o loop Gemini/Codex de tool calling para o backend
- persistir `steps[]`
- manter frontend apenas como viewer

### Fase 2 - Tools backend registradas

- catalogar todas as tools existentes
- criar camada de registro/execucao no backend
- unificar formato de entrada/saida

### Fase 3 - Verificacao final e politicas

- adicionar validacao final para tarefas destrutivas
- adicionar limites por profundidade e por quantidade de tools
- adicionar timeout global de workflow

### Fase 4 - Stream reanexavel

- expor SSE/WebSocket por `job_id`
- frontend volta a mostrar texto se formando ao vivo
- retoma stream apos recarregar

---

## Riscos e Cuidados

### 1. Loops infinitos

Backend-first sem limite vira risco operacional.

Necessario:

- max steps por job
- max tool calls por rodada
- max profundidade

### 2. Tarefas destrutivas

Deletes, rename, exec e escrita em massa exigem:

- politica clara
- verificacao final
- logs fortes

### 3. Custo e latencia

Mais rodadas no backend significam:

- mais custo de provider
- jobs mais longos
- necessidade de timeout

### 4. Observabilidade

Sem logs estruturados, backend-first vira caixa-preta.

Por isso `steps[]` e snapshots sao obrigatorios.

---

## Beneficio Esperado

Quando essa feature estiver pronta, o sistema passa de:

- "chat com tools fortes"

para:

- "runtime de tarefa com interface de chat"

Esse e o salto real de maturidade.

O ganho mais importante nao e apenas tecnico; e comportamental:

- o sistema deixa de "tentar responder"
- e passa a "executar, verificar e depois responder"

---

## Resumo Executivo

Hoje o SkillFlow Chat ja possui:

- backend com jobs persistentes
- backend com execucao real de filesystem/exec
- frontend com rastreio de tools

Mas ainda falta:

- orquestracao completa do workflow no backend
- verificacao final obrigatoria por tarefa
- stream reanexavel do job

Essa feature futura deve transformar o backend no executor oficial do workflow inteiro, deixando o frontend apenas como camada de visualizacao e controle.

