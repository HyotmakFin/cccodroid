import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "./config.mjs";

// ── 访问控制 ──────────────────────────────────────────────────────────
// 只监听 127.0.0.1 在安卓上不是安全边界：同机任何有联网权限的应用都能连 127.0.0.1，
// 手机浏览器里的网页也能向它发"简单请求"（text/plain 的 POST 不触发 CORS 预检）。
// 而 /api/chat 等于本机任意命令执行，经 priv 还能拿到 Shizuku 的 shell 身份。所以：
//   1. Host 必须是 127.0.0.1:端口 / localhost:端口 —— 挡 DNS 重绑定；
//   2. 带 Origin 的请求必须来自本页 —— 挡网页跨站发请求；
//   3. /api/* 必须带令牌：X-CC-Token 头，或 cc_t_<端口> Cookie（宿主 WebView 首次加载首页时带 ?t=令牌 换来）。
//      令牌在应用私有目录里（0600），别的应用读不到；首页带对 ?t= 时种一个 HttpOnly + SameSite=Strict 的 Cookie，
//      之后界面的 fetch / EventSource / <img src> 都自动带上，前端不用改。
//   令牌跨网关重启保持不变（WebView 不会因为网关重启掉线）；删掉文件即轮换。
const TOKEN_FILE = process.env.CCAPP_TOKEN_FILE || path.join(CFG.home, ".gateway-token");
export const TOKEN = (() => {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) { try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {} return t; }
  } catch {}
  const t = crypto.randomBytes(32).toString("hex");
  try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); } catch {}
  const tmp = TOKEN_FILE + ".tmp";
  fs.writeFileSync(tmp, t + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  return t;
})();
// Cookie 不按端口隔离：同一个浏览器里开着两个网关（开发端 8790 + cccodroid 8791）时，同名 Cookie 会互相覆盖，
// 所以名字里带上端口
export const COOKIE = `cc_t_${CFG.port}`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${CFG.port}`, `localhost:${CFG.port}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

export function tokenOk(t) {
  if (typeof t !== "string") return false;
  // 按字节比长度：非 ASCII 的字符串字符数相同、字节数不同，timingSafeEqual 会直接抛错把网关带走
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie || "");
  return m ? m[1] : "";
}
export const denyLog = { at: 0, n: 0 };
/** 返回 null 表示放行；否则返回拒绝的状态码 */
export function denyReason(req, u) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) return 421;
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) return 403;
  if (!u.pathname.startsWith("/api/")) return null;          // 静态页面与资源不含秘密
  if (tokenOk(String(req.headers["x-cc-token"] || ""))) return null;
  // 凭 Cookie 的：浏览器标明是别的源发起的就不认。SameSite 不看端口，内置浏览器里开的本机页面（127.0.0.1:3000 之类）
  // 发的 <img> / no-cors 请求不带 Origin、却会带上 Cookie（审查 H7）。界面自己的请求是 same-origin；
  // 地址栏直接打开是 none；claude、curl 这类不发这个头
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return 403;
  if (tokenOk(cookieToken(req))) return null;
  return 403;
}
