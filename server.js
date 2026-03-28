import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
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
const EXECUTION_STATE_KEY = "sf_exec";
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EXEC_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_EXEC_HISTORY_ITEMS = 100;
const MAX_EXEC_LOG_TAIL_BYTES = 64 * 1024;
const activeExecutions = new Map();

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
  ".pdf": "application/pdf",
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

function attachmentDisposition(fileName) {
  const fallback = String(fileName || "download")
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]+/g, "_")
    .trim() || "download";
  const encoded = encodeURIComponent(String(fileName || fallback));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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

function userRunsDir(user) {
  return join(userWorkspaceDir(user), ".runs");
}

function userStateFile(user) {
  return join(userStateDir, `${user.id}.json`);
}

async function ensureUserDirs(user) {
  await ensureBaseDirs();
  await mkdir(userSkillsDir(user), { recursive: true });
  await mkdir(userWorkspaceDir(user), { recursive: true });
  await mkdir(userRunsDir(user), { recursive: true });
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

function executionDir(user, runId) {
  return join(userRunsDir(user), runId);
}

function executionPaths(user, runId) {
  const dir = executionDir(user, runId);
  return {
    dir,
    request: join(dir, "request.json"),
    result: join(dir, "result.json"),
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log")
  };
}

function executionRelativePath(runId, fileName) {
  return normalizeRelativePath(join(".runs", runId, fileName));
}

function generateRunId() {
  return `exec_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
}

function normalizeRunId(input) {
  const value = String(input || "").trim().toLowerCase();
  return /^[a-z0-9_-]{6,120}$/.test(value) ? value : "";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clampExecTimeoutMs(value) {
  return clampInteger(value, DEFAULT_EXEC_TIMEOUT_MS, 1000, MAX_EXEC_TIMEOUT_MS);
}

function clampExecHistoryLimit(value) {
  return clampInteger(value, 20, 1, MAX_EXEC_HISTORY_ITEMS);
}

function clampExecLogTailBytes(value) {
  return clampInteger(value, 16 * 1024, 512, MAX_EXEC_LOG_TAIL_BYTES);
}

function parseOptionalBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeExecEnv(input) {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("env precisa ser um objeto simples");
  }

  const env = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key || "").trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`env invalido: ${name}`);
    }
    env[name] = String(value ?? "");
  }
  return env;
}

function normalizeExecPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Payload de execucao invalido");
  }

  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) {
    throw new Error("command is required");
  }

  const args = Array.isArray(input.args) ? input.args.map((value) => String(value)) : [];
  const shell = parseOptionalBoolean(input.shell, !Array.isArray(input.args));
  if (shell && args.length) {
    throw new Error("Use command completo com shell=true ou defina shell=false para enviar args");
  }

  return {
    title: String(input.title || command).trim().slice(0, 160) || command,
    command,
    args,
    shell,
    cwd: normalizeRelativePath(input.cwd || ""),
    env: normalizeExecEnv(input.env),
    stdin: input.stdin === undefined || input.stdin === null ? "" : String(input.stdin),
    timeoutMs: clampExecTimeoutMs(input.timeout_ms)
  };
}

function buildExecutionRequestSnapshot(payload, cwd) {
  return {
    title: payload.title,
    command: payload.command,
    args: payload.args,
    shell: payload.shell,
    cwd: cwd || ".",
    timeout_ms: payload.timeoutMs,
    stdin_bytes: Buffer.byteLength(payload.stdin || "", "utf8"),
    env_keys: Object.keys(payload.env)
  };
}

function buildExecutionMeta(payload, runId, cwd) {
  return {
    id: runId,
    title: payload.title,
    status: "running",
    command: payload.command,
    args: payload.args,
    shell: payload.shell,
    cwd: cwd || ".",
    timeout_ms: payload.timeoutMs,
    env_keys: Object.keys(payload.env),
    request_path: executionRelativePath(runId, "request.json"),
    result_path: executionRelativePath(runId, "result.json"),
    stdout_path: executionRelativePath(runId, "stdout.log"),
    stderr_path: executionRelativePath(runId, "stderr.log"),
    pid: null,
    exit_code: null,
    signal: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null
  };
}

function buildExecutionSummary(meta) {
  return {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    command: meta.command,
    cwd: meta.cwd,
    started_at: meta.started_at,
    finished_at: meta.finished_at,
    duration_ms: meta.duration_ms,
    exit_code: meta.exit_code,
    signal: meta.signal,
    pid: meta.pid
  };
}

async function persistExecutionSummary(user, summary) {
  const state = await loadUserState(user);
  const current = state[EXECUTION_STATE_KEY] && typeof state[EXECUTION_STATE_KEY] === "object"
    ? state[EXECUTION_STATE_KEY]
    : {};
  const recent = Array.isArray(current.recent)
    ? current.recent.filter((item) => item && item.id !== summary.id)
    : [];

  recent.unshift(summary);
  state[EXECUTION_STATE_KEY] = {
    last_run_id: summary.id,
    updated_at: new Date().toISOString(),
    recent: recent.slice(0, MAX_EXEC_HISTORY_ITEMS)
  };
  await saveUserState(user, state);
}

async function persistExecutionMeta(user, meta) {
  const paths = executionPaths(user, meta.id);
  await writeFile(paths.result, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await persistExecutionSummary(user, buildExecutionSummary(meta));
}

async function readExecutionMeta(user, runId) {
  const paths = executionPaths(user, runId);
  if (!existsSync(paths.result)) return null;
  return JSON.parse(await readFile(paths.result, "utf8"));
}

function getActiveExecution(user, runId) {
  const active = activeExecutions.get(runId);
  if (!active || active.userId !== user.id) return null;
  return active;
}

async function getExecutionMeta(user, runId) {
  const active = getActiveExecution(user, runId);
  if (active) return active.meta;
  return readExecutionMeta(user, runId);
}

function closeWriteStream(stream) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("finish", finish);
    stream.once("error", finish);
    stream.end();
  });
}

async function readExecutionLog(logPath, tailBytes) {
  if (!existsSync(logPath)) {
    return { content: "", size: 0, truncated: false };
  }
  const buffer = await readFile(logPath);
  const limit = clampExecLogTailBytes(tailBytes);
  const truncated = buffer.length > limit;
  const sliced = truncated ? buffer.subarray(buffer.length - limit) : buffer;
  return {
    content: sliced.toString("utf8"),
    size: buffer.length,
    truncated
  };
}

async function listExecutionHistory(user, limit) {
  await ensureUserDirs(user);
  const entries = await readdir(userRunsDir(user), { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = normalizeRunId(entry.name);
    if (!runId) continue;
    try {
      const meta = await readExecutionMeta(user, runId);
      if (!meta) continue;
      items.push(buildExecutionSummary(meta));
    } catch (error) {
      console.error(`Failed to load execution ${entry.name}:`, error.message);
    }
  }

  items.sort((a, b) => {
    const left = Date.parse(b.finished_at || b.started_at || 0);
    const right = Date.parse(a.finished_at || a.started_at || 0);
    return left - right;
  });

  return items.slice(0, clampExecHistoryLimit(limit));
}

async function createExecution(user, input) {
  const payload = normalizeExecPayload(input);
  const workdir = workspacePath(user, payload.cwd);
  const runId = generateRunId();
  const paths = executionPaths(user, runId);

  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.request,
    `${JSON.stringify(buildExecutionRequestSnapshot(payload, workdir.rel || "."), null, 2)}\n`,
    "utf8"
  );

  let meta = buildExecutionMeta(payload, runId, workdir.rel || ".");
  await persistExecutionMeta(user, meta);

  const stdoutStream = createWriteStream(paths.stdout, { flags: "a" });
  const stderrStream = createWriteStream(paths.stderr, { flags: "a" });

  const child = payload.shell
    ? spawn(payload.command, {
      cwd: workdir.absolute,
      env: { ...process.env, ...payload.env },
      shell: true,
      stdio: "pipe"
    })
    : spawn(payload.command, payload.args, {
      cwd: workdir.absolute,
      env: { ...process.env, ...payload.env },
      shell: false,
      stdio: "pipe"
    });

  meta = {
    ...meta,
    pid: child.pid ?? null
  };

  const active = {
    userId: user.id,
    child,
    meta,
    stdoutStream,
    stderrStream,
    timeoutHandle: null,
    forceKillHandle: null,
    statusOverride: null,
    finalized: false
  };
  activeExecutions.set(runId, active);

  const finalize = async ({ status, exitCode, signal, errorMessage = null }) => {
    if (active.finalized) return;
    active.finalized = true;
    activeExecutions.delete(runId);
    if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
    if (active.forceKillHandle) clearTimeout(active.forceKillHandle);

    await Promise.all([
      closeWriteStream(stdoutStream),
      closeWriteStream(stderrStream)
    ]);

    const finishedAt = new Date().toISOString();
    const startedAt = Date.parse(active.meta.started_at);
    active.meta = {
      ...active.meta,
      status,
      exit_code: typeof exitCode === "number" ? exitCode : null,
      signal: signal || null,
      error: errorMessage,
      finished_at: finishedAt,
      duration_ms: Number.isFinite(startedAt)
        ? Math.max(0, Date.parse(finishedAt) - startedAt)
        : null
    };

    await persistExecutionMeta(user, active.meta);
  };

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      stdoutStream.write(chunk);
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrStream.write(chunk);
    });
  }

  child.on("error", (error) => {
    void finalize({
      status: active.statusOverride || "failed",
      exitCode: null,
      signal: null,
      errorMessage: error.message
    });
  });

  child.on("close", (code, signal) => {
    void finalize({
      status: active.statusOverride || (code === 0 ? "completed" : "failed"),
      exitCode: code,
      signal
    });
  });

  if (child.stdin) {
    try {
      if (payload.stdin) child.stdin.write(payload.stdin);
      child.stdin.end();
    } catch {
      child.stdin.destroy();
    }
  }

  active.timeoutHandle = setTimeout(() => {
    if (active.finalized) return;
    active.statusOverride = "timed_out";
    child.kill("SIGTERM");
    active.forceKillHandle = setTimeout(() => {
      if (!active.finalized) child.kill("SIGKILL");
    }, 5000);
  }, payload.timeoutMs);

  return meta;
}

async function cancelExecution(user, runId) {
  const active = getActiveExecution(user, runId);
  if (!active) return null;
  active.statusOverride = "cancelled";
  const signaled = active.child.kill("SIGTERM");
  active.forceKillHandle = setTimeout(() => {
    if (!active.finalized) active.child.kill("SIGKILL");
  }, 5000);
  return {
    ok: signaled,
    run: active.meta
  };
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

function normalizeCodexFunctionCallItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type !== "function_call") return null;

  const name = typeof item.name === "string" ? item.name.trim() : "";
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
  const rawArguments = typeof item.arguments === "string"
    ? item.arguments
    : JSON.stringify(item.arguments ?? {});

  if (!name || !callId) return null;

  let parsedArguments = {};
  if (rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedArguments = parsed;
      }
    } catch {
      parsedArguments = {};
    }
  }

  return {
    type: "function_call",
    id: typeof item.id === "string" ? item.id : callId,
    call_id: callId,
    name,
    arguments: rawArguments,
    parsed_arguments: parsedArguments
  };
}

function extractCodexResponseFunctionCalls(responseObj) {
  const calls = [];
  if (!responseObj || typeof responseObj !== "object") return calls;
  const output = Array.isArray(responseObj.output) ? responseObj.output : [];
  for (const item of output) {
    const normalized = normalizeCodexFunctionCallItem(item);
    if (normalized) calls.push(normalized);
  }
  return calls;
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
  let finalResponse = null;
  const streamedToolCalls = new Map();

  for (const event of events) {
    if (!responseId && event && typeof event === "object") {
      responseId = event.response_id || event.id || null;
    }

    const deltas = [];
    collectSseChunks(event, "delta", deltas);
    for (const delta of deltas) {
      if (typeof delta === "string") deltaParts.push(delta);
    }

    if (event?.type === "response.output_item.added") {
      const normalized = normalizeCodexFunctionCallItem(event.item);
      if (normalized) {
        const key = Number.isInteger(event.output_index) ? event.output_index : streamedToolCalls.size;
        streamedToolCalls.set(key, normalized);
      }
    }

    if (event?.type === "response.function_call_arguments.delta" && Number.isInteger(event.output_index)) {
      const current = streamedToolCalls.get(event.output_index);
      if (current) {
        current.arguments += typeof event.delta === "string" ? event.delta : "";
      }
    }

    if (event?.type === "response.function_call_arguments.done") {
      const normalized = normalizeCodexFunctionCallItem(event.item);
      if (normalized) {
        const key = Number.isInteger(event.output_index) ? event.output_index : streamedToolCalls.size;
        streamedToolCalls.set(key, normalized);
      }
    }

    if (event?.type === "response.completed") {
      finalResponse = event.response && typeof event.response === "object" ? event.response : null;
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

  const toolCalls = extractCodexResponseFunctionCalls(finalResponse);
  if (!toolCalls.length && streamedToolCalls.size) {
    for (const call of streamedToolCalls.values()) {
      let parsedArguments = {};
      if (call.arguments.trim()) {
        try {
          const parsed = JSON.parse(call.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedArguments = parsed;
          }
        } catch {
          parsedArguments = {};
        }
      }
      toolCalls.push({
        ...call,
        parsed_arguments: parsedArguments
      });
    }
  }

  return {
    id: responseId,
    output_text: deduped.join("").trim(),
    output_items: toolCalls.map((call) => ({
      type: "function_call",
      id: call.id,
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments
    })),
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      call_id: call.call_id,
      name: call.name,
      arguments: call.parsed_arguments,
      arguments_raw: call.arguments
    })),
    usage: finalResponse?.usage || null,
    status: finalResponse?.status || null,
    events
  };
}

function makeCodexInputMessage(role, content) {
  return { role, content };
}

function assetDataUrl(asset) {
  const mimeType = typeof asset?.mimeType === "string" ? asset.mimeType.trim() : "";
  const data = typeof asset?.data === "string" ? asset.data.trim() : "";
  if (!mimeType || !data) return null;
  return `data:${mimeType};base64,${data}`;
}

function decodeInlineTextAsset(asset) {
  const mimeType = String(asset?.mimeType || "").trim().toLowerCase();
  const data = typeof asset?.data === "string" ? asset.data.trim() : "";
  const isTextLike = mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType === "application/xml"
    || mimeType.endsWith("+json")
    || mimeType.endsWith("+xml");

  if (!isTextLike || !data) return null;

  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function buildCodexFileSummaryPart(file) {
  const name = typeof file?.name === "string" && file.name.trim() ? file.name.trim() : "arquivo";
  const mimeType = typeof file?.mimeType === "string" && file.mimeType.trim()
    ? file.mimeType.trim()
    : "application/octet-stream";
  const decoded = decodeInlineTextAsset(file);

  if (decoded) {
    const trimmed = decoded.trim();
    const limit = 12000;
    const excerpt = trimmed.slice(0, limit);
    const suffix = trimmed.length > limit ? "\n\n[arquivo truncado]" : "";
    return {
      type: "input_text",
      text: `[Arquivo anexo: ${name} (${mimeType})]\n${excerpt}${suffix}`
    };
  }

  return {
    type: "input_text",
    text: `[Arquivo anexo: ${name} (${mimeType})]`
  };
}

function buildCodexContextMessages(messages, historyLimit) {
  const normalized = [];
  const source = Array.isArray(messages) ? messages : [];
  const limit = clampCodexHistoryLimit(historyLimit);
  const trimmedSource = source.length > limit ? source.slice(-limit) : source;
  const attachmentIndices = new Set(
    trimmedSource
      .reduce((acc, message, index) => {
        if ((Array.isArray(message?.imgs) && message.imgs.length) || (Array.isArray(message?.files) && message.files.length)) {
          acc.push(index);
        }
        return acc;
      }, [])
      .slice(-3)
  );

  for (let index = 0; index < trimmedSource.length; index += 1) {
    const message = trimmedSource[index];

    if (message?.type === "function_call_output" && typeof message.call_id === "string") {
      normalized.push({
        type: "function_call_output",
        call_id: message.call_id,
        output: typeof message.output === "string" ? message.output : JSON.stringify(message.output ?? {})
      });
      continue;
    }

    if (message?.type === "function_call") {
      const normalizedCall = normalizeCodexFunctionCallItem(message);
      if (normalizedCall) {
        normalized.push({
          type: "function_call",
          id: normalizedCall.id,
          call_id: normalizedCall.call_id,
          name: normalizedCall.name,
          arguments: normalizedCall.arguments
        });
      }
      continue;
    }

    const role = message?.role === "model" ? "assistant"
      : message?.role === "user" ? "user"
        : null;
    if (!role) continue;

    const content = [];
    if (typeof message.text === "string" && message.text.trim()) {
      content.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: message.text.trim()
      });
    }

    if (role === "user") {
      const includeAttachments = attachmentIndices.has(index);
      const images = Array.isArray(message.imgs) ? message.imgs : [];
      const files = Array.isArray(message.files) ? message.files : [];

      if (includeAttachments) {
        for (const image of images) {
          const imageUrl = assetDataUrl(image);
          if (!imageUrl) continue;
          content.push({
            type: "input_image",
            image_url: imageUrl,
            detail: "auto"
          });
        }

        for (const file of files) {
          content.push(buildCodexFileSummaryPart(file));
        }
      } else if (images.length || files.length) {
        const labels = [];
        if (images.length) labels.push(`${images.length} imagem(ns)`);
        if (files.length) labels.push(`${files.length} arquivo(s)`);
        content.push({
          type: "input_text",
          text: `[Anexos omitidos do contexto: ${labels.join(" e ")}]`
        });
      }
    }

    if (!content.length) continue;
    normalized.push(makeCodexInputMessage(role, content));
  }

  return normalized;
}

function normalizeCodexTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  if (tool.type !== "function") return null;
  if (typeof tool.name !== "string" || !tool.name.trim()) return null;

  return {
    type: "function",
    name: tool.name.trim(),
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} }
  };
}

function buildFakeCodexResponse(messages, userInput, model, sessionId) {
  const responseId = `fake-${sessionId || "skillflow"}-${nowMs()}`;
  return {
    id: responseId,
    output_text: `[fake:${model}] Conversa ${sessionId || "sem-id"} recebeu ${messages.length} mensagens de contexto. Ultima mensagem: ${userInput}`,
    output_items: [],
    tool_calls: [],
    usage: null,
    events: [{ type: "response.completed", response_id: responseId }]
  };
}

async function runCodexChat(payload) {
  const auth = await getValidCodexAuth(payload.auth);
  const model = String(payload.model || DEFAULT_CODEX_MODEL);
  const reasoning = String(payload.reasoning || DEFAULT_CODEX_REASONING);
  const instructions = String(payload.instructions || DEFAULT_CODEX_INSTRUCTIONS);
  const contextMessages = Array.isArray(payload.input) && payload.input.length
    ? payload.input
    : buildCodexContextMessages(payload.messages, payload.history_limit);
  const lastUserInput = [...contextMessages]
    .reverse()
    .find((item) => item?.role === "user" && Array.isArray(item.content));
  const userInput = lastUserInput?.content?.find((part) => part?.type === "input_text" && typeof part.text === "string")
    ?.text || "[mensagem multimodal sem texto]";
  const tools = Array.isArray(payload.tools)
    ? payload.tools.map(normalizeCodexTool).filter(Boolean)
    : [];

  if (!contextMessages.length || !lastUserInput) {
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
      instructions,
      ...(tools.length ? { tools } : {})
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
    if (!Array.isArray(payload.input) || !payload.input.length) {
      sendJson(res, 400, { error: "messages/input ausente." });
      return;
    }
  }

  if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
    sendJson(res, 400, { error: "tools invalido." });
    return;
  }

  const result = await runCodexChat({
    auth: payload.auth,
    model: payload.model,
    reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
    history_limit: payload.history_limit ?? DEFAULT_CODEX_HISTORY_LIMIT,
    instructions: payload.instructions || DEFAULT_CODEX_INSTRUCTIONS,
    input: Array.isArray(payload.input) ? payload.input : null,
    messages: payload.messages,
    tools: payload.tools,
    session_id: payload.session_id || `${user.id}-skillflow`
  });

  const contextItems = Array.isArray(payload.input) && payload.input.length
    ? payload.input
    : buildCodexContextMessages(payload.messages, payload.history_limit);

  sendJson(res, 200, {
    ok: true,
    provider: "codex",
    model: payload.model,
    reasoning: payload.reasoning || DEFAULT_CODEX_REASONING,
    context_message_count: contextItems.length,
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

  if (req.method === "GET" && url.pathname === "/api/fs/download") {
    const requestedPath = url.searchParams.get("path") || "";
    if (!requestedPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(user, requestedPath);
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      sendJson(res, 400, { error: "Path is not a file" });
      return;
    }

    const fileName = rel.split("/").filter(Boolean).at(-1) || "download";
    const contentType = MIME_TYPES[extname(absolute).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Content-Disposition": attachmentDisposition(fileName),
      "Cache-Control": "no-store"
    });
    createReadStream(absolute).pipe(res);
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

async function handleExecApi(req, res, url, user) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/api/exec" || url.pathname === "/api/exec/history")) {
    sendJson(res, 200, {
      items: await listExecutionHistory(user, url.searchParams.get("limit"))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/exec") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const run = await createExecution(user, payload);
    sendJson(res, 202, { ok: true, run });
    return;
  }

  if (!url.pathname.startsWith("/api/exec/")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const parts = url.pathname.slice("/api/exec/".length).split("/").filter(Boolean);
  const runId = normalizeRunId(parts[0]);
  if (!runId) {
    sendJson(res, 400, { error: "Invalid execution id" });
    return;
  }

  if (parts.length === 1 && req.method === "GET") {
    const run = await getExecutionMeta(user, runId);
    if (!run) {
      sendJson(res, 404, { error: "Execution not found" });
      return;
    }
    sendJson(res, 200, {
      run,
      active: Boolean(getActiveExecution(user, runId))
    });
    return;
  }

  if (parts.length === 2 && parts[1] === "logs" && req.method === "GET") {
    const run = await getExecutionMeta(user, runId);
    if (!run) {
      sendJson(res, 404, { error: "Execution not found" });
      return;
    }

    const stream = String(url.searchParams.get("stream") || "both").trim().toLowerCase();
    if (!["stdout", "stderr", "both"].includes(stream)) {
      sendJson(res, 400, { error: "stream must be stdout, stderr or both" });
      return;
    }

    const tailBytes = url.searchParams.get("tail_bytes");
    const paths = executionPaths(user, runId);

    if (stream === "stdout") {
      sendJson(res, 200, {
        id: runId,
        active: Boolean(getActiveExecution(user, runId)),
        stream,
        ...(await readExecutionLog(paths.stdout, tailBytes))
      });
      return;
    }

    if (stream === "stderr") {
      sendJson(res, 200, {
        id: runId,
        active: Boolean(getActiveExecution(user, runId)),
        stream,
        ...(await readExecutionLog(paths.stderr, tailBytes))
      });
      return;
    }

    sendJson(res, 200, {
      id: runId,
      active: Boolean(getActiveExecution(user, runId)),
      stream,
      stdout: await readExecutionLog(paths.stdout, tailBytes),
      stderr: await readExecutionLog(paths.stderr, tailBytes)
    });
    return;
  }

  if (parts.length === 2 && parts[1] === "cancel" && req.method === "POST") {
    const existing = await getExecutionMeta(user, runId);
    if (!existing) {
      sendJson(res, 404, { error: "Execution not found" });
      return;
    }

    const result = await cancelExecution(user, runId);
    if (!result) {
      sendJson(res, 409, { error: "Execution is not active", run: existing });
      return;
    }

    sendJson(res, 202, result);
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

  const noCacheExt = [".html", ".css", ".js"].includes(ext);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": noCacheExt ? "no-cache, no-store, must-revalidate" : "public, max-age=3600"
  });
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
      if (url.pathname === "/api/exec" || url.pathname.startsWith("/api/exec/")) {
        await handleExecApi(req, res, url, authUser);
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
