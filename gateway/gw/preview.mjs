import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MIME, NEXT, readBody, sendJson } from "./http.mjs";
import { safeFilePath } from "./files.mjs";

// ── HTML 预览 ─────────────────────────────────────────────────────────
// 查看器里渲染 HTML：另起一个只读的小服务（随机端口，地址用 localhost），和界面（127.0.0.1:端口）不同站点——
// 预览页里的脚本拿不到界面的 Cookie，也过不了 /api 的 Origin 校验，Claude 写的网页随便跑也碰不到网关。
// 每次预览发一张随机凭证，只能读那个 HTML 所在目录里的东西；路径照样过 safeFilePath（密钥、私有目录照旧拦）。
// 网址形如 http://localhost:<端口>/<凭证>/index.html，相对路径自然解析；"/assets/x.js" 这种站点绝对路径按 Referer 里的凭证找回来。
// "../assets/x.css"（页面在子目录、资源在上级，生成的网站常这样）会被浏览器规整成 /assets/x.css，同样走 Referer；
// 这两种在页面目录里找不到时往上逐级找，最多 UP_LEVELS 层，每层照样过 safeFilePath 和真实路径检查
const UP_LEVELS = 3;
const PREVIEW = { server: null, port: 0, starting: null, caps: new Map() };
function previewStart() {
  if (PREVIEW.port) return Promise.resolve(PREVIEW.port);
  if (PREVIEW.starting) return PREVIEW.starting;
  PREVIEW.starting = new Promise((resolve, reject) => {
    const srv = http.createServer(previewServe);
    srv.on("error", (e) => { PREVIEW.starting = null; reject(e); });
    srv.listen(0, "127.0.0.1", () => { PREVIEW.server = srv; PREVIEW.port = srv.address().port; resolve(PREVIEW.port); });
  });
  return PREVIEW.starting;
}
async function previewGrant(p) {
  const r = safeFilePath(p);
  if (r.error) return r;
  const port = await previewStart();
  const now = Date.now();
  for (const [k, v] of PREVIEW.caps) if (v.exp < now) PREVIEW.caps.delete(k);
  const root = path.dirname(r.file);
  let cap = [...PREVIEW.caps].find(([, v]) => v.root === root)?.[0];   // 同一目录复用，刷新不换网址
  if (!cap) { cap = crypto.randomBytes(12).toString("hex"); if (PREVIEW.caps.size >= 200) PREVIEW.caps.delete(PREVIEW.caps.keys().next().value); }
  PREVIEW.caps.set(cap, { root, exp: now + 12 * 3600e3 });
  return { url: `http://localhost:${port}/${cap}/${path.basename(r.file).split("/").map(encodeURIComponent).join("/")}`, mtime: r.mtime };
}
function previewServe(req, res) {
  const fail = (code, msg) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(msg); };
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "read only");
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `localhost:${PREVIEW.port}` && host !== `127.0.0.1:${PREVIEW.port}`) return fail(421, "bad host");
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return fail(400, "bad path"); }
  const segs = pathname.split("/").filter(Boolean);
  let cap = segs[0], rel = segs.slice(1), viaRef = false;
  if (!PREVIEW.caps.has(cap)) {
    // 站点绝对路径（/assets/x.js）或规整后的 ../：从引用它的页面找回凭证
    let ref = ""; try { ref = new URL(String(req.headers.referer || "")).pathname.split("/")[1] || ""; } catch {}
    if (!PREVIEW.caps.has(ref)) return fail(404, "preview expired — reopen the file");
    cap = ref; rel = segs; viaRef = true;
  }
  const g = PREVIEW.caps.get(cap);
  if (g.exp < Date.now()) { PREVIEW.caps.delete(cap); return fail(404, "preview expired — reopen the file"); }
  // 在 base 下找 rel：字面路径和解析过符号链接的真实路径都得在 base 里
  const lookup = (base) => {
    let full = path.resolve(base, ...rel);
    if (full !== base && !full.startsWith(base + path.sep)) return { status: 403, error: "outside preview folder" };
    try { if (fs.statSync(full).isDirectory()) full = path.join(full, "index.html"); } catch {}
    const r = safeFilePath(full);
    if (r.error) return r;
    if (r.file !== base && !r.file.startsWith(base + path.sep)) return { status: 403, error: "outside preview folder" };
    return r;
  };
  let r = lookup(g.root);
  for (let base = g.root, i = 0; viaRef && r.error && i < UP_LEVELS; i++) {
    const up = path.dirname(base);
    if (up === base || up === "/") break;
    base = up;
    const t = lookup(base);
    if (!t.error) r = t;
  }
  if (r.error) return fail(r.status || 404, r.error);
  const head = { "content-type": MIME[path.extname(r.file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
  // 音视频要 Range 才能拖进度
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  let start = 0, end = r.size - 1, code = 200;
  if (m && r.size) {
    start = m[1] ? +m[1] : Math.max(0, r.size - +m[2]); end = m[1] && m[2] ? Math.min(+m[2], r.size - 1) : r.size - 1;
    if (start > end || start >= r.size) { res.writeHead(416, { "content-range": `bytes */${r.size}` }); return res.end(); }
    code = 206; head["content-range"] = `bytes ${start}-${end}/${r.size}`;
  }
  head["content-length"] = r.size ? end - start + 1 : 0;
  res.writeHead(code, head);
  if (req.method === "HEAD" || !r.size) return res.end();
  const st = fs.createReadStream(r.file, { start, end });
  st.on("error", () => { try { res.destroy(); } catch {} });
  st.pipe(res);
}

// ── 路由：/api/preview ──
export async function routePreview(req, res, u, p) {
  // ── 回复里的路径被点了：先问一下是什么（文件 / 目录 / 不存在），前端再决定开查看器还是文件面板 ──
  if (req.method === "POST" && p === "/api/preview") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const r = await previewGrant(b.path);
    return sendJson(res, r.error ? r.status || 404 : 200, r);
  }
  return NEXT;
}
