// 脉络 · 网关这一侧：扫全部会话（含回收站）、增量缓存、给前端的 /api/lineage。
// 推断逻辑在 lineage-core.mjs；显式记录（分叉 / 回退时写）在 lineage-store.mjs。规划见 claude-workspace/session-lineage-plan.md。
//
// 缓存：每个会话按字节偏移增量读，结果落在 home/.cache/ccapp-lineage-index.json。
// 开发端 900 MB 的会话从头扫一遍约 15 秒，所以不能每次重启都重扫；落盘后重启只读新追加的部分。
// 会话记录（jsonl）一个字节都不改。
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { NAMES, PINS } from "./sessions.mjs";
import { emptyRecord, inferParents, scanSession } from "./lineage-core.mjs";
import { lineageDb } from "./lineage-store.mjs";

const CACHE_FILE = path.join(CFG.home, ".cache", "ccapp-lineage-index.json");
const TRASH_DIR = path.join(CFG.home, ".ccapp-trash");
const SID = /^[0-9a-f-]{36}$/i;

let RECS = null;          // id → 记录（lineage-core 的 scanSession 结果）
const META = new Map();   // id → { file, project, trashed, mtime }
let building = null, dirty = false;

function loadCache() {
  if (RECS) return;
  RECS = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (j && j.v === 1 && Array.isArray(j.recs)) for (const r of j.recs) if (r && r.id) RECS.set(r.id, { ...emptyRecord(r.id), ...r });
  } catch {}
}
function saveCache() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify({ v: 1, recs: [...RECS.values()] }), { mode: 0o600 });
    fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
  } catch (e) { log("写脉络缓存失败: " + e.message); }
}

/** 列出全部会话文件：projects 下的，加回收站里的（画成幽灵节点，亲缘不断） */
function listFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PATHS.projects, d.name);
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) if (f.endsWith(".jsonl") && SID.test(f.slice(0, -6))) out.push({ id: f.slice(0, -6), file: path.join(dir, f), project: d.name, trashed: false });
  }
  let slots = []; try { slots = fs.readdirSync(TRASH_DIR); } catch {}
  for (const id of slots) {
    if (!SID.test(id)) continue;
    const file = path.join(TRASH_DIR, id, id + ".jsonl");
    if (fs.existsSync(file)) out.push({ id, file, project: null, trashed: true });
  }
  return out;
}

/** 刷新索引：大小、开头都没变的会话直接用缓存；变了的只读新追加的部分 */
async function refresh() {
  loadCache();
  const files = listFiles(), alive = new Set();
  for (const f of files) {
    alive.add(f.id);
    let st; try { st = fs.statSync(f.file); } catch { continue; }
    META.set(f.id, { file: f.file, project: f.project, trashed: f.trashed, mtime: st.mtimeMs });
    const prev = RECS.get(f.id);
    if (prev && prev.size === st.size && prev.off === st.size) continue;
    try { RECS.set(f.id, await scanSession(f.file, prev)); dirty = true; }
    catch (e) { log(`脉络：读 ${f.id.slice(0, 8)} 失败：${e.message}`); }
  }
  for (const id of [...RECS.keys()]) if (!alive.has(id)) { RECS.delete(id); META.delete(id); dirty = true; }
  saveCache();
}

/** 并发请求共用一次刷新 */
export function lineageRefresh() {
  if (!building) building = refresh().finally(() => { building = null; });
  return building;
}

/** 给前端：节点（会话）+ 边（主父）。只有元数据和标题，没有消息正文 */
export async function lineageGraph() {
  await lineageRefresh();
  const db = lineageDb();
  const parents = inferParents(RECS, { names: NAMES, explicit: db.edges });
  const nodes = [];
  for (const r of RECS.values()) {
    const m = META.get(r.id) || {};
    nodes.push({
      id: r.id, title: NAMES[r.id] || r.first || "", renamed: !!NAMES[r.id], pinned: PINS[r.id] || 0,
      project: m.project || null, cwd: r.cwd || "", trashed: !!m.trashed,
      firstTs: r.firstTs, lastTs: r.lastTs, mtime: m.mtime || 0, turns: r.turns, chapters: r.compacts.length, sizeKb: Math.round(r.size / 1024),
    });
  }
  const edges = [];
  for (const [child, e] of parents) {
    edges.push({ child, parent: e.parent, at: e.at, kind: e.kind, source: e.source, missing: !RECS.has(e.parent) });
  }
  for (const [child, e] of Object.entries(db.edges)) for (const x of e.extra || []) {
    if (x && x.id) edges.push({ child, parent: x.id, at: x.at || null, kind: "merge", source: "explicit", how: x.how || "", missing: !RECS.has(x.id) });
  }
  return { nodes, edges };
}

export async function routeLineage(req, res, u, p) {
  if (p !== "/api/lineage") return NEXT;
  if (req.method !== "GET") return sendJson(res, 405, { error: "method" });
  try { return sendJson(res, 200, await lineageGraph()); }
  catch (e) { return sendJson(res, 500, { error: e.message }); }
}
