import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 9321);
const HOST = "0.0.0.0";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const skillsRootDir = join(__dirname, "skills");
const workspaceRootDir = join(__dirname, "workspace");
const systemDir = join(workspaceRootDir, ".system");
const usersFile = join(systemDir, "users.json");
const userStateDir = join(systemDir, "state");
const sessions = new Map();
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_OAUTH_CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_REASONING = "medium";
const DEFAULT_CODEX_HISTORY_LIMIT = 40;
const DEFAULT_CODEX_INSTRUCTIONS = process.env.SKILLFLOW_CODEX_DEFAULT_INSTRUCTIONS
  || "Responda em portugues do Brasil e mantenha continuidade com base na conversa.";
const CODEX_FAKE_RESPONSES = false;

const STATE_KEYS = [
  "gc_cfg",
  "gc_theme",
  "gc_plugins",
  "gc_convs",
  "gc_user_memory",
  "gc_pending_approvals",
  "gc_skill_packs",
  "gc_tts_voice",
  "gc_tts_autoplay",
  "gc_sb_collapsed"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, item) => {
    const [k, ...rest] = item.trim().split("=");
    if (!k) return acc;
    acc[k] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function sessionCookie(token) {
  return `sf_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return "sf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || "").split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
}

async function ensureBaseDirs() {
  await mkdir(skillsRootDir, { recursive: true });
  await mkdir(workspaceRootDir, { recursive: true });
  await mkdir(systemDir, { recursive: true });
  await mkdir(userStateDir, { recursive: true });
  if (!existsSync(usersFile)) {
    await writeFile(usersFile, "[]\n", "utf8");
  }
}

async function loadUsers() {
  await ensureBaseDirs();
  try {
    return JSON.parse(await readFile(usersFile, "utf8"));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  await ensureBaseDirs();
  await writeFile(usersFile, `${JSON.stringify(users, null, 2)}\n`, "utf8");
}

function userSkillsDir(user) {
  return join(skillsRootDir, user.id);
}

function userWorkspaceDir(user) {
  return join(workspaceRootDir, user.id);
}

function userStateFile(user) {
  return join(userStateDir, `${user.id}.json`);
}

async function ensureUserDirs(user) {
  await ensureBaseDirs();
  await mkdir(userSkillsDir(user), { recursive: true });
  await mkdir(userWorkspaceDir(user), { recursive: true });
  if (!existsSync(userStateFile(user))) {
    await writeFile(userStateFile(user), "{}\n", "utf8");
  }
}

async function createUser(login, password) {
  const normalizedLogin = normalizeLogin(login);
  if (normalizedLogin.length < 3) throw new Error("Login precisa ter pelo menos 3 caracteres");
  if (String(password || "").length < 4) throw new Error("Senha precisa ter pelo menos 4 caracteres");

  const users = await loadUsers();
  if (users.some((user) => user.login === normalizedLogin)) {
    throw new Error("Login já existe");
  }

  const user = {
    id: sanitizeId(normalizedLogin),
    login: normalizedLogin,
    password_hash: hashPassword(password),
    created_at: new Date().toISOString()
  };
  users.push(user);
  await saveUsers(users);
  await ensureUserDirs(user);
  return user;
}

function startSession(user) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

async function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.sf_session;
  if (!token || !sessions.has(token)) return null;

  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  const users = await loadUsers();
  return users.find((user) => user.id === session.userId) || null;
}

async function requireAuth(req, res) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  await ensureUserDirs(user);
  return user;
}

function skillFilePath(user, id) {
  return join(userSkillsDir(user), `${id}.json`);
}

function normalizeSkillPayload(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid skill payload");
  }

  const id = sanitizeId(input.id || input.name);
  const name = String(input.name || "").trim().replace(/\s+/g, "_");
  const description = String(input.description || "").trim();

  if (!id) throw new Error("Skill id/name is required");
  if (!name) throw new Error("Skill name is required");
  if (!description) throw new Error("Skill description is required");
  if (input.builtin) throw new Error("Builtin skills cannot be persisted");

  const skill = {
    id,
    builtin: false,
    enabled: input.enabled !== false,
    icon: String(input.icon || "⚙").trim() || "⚙",
    name,
    description,
    parameters: input.parameters && typeof input.parameters === "object"
      ? input.parameters
      : { type: "OBJECT", properties: {} }
  };

  if (input.action && typeof input.action === "object") {
    skill.action = input.action;
  } else if (typeof input.code === "string") {
    skill.code = input.code;
  } else {
    throw new Error("Skill needs action or code");
  }

  return skill;
}

function normalizeRelativePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function workspacePath(user, input) {
  const root = userWorkspaceDir(user);
  const rel = normalizeRelativePath(input);
  const absolute = resolve(root, rel || ".");
  const back = relative(root, absolute);
  if (back.startsWith("..") || back.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Path escapes workspace root");
  }
  return { rel, absolute };
}

function entryTypeFromStats(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

async function loadCustomSkills(user) {
  const dir = userSkillsDir(user);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const skills = [];

  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file.name), "utf8");
      const parsed = JSON.parse(raw);
      skills.push(normalizeSkillPayload(parsed));
    } catch (error) {
      console.error(`Failed to load skill ${file.name}:`, error.message);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadUserState(user) {
  await ensureUserDirs(user);
  try {
    return JSON.parse(await readFile(userStateFile(user), "utf8"));
  } catch {
    return {};
  }
}

async function saveUserState(user, nextState) {
  await ensureUserDirs(user);
  await writeFile(userStateFile(user), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function nowMs() {
  return Date.now();
}

function clampCodexHistoryLimit(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_CODEX_HISTORY_LIMIT), 10);
  if (Number.isNaN(parsed)) return DEFAULT_CODEX_HISTORY_LIMIT;
  return Math.max(2, Math.min(200, parsed));
}

function decodeBase64Url(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function extractCodexAccountId(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return null;
  const auth = payload["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return null;
  return auth.chatgpt_account_id || null;
}

function normalizeCodexAuth(input) {
  let auth = input;
  if (typeof auth === "string") {
    const trimmed = auth.trim();
    if (!trimmed) throw new Error("auth invalido: vazio.");
    auth = trimmed.startsWith("{") ? JSON.parse(trimmed) : { access: trimmed };
  }

  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("auth invalido: esperado objeto JSON.");
  }

  const access = auth.access || auth.access_token;
  const refresh = auth.refresh || auth.refresh_token || null;
  let expires = auth.expires ?? auth.expires_at ?? null;

  if (expires !== null && expires !== undefined && expires !== "") {
    const parsed = Number.parseInt(String(expires), 10);
    if (Number.isNaN(parsed)) {
      expires = null;
    } else {
      expires = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
    }
  } else {
    expires = null;
  }

  if (!access) {
    throw new Error("auth invalido: access/access_token ausente.");
  }

  return {
    access,
    refresh,
    expires,
    accountId: auth.accountId || extractCodexAccountId(access)
  };
}

async function refreshCodexAuth(auth) {
  if (!auth.refresh) return auth;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
    client_id: OPENAI_OAUTH_CLIENT_ID
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `refresh falhou: HTTP ${response.status}`);
  }

  const payload = raw ? JSON.parse(raw) : {};
  return {
    access: payload.access_token,
    refresh: payload.refresh_token || auth.refresh,
    expires: nowMs() + Number(payload.expires_in || 0) * 1000,
    accountId: auth.accountId || extractCodexAccountId(payload.access_token)
  };
}

async function getValidCodexAuth(input) {
  const auth = normalizeCodexAuth(input);
  if (auth.refresh && auth.expires && auth.expires <= nowMs() + 300000) {
    return refreshCodexAuth(auth);
  }
  return auth;
}

function collectSseChunks(value, keyName, chunks) {
  if (Array.isArray(value)) {
    for (const item of value) collectSseChunks(item, keyName, chunks);
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const nested of Object.values(value)) {
    collectSseChunks(nested, keyName, chunks);
  }

  if (typeof value[keyName] === "string") {
    chunks.push(value[keyName]);
  }
}

function extractCodexResponseOutputText(responseObj) {
  const chunks = [];
  if (!responseObj || typeof responseObj !== "object") return chunks;
  const output = Array.isArray(responseObj.output) ? responseObj.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks;
}

function parseCodexSsePayload(raw) {
  const events = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    try {
      events.push(JSON.parse(chunk));
    } catch {
      // Ignore malformed SSE chunks.
    }
  }

  let responseId = null;
  const deltaParts = [];
  let finalTextParts = [];

  for (const event of events) {
    if (!responseId && event && typeof event === "object") {
      responseId = event.response_id || event.id || null;
    }

    const deltas = [];
    collectSseChunks(event, "delta", deltas);
    for (const delta of deltas) {
      if (typeof delta === "string") deltaParts.push(delta);
    }

    if (event?.type === "response.completed") {
      finalTextParts = extractCodexResponseOutputText(event.response);
    }
  }

  const sourceParts = deltaParts.length ? deltaParts : finalTextParts;
  const deduped = [];
  let last = null;
  for (const part of sourceParts) {
    if (part !== last) deduped.push(part);
    last = part;
  }

  return {
    id: responseId,
    output_text: deduped.join("").trim(),
    events
  };
}

function skillflowMsgToCodexText(message) {
  if (!message || typeof message !== "object") return "";

  const parts = [];
  if (typeof message.text === "string" && message.text.trim()) {
    parts.push(message.text.trim());
  }

  const imageCount = Array.isArray(message.imgs) ? message.imgs.length : 0;
  const files = Array.isArray(message.files) ? message.files : [];
  if (imageCount || files.length) {
    const labels = [];
    if (imageCount) labels.push(`${imageCount} imagem(ns)`);
    if (files.length) labels.push(`${files.length} arquivo(s)`);
    parts.push(`[Anexos na conversa: ${labels.join(" e ")}]`);
    const fileNames = files.map((file) => file?.name).filter(Boolean);
    if (fileNames.length) {
      parts.push(`Arquivos: ${fileNames.join(", ")}`);
    }
  }

  return parts.join("\n").trim();
}

function makeCodexInputMessage(role, text) {
  return {
    role,
    content: [{
      type: role === "assistant" ? "output_text" : "input_text",
      text
    }]
  };
}

function buildCodexContextMessages(messages, historyLimit) {
  const normalized = [];
  const source = Array.isArray(messages) ? messages : [];
  for (const message of source) {
    const role = message?.role === "model" ? "assistant"
      : message?.role === "user" ? "user"
        : null;
    if (!role) continue;
    const text = skillflowMsgToCodexText(message);
    if (!text) continue;
    normalized.push(makeCodexInputMessage(role, text));
  }

  const limit = clampCodexHistoryLimit(historyLimit);
  return normalized.length > limit ? normalized.slice(-limit) : normalized;
}

function buildFakeCodexResponse(messages, userInput, model, sessionId) {
  const responseId = `fake-${sessionId || "skillflow"}-${nowMs()}`;
  return {
    id: responseId,
    output_text: `[fake:${model}] Conversa ${sessionId || "sem-id"} recebeu ${messages.length} mensagens de contexto. Ultima mensagem: ${userInput}`,
    events: [{ type: "response.completed", response_id: responseId }]
  };
}

async function runCodexChat(payload) {
  const auth = await getValidCodexAuth(payload.auth);
  const model = String(payload.model || DEFAULT_CODEX_MODEL);
  const reasoning = String(payload.reasoning || DEFAULT_CODEX_REASONING);
  const instructions = String(payload.instructions || DEFAULT_CODEX_INSTRUCTIONS);
  const contextMessages = buildCodexContextMessages(payload.messages, payload.history_limit);
  const userInput = contextMessages.at(-1)?.content?.[0]?.text || "";

  if (!userInput) {
    throw new Error("Nao foi encontrada nenhuma mensagem valida para enviar ao Codex.");
  }

  if (CODEX_FAKE_RESPONSES) {
    return {
      data: buildFakeCodexResponse(contextMessages, userInput, model, payload.session_id),
      auth
    };
  }

  const headers = {
    Authorization: `Bearer ${auth.access}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream"
  };
  if (auth.accountId) {
    headers["chatgpt-account-id"] = auth.accountId;
  }

  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: contextMessages,
      store: false,
      stream: true,
      reasoning: { effort: reasoning },
      instructions
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `Codex falhou com HTTP ${response.status}`);
  }

  return {
    data: parseCodexSsePayload(raw),
    auth
  };
}

async function handleChatApi(req, res, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const raw = await readRequestBody(req);
  const payload = raw ? JSON.parse(raw) : {};
  const provider = String(payload.provider || "").trim().toLowerCase();

  if (provider !== "codex") {
    sendJson(res, 400, { error: "Unsupported provider for backend chat route" });
    return;
  }

  if (!payload.auth) {
    sendJson(res, 400, { error: "auth ausente." });
    return;
  }

  if (!payload.model) {
    sendJson(res, 400, { error: "model ausente." });
    return;
  }

  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    sendJson(res, 400, { error: "messages ausente." });
    return;
  }

  const result = await runCodexChat({
    auth: payload.auth,
    model: payload.model,
    reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
    history_limit: payload.history_limit ?? DEFAULT_CODEX_HISTORY_LIMIT,
    instructions: payload.instructions || DEFAULT_CODEX_INSTRUCTIONS,
    messages: payload.messages,
    session_id: payload.session_id || `${user.id}-skillflow`
  });

  sendJson(res, 200, {
    ok: true,
    provider: "codex",
    model: payload.model,
    reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
    context_message_count: buildCodexContextMessages(payload.messages, payload.history_limit).length,
    auth: result.auth,
    payload: result.data
  });
}

async function handleAuthRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/auth/me") {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    sendJson(res, 200, { user: { id: user.id, login: user.login } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/register") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const user = await createUser(payload.login, payload.password);
    const token = startSession(user);
    sendJson(res, 200, { ok: true, user: { id: user.id, login: user.login } }, {
      "Set-Cookie": sessionCookie(token)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const login = normalizeLogin(payload.login);
    const password = String(payload.password || "");
    const users = await loadUsers();
    const user = users.find((item) => item.login === login);
    if (!user || !verifyPassword(password, user.password_hash)) {
      sendJson(res, 401, { error: "Login ou senha inválidos" });
      return;
    }
    await ensureUserDirs(user);
    const token = startSession(user);
    sendJson(res, 200, { ok: true, user: { id: user.id, login: user.login } }, {
      "Set-Cookie": sessionCookie(token)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const cookies = parseCookies(req);
    if (cookies.sf_session) destroySession(cookies.sf_session);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleGhostSearch(req, res, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload.user_id) payload.user_id = user.id;

    const upstream = await fetch("https://api.ghost1.cloud/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(text);
  } catch (error) {
    sendJson(res, 500, { error: `ghost-search proxy failed: ${error.message}` });
  }
}

async function handleSkillsApi(req, res, url, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    sendJson(res, 200, { skills: await loadCustomSkills(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const skill = normalizeSkillPayload(payload);
    await writeFile(skillFilePath(user, skill.id), `${JSON.stringify(skill, null, 2)}\n`, "utf8");
    sendJson(res, 200, { ok: true, skill });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/skills/")) {
    const id = sanitizeId(url.pathname.slice("/api/skills/".length));
    if (!id) {
      sendJson(res, 400, { error: "Skill id is required" });
      return;
    }
    const filePath = skillFilePath(user, id);
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }
    await unlink(filePath);
    sendJson(res, 200, { ok: true, id });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleFsApi(req, res, url, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  await ensureUserDirs(user);

  if (req.method === "GET" && url.pathname === "/api/fs/list") {
    const requestedPath = url.searchParams.get("path") || "";
    const { rel, absolute } = workspacePath(user, requestedPath);
    const entries = await readdir(absolute, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      const childRel = normalizeRelativePath(join(rel, entry.name));
      const child = workspacePath(user, childRel);
      const stats = await lstat(child.absolute);
      items.push({
        name: entry.name,
        path: childRel,
        type: entryTypeFromStats(stats),
        size: stats.size,
        updated_at: stats.mtime.toISOString()
      });
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sendJson(res, 200, { path: rel, items });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/fs/read") {
    const requestedPath = url.searchParams.get("path") || "";
    const { rel, absolute } = workspacePath(user, requestedPath);
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      sendJson(res, 400, { error: "Path is not a file" });
      return;
    }
    sendJson(res, 200, {
      path: rel,
      type: "file",
      size: stats.size,
      updated_at: stats.mtime.toISOString(),
      content: await readFile(absolute, "utf8")
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/write") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, payload.path);
    const createDirs = payload.create_dirs !== false && payload.create_dirs !== "false";
    if (createDirs) await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, String(payload.content ?? ""), "utf8");
    const stats = await lstat(absolute);
    sendJson(res, 200, {
      ok: true,
      path: rel,
      type: "file",
      size: stats.size,
      updated_at: stats.mtime.toISOString()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/mkdir") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload.path) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, payload.path);
    await mkdir(absolute, { recursive: true });
    sendJson(res, 200, { ok: true, path: rel, type: "directory" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/rename") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload.path || !payload.next_path) {
      sendJson(res, 400, { error: "path and next_path are required" });
      return;
    }
    const source = workspacePath(user, payload.path);
    const target = workspacePath(user, payload.next_path);
    await mkdir(dirname(target.absolute), { recursive: true });
    await rename(source.absolute, target.absolute);
    const stats = await lstat(target.absolute);
    sendJson(res, 200, {
      ok: true,
      from: source.rel,
      to: target.rel,
      type: entryTypeFromStats(stats),
      size: stats.size,
      updated_at: stats.mtime.toISOString()
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/fs/delete") {
    const requestedPath = url.searchParams.get("path") || "";
    if (!requestedPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, requestedPath);
    await rm(absolute, { recursive: true, force: false });
    sendJson(res, 200, { ok: true, path: rel });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleStateApi(req, res, user) {
  if (req.method === "GET") {
    sendJson(res, 200, { state: await loadUserState(user) });
    return;
  }

  if (req.method === "POST") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const current = await loadUserState(user);
    const next = { ...current };
    const incomingState = payload.state && typeof payload.state === "object" ? payload.state : {};
    for (const key of STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(incomingState, key)) {
        next[key] = incomingState[key];
      }
    }
    await saveUserState(user, next);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function serveStatic(req, res, user) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") {
    if (!user) {
      const loginPath = join(publicDir, "login.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      createReadStream(loginPath).pipe(res);
      return;
    }
    pathname = "/index.html";
  }

  if (pathname === "/login" || pathname === "/login.html") {
    if (user) {
      sendRedirect(res, "/");
      return;
    }
    pathname = "/login.html";
  }

  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const fallbackPath = join(publicDir, user ? "index.html" : "login.html");
  const finalPath = existsSync(filePath) ? filePath : fallbackPath;
  const ext = extname(finalPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(finalPath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const user = await getAuthenticatedUser(req);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "skillflow-node-9321",
      port: PORT,
      authenticated: Boolean(user),
      codex_fake_responses: CODEX_FAKE_RESPONSES
    });
    return;
  }

  if (url.pathname.startsWith("/auth/")) {
    try {
      await handleAuthRoutes(req, res, url);
    } catch (error) {
      sendJson(res, 500, { error: `auth failed: ${error.message}` });
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const authUser = user || await requireAuth(req, res);
    if (!authUser) return;

    try {
      if (url.pathname === "/api/ghost-search") {
        await handleGhostSearch(req, res, authUser);
        return;
      }
      if (url.pathname === "/api/chat") {
        await handleChatApi(req, res, authUser);
        return;
      }
      if (url.pathname === "/api/state") {
        await handleStateApi(req, res, authUser);
        return;
      }
      if (url.pathname === "/api/skills" || url.pathname.startsWith("/api/skills/")) {
        await handleSkillsApi(req, res, url, authUser);
        return;
      }
      if (url.pathname.startsWith("/api/fs/")) {
        await handleFsApi(req, res, url, authUser);
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: `api failed: ${error.message}` });
    }
    return;
  }

  try {
    await serveStatic(req, res, user);
  } catch (error) {
    sendJson(res, 500, { error: `static-serve failed: ${error.message}` });
  }
});

ensureBaseDirs()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`SkillFlow server listening on ${HOST}:${PORT} (all container interfaces)`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server:", error);
    process.exit(1);
  });
