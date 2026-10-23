// ── 项目 ──────────────────────────────────────────────────────────────
// 一个项目 = 一个工作目录 + 自己的指令（目录里的 CLAUDE.md）+ 默认型号 / 思考强度 / 权限模式。
// 项目里开的对话 cwd 就是项目目录（claude 按 cwd 把会话记录放进 ~/.claude/projects/<目录名>/），
// 所以「哪些对话属于这个项目」直接看会话的 cwd，不另记一份映射。
// 清单存在 home/ccapp-projects.json；目录本身不归我们管，删项目默认只删清单里这一条。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { PEEK_CACHE, findSessionFile, listSessions } from "./sessions.mjs";
import { trashSession } from "./sessionops.mjs";
import { termEnv } from "./terminal.mjs";
import { killTree } from "./claude.mjs";

const FILE = path.join(CFG.home, "ccapp-projects.json");
// 项目颜色：和界面强调色同一套饱和度，按顺序分配（用户可改）
export const PROJ_COLORS = ["#c96442", "#2f6aa8", "#3d7a2a", "#8a5cb8", "#b08a2e", "#2f8a8a", "#b0506e", "#6b7280"];
const SAME = ["", "follow"];   // 「跟随全局」存成空串

export let PROJECTS = [];
try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); if (Array.isArray(j)) PROJECTS = j.filter((p) => p && p.id && p.path); } catch {}
function save() {
  try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(PROJECTS, null, 1)); fs.renameSync(FILE + ".tmp", FILE); }
  catch (e) { log("项目清单保存失败: " + e.message); }
}

const real = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(String(d || "")); } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
/** claude 给 cwd 起会话目录名的规则：非字母数字一律换成 - */
export const projectSlug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");

export const projectById = (id) => PROJECTS.find((p) => p.id === id) || null;
/** 目录属于哪个项目：等于项目目录或在它下面（取最深的那个） */
export function projectOfDir(dir) {
  if (!dir) return null;
  const d = real(dir);
  let best = null;
  for (const p of PROJECTS) {
    const r = real(p.path);
    if ((d === r || d.startsWith(r + "/")) && (!best || r.length > real(best.path).length)) best = p;
  }
  return best;
}
/** 项目的默认值（空串 = 跟随全局） */
export function projectDefaults(p) {
  if (!p) return {};
  const v = (x) => (SAME.includes(x || "") ? undefined : x);
  return { model: v(p.model), effort: v(p.effort), perm: v(p.perm), provider: v(p.provider) };   // provider：项目里的会话默认用哪家（模型名是给这家的）
}

function slugName(name) {
  const s = String(name).trim().toLowerCase().replace(/[^a-z0-9一-龥._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "project";
}
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 列表：带每个项目的对话数、最后活动时间、记忆条数 */
function listProjects() {
  const sess = listSessions(5000);
  return PROJECTS.map((p) => {
    const r = real(p.path);
    const mine = sess.filter((s) => s.cwd && (real(s.cwd) === r || real(s.cwd).startsWith(r + "/")));
    return {
      ...p,
      exists: isDir(p.path),
      sessions: mine.length,
      lastAt: Math.max(p.created || 0, ...mine.map((s) => s.mtime || 0)),
      memory: memoryFiles(p).length,
    };
  });
}
/** Claude 自己记在这个项目里的记忆：~/.claude/projects/<目录名>/memory/*.md */
function memoryFiles(p) {
  const dir = path.join(PATHS.projects, projectSlug(real(p.path)), "memory");
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").map((f) => path.join(dir, f)); } catch { return []; }
}
/** 项目自带的 MCP 服务器（.mcp.json） */
function projectMcp(p) {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(p.path, ".mcp.json"), "utf8")).mcpServers || {}); } catch { return []; }
}
/** 顶层文件（目录在前），给项目页「文件」一栏 */
function topFiles(p, max = 40) {
  let ents = [];
  try { ents = fs.readdirSync(p.path, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.name !== ".git")
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, max).map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

function gitClone(url, dest) {
  return new Promise((resolve, reject) => {
    const c = spawn("git", ["clone", "--depth", "50", url, dest], { env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const t = setTimeout(() => { killTree(c); reject(new Error(tz("克隆超时（5 分钟）"))); }, 5 * 60000);
    c.on("error", (e) => { clearTimeout(t); reject(e); });
    c.on("close", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || "git clone " + code)); });
  });
}

/** 把一个会话挪进 / 挪出项目：jsonl 和旁边的同名目录搬到新 cwd 对应的目录，记录里的 cwd 改写，--resume 才找得到 */
export function moveSession(sid, projectId) {
  const found = findSessionFile(sid);
  if (!found) throw new Error(tz("找不到这个会话"));
  const p = projectId ? projectById(projectId) : null;
  if (projectId && !p) throw new Error(tz("项目不存在"));
  const cwd = p ? real(p.path) : real(CFG.workspace);
  const dir = path.join(PATHS.projects, projectSlug(cwd));
  if (path.dirname(found.file) === dir) return { ok: true, same: true };
  fs.mkdirSync(dir, { recursive: true });
  const text = fs.readFileSync(found.file, "utf8");
  const out = text.split("\n").map((l) => {
    if (!l.includes('"cwd"')) return l;
    try { const ev = JSON.parse(l); if (ev.cwd) ev.cwd = cwd; return JSON.stringify(ev); } catch { return l; }
  }).join("\n");
  const dst = path.join(dir, sid + ".jsonl");
  const st = fs.statSync(found.file);
  fs.writeFileSync(dst, out);
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch {}
  const side = path.join(path.dirname(found.file), sid);
  if (isDir(side)) { try { fs.renameSync(side, path.join(dir, sid)); } catch {} }
  fs.rmSync(found.file, { force: true });
  PEEK_CACHE.delete(found.file);
  log(`📁 会话 ${sid.slice(0, 8)} → ${p ? "项目 " + p.name : "工作区"}`);
  return { ok: true };
}

// ── 路由：/api/projects ──
export async function routeProjects(req, res, u, p) {
  if (!p.startsWith("/api/projects") && !/^\/api\/sessions\/[^/]+\/move$/.test(p)) return NEXT;
  const body = async () => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; } };

  const mv = p.match(/^\/api\/sessions\/([^/]+)\/move$/);
  if (mv && req.method === "POST") {
    const b = await body();
    try { return sendJson(res, 200, moveSession(decodeURIComponent(mv[1]), b.projectId || null)); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  if (p === "/api/projects" && req.method === "GET") {
    return sendJson(res, 200, { projects: listProjects(), colors: PROJ_COLORS, workspace: CFG.workspace });
  }

  if (p === "/api/projects" && req.method === "POST") {
    const b = await body();
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return sendJson(res, 400, { error: tz("项目名不能为空") });
    let dir;
    if (b.mode === "dir") {
      dir = real(String(b.path || ""));
      if (!isDir(dir)) return sendJson(res, 400, { error: tz("目录不存在：{d}", { d: dir }) });
    } else {
      let base = path.join(CFG.workspace, slugName(name)), n = 2;
      while (fs.existsSync(base)) base = path.join(CFG.workspace, slugName(name) + "-" + n++);
      dir = base;
      if (b.mode === "git") {
        const url = String(b.url || "").trim();
        if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return sendJson(res, 400, { error: tz("仓库地址要以 https:// 或 git@ 开头") });
        try { await gitClone(url, dir); } catch (e) { return sendJson(res, 400, { error: tz("克隆失败：{msg}", { msg: e.message }) }); }
      } else fs.mkdirSync(dir, { recursive: true });
    }
    if (PROJECTS.some((x) => real(x.path) === real(dir))) return sendJson(res, 409, { error: tz("这个目录已经是一个项目了") });
    const instr = String(b.instr || "").trim();
    if (instr && !fs.existsSync(path.join(dir, "CLAUDE.md"))) fs.writeFileSync(path.join(dir, "CLAUDE.md"), instr + "\n");
    const proj = { id: newId(), name, path: real(dir), color: PROJ_COLORS[PROJECTS.length % PROJ_COLORS.length], model: "", effort: "", perm: "", created: Date.now() };
    PROJECTS.push(proj); save();
    log(`📁 新项目「${name}」 ${proj.path}`);
    return sendJson(res, 200, { ok: true, project: proj });
  }

  const m = p.match(/^\/api\/projects\/([^/]+)(\/[a-z]+)?$/);
  if (!m) return NEXT;
  const proj = projectById(decodeURIComponent(m[1]));
  if (!proj) return sendJson(res, 404, { error: tz("项目不存在") });
  const sub = m[2] || "";

  if (!sub && req.method === "GET") {
    const one = listProjects().find((x) => x.id === proj.id);
    const r = real(proj.path);
    const sessions = listSessions(5000).filter((s) => s.cwd && (real(s.cwd) === r || real(s.cwd).startsWith(r + "/")))
      .map((s) => ({ id: s.id, title: s.title, mtime: s.mtime, pinned: s.pinned }));
    return sendJson(res, 200, { project: one, sessions, files: topFiles(proj), mcp: projectMcp(proj),
      memory: memoryFiles(proj).map((f) => ({ name: path.basename(f, ".md"), path: f })) });
  }
  if (!sub && req.method === "PATCH") {
    const b = await body();
    if (typeof b.name === "string" && b.name.trim()) proj.name = b.name.trim().slice(0, 60);
    if (typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color)) proj.color = b.color;
    for (const k of ["model", "effort", "perm", "provider"]) if (typeof b[k] === "string") proj[k] = b[k].trim().slice(0, 80);
    save();
    return sendJson(res, 200, { ok: true, project: proj });
  }
  if (!sub && req.method === "DELETE") {
    const withDir = u.searchParams.get("withDir") === "1";
    if (withDir) {
      const r = real(proj.path);
      // 删目录前先把对话收进回收站（可恢复）；目录本身直接删
      for (const s of listSessions(5000)) if (s.cwd && (real(s.cwd) === r || real(s.cwd).startsWith(r + "/"))) { try { trashSession(s.id); } catch {} }
      if (r === real(CFG.workspace) || r === real(CFG.home) || r.split("/").length < 4) return sendJson(res, 400, { error: tz("这个目录不能删") });
      try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    }
    PROJECTS = PROJECTS.filter((x) => x.id !== proj.id); save();
    log(`📁 删除项目「${proj.name}」${withDir ? "（连目录）" : ""}`);
    return sendJson(res, 200, { ok: true });
  }
  // 指令 = 项目目录里的 CLAUDE.md
  if (sub === "/instr") {
    const f = path.join(proj.path, "CLAUDE.md");
    if (req.method === "GET") { let text = ""; try { text = fs.readFileSync(f, "utf8"); } catch {} return sendJson(res, 200, { text, exists: fs.existsSync(f) }); }
    if (req.method === "PUT") {
      const b = await body();
      const text = String(b.text || "");
      if (!text.trim()) { try { fs.rmSync(f, { force: true }); } catch {} }
      else fs.writeFileSync(f, text.endsWith("\n") ? text : text + "\n");
      return sendJson(res, 200, { ok: true });
    }
  }
  return NEXT;
}
