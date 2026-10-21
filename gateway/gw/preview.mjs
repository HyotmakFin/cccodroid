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
// 网址形如 http://localhost:<端口>/<凭证>/index.html，相对路径自然解析；"/assets/x.js" 这种站点绝对路径按 Referer 里的凭证找回来
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
  let cap = segs[0], rel = segs.slice(1);
  if (!PREVIEW.caps.has(cap)) {
    // 站点绝对路径（/assets/x.js）：从引用它的页面找回凭证
    let ref = ""; try { ref = new URL(String(req.headers.referer || "")).pathname.split("/")[1] || ""; } catch {}
    if (!PREVIEW.caps.has(ref)) return fail(404, "preview expired — reopen the file");
    cap = ref; rel = segs;
  }
  const g = PREVIEW.caps.get(cap);
  if (g.exp < Date.now()) { PREVIEW.caps.delete(cap); return fail(404, "preview expired — reopen the file"); }
  let full = path.resolve(g.root, ...rel);
  if (full !== g.root && !full.startsWith(g.root + path.sep)) return fail(403, "outside preview folder");
  try { if (fs.statSync(full).isDirectory()) full = path.join(full, "index.html"); } catch {}
  const r = safeFilePath(full);
  if (r.error) return fail(r.status || 404, r.error);
  // 上面比的是字面路径；目录里的符号链接能指到外面去，解析过的真实路径也得在预览目录里
  if (r.file !== g.root && !r.file.startsWith(g.root + path.sep)) return fail(403, "outside preview folder");
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
