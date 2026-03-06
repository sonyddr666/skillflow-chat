import { createServer } from "node:http";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 9321);
const HOST = "0.0.0.0";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const skillsDir = join(__dirname, "skills");
const workspaceDir = join(__dirname, "workspace");

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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleGhostSearch(req, res) {
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

    const upstream = await fetch("https://api.ghost1.cloud/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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

function sanitizeSkillId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function skillFilePath(id) {
  return join(skillsDir, `${id}.json`);
}

function normalizeSkillPayload(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid skill payload");
  }

  const id = sanitizeSkillId(input.id || input.name);
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

async function ensureSkillsDir() {
  await mkdir(skillsDir, { recursive: true });
}

async function ensureWorkspaceDir() {
  await mkdir(workspaceDir, { recursive: true });
}

function normalizeRelativePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function workspacePath(input) {
  const rel = normalizeRelativePath(input);
  const absolute = resolve(workspaceDir, rel || ".");
  const back = relative(workspaceDir, absolute);
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

async function loadCustomSkills() {
  await ensureSkillsDir();
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const skills = [];

  for (const file of files) {
    try {
      const raw = await readFile(join(skillsDir, file.name), "utf8");
      const parsed = JSON.parse(raw);
      skills.push(normalizeSkillPayload(parsed));
    } catch (error) {
      console.error(`Failed to load skill ${file.name}:`, error.message);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function handleSkillsApi(req, res, url) {
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
    const skills = await loadCustomSkills();
    sendJson(res, 200, { skills });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const skill = normalizeSkillPayload(payload);
    await ensureSkillsDir();
    await writeFile(skillFilePath(skill.id), `${JSON.stringify(skill, null, 2)}\n`, "utf8");
    sendJson(res, 200, { ok: true, skill });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/skills/")) {
    const id = sanitizeSkillId(url.pathname.slice("/api/skills/".length));
    if (!id) {
      sendJson(res, 400, { error: "Skill id is required" });
      return;
    }
    const filePath = skillFilePath(id);
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

async function handleFsApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  await ensureWorkspaceDir();

  if (req.method === "GET" && url.pathname === "/api/fs/list") {
    const requestedPath = url.searchParams.get("path") || "";
    const { rel, absolute } = workspacePath(requestedPath);
    const entries = await readdir(absolute, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      const childRel = normalizeRelativePath(join(rel, entry.name));
      const child = workspacePath(childRel);
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
    const { rel, absolute } = workspacePath(requestedPath);
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      sendJson(res, 400, { error: "Path is not a file" });
      return;
    }
    const content = await readFile(absolute, "utf8");
    sendJson(res, 200, {
      path: rel,
      type: "file",
      size: stats.size,
      updated_at: stats.mtime.toISOString(),
      content
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fs/write") {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const targetPath = payload.path;
    if (!targetPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(targetPath);
    const createDirs = payload.create_dirs !== false && payload.create_dirs !== "false";
    if (createDirs) {
      await mkdir(dirname(absolute), { recursive: true });
    }
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
    const targetPath = payload.path;
    if (!targetPath) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }
    const { rel, absolute } = workspacePath(targetPath);
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
    const source = workspacePath(payload.path);
    const target = workspacePath(payload.next_path);
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
    const { rel, absolute } = workspacePath(requestedPath);
    await rm(absolute, { recursive: true, force: false });
    sendJson(res, 200, { ok: true, path: rel });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const fallbackPath = join(publicDir, "index.html");
  const finalPath = existsSync(filePath) ? filePath : fallbackPath;
  const ext = extname(finalPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(finalPath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", service: "skillflow-node-9321", port: PORT });
    return;
  }

  if (url.pathname === "/api/ghost-search") {
    await handleGhostSearch(req, res);
    return;
  }

  if (url.pathname === "/api/skills" || url.pathname.startsWith("/api/skills/")) {
    try {
      await handleSkillsApi(req, res, url);
    } catch (error) {
      sendJson(res, 500, { error: `skills-api failed: ${error.message}` });
    }
    return;
  }

  if (url.pathname.startsWith("/api/fs/")) {
    try {
      await handleFsApi(req, res, url);
    } catch (error) {
      sendJson(res, 500, { error: `fs-api failed: ${error.message}` });
    }
    return;
  }

  try {
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: `static-serve failed: ${error.message}` });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SkillFlow server listening on ${HOST}:${PORT} (all container interfaces)`);
});
