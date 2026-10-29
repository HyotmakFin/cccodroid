import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PREFIX } from "./config.mjs";

// ── 访问控制 ──────────────────────────────────────────────────────────
// 只监听 127.0.0.1 在安卓上不是安全边界：同机任何有联网权限的应用都能连 127.0.0.1，
// 手机浏览器里的网页也能向它发"简单请求"（text/plain 的 POST 不触发 CORS 预检）。
// 而 /api/chat 等于本机任意命令执行，经 priv 还能拿到 Shizuku 的 shell 身份。所以：
//   1. Host 必须是 127.0.0.1:端口 / localhost:端口 —— 挡 DNS 重绑定；
//   2. 带 Origin 的请求必须来自本页 —— 挡网页跨站发请求；
//   3. /api/* 必须带令牌：X-CC-Token 头，或 cc_t_<端口> Cookie（宿主 WebView 首次加载首页时带 ?t=令牌 换来）。
//      令牌在应用私有目录里（0600），别的应用读不到；首页带对 ?t= 时种一个 HttpOnly + SameSite=Strict 的 Cookie，
//      之后界面的 fetch / EventSource / <img src> 都自动带上，前端不用改。
//   令牌跨网关重启保持不变；删掉文件即轮换。Cookie 的值见下面 SESSION。
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
// ── 界面专用地址（GHSA-hwmm 第 1 项）──
// Cookie 不按端口隔离：种在 127.0.0.1 上，内置浏览器打开同机别的应用起的 127.0.0.1:任意端口、或者回复里一张
// <img src="http://127.0.0.1:端口/…">，Cookie 都会跟着送过去，对方拿到就能用原生客户端重放 /api/*。
// cccodroid 的界面因此改走 127.0.0.2（同样是回环，网关两个地址都听），会话 Cookie 只认这个地址上来的请求；
// App 那边把内置浏览器里这个地址的所有端口、界面里这个地址的其他端口全拦掉，Cookie 就送不到别人手里。
// 开发端的外壳还是 127.0.0.1，照旧
export const UI_HOST = "127.0.0.2";
const UI_HOSTPORT = `${UI_HOST}:${CFG.port}`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${CFG.port}`, `localhost:${CFG.port}`, UI_HOSTPORT]);
/** 这个请求能不能凭 Cookie 认、能不能种 Cookie：cccodroid 里只有界面专用地址可以 */
export const cookieHostOk = (req) => !PREFIX || String(req.headers.host || "").toLowerCase() === UI_HOSTPORT;
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

function same(t, want) {
  if (typeof t !== "string") return false;
  // 按字节比长度：非 ASCII 的字符串字符数相同、字节数不同，timingSafeEqual 会直接抛错把网关带走
  const a = Buffer.from(t), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const tokenOk = (t) => same(t, TOKEN);

// ── App 自己的请求按次签名（GHSA-hwmm 附录 B）──
// 以前 App 核完身份（有 3 秒缓存）再另开一个连接带上令牌原文：中间这段时间网关要是换了人，令牌就交出去了。
// 现在 App 不发令牌，发 X-CC-Sig: 时间戳.随机数.HMAC(令牌, sig:时间戳:随机数:路径)。冒牌的收到也只能原样转发这一个请求，
// 随机数用过一次就作废，时间戳差一分钟以上也不认
const SIG_SEEN = new Map();
export function sigOk(v, pathAndQuery) {
  const m = /^(\d{10,16})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(v || ""));
  if (!m) return false;
  const now = Date.now(), ts = Number(m[1]);
  if (Math.abs(now - ts) > 60e3) return false;
  if (!same(m[3], crypto.createHmac("sha256", TOKEN).update(`sig:${m[1]}:${m[2]}:${pathAndQuery}`).digest("hex"))) return false;
  if (SIG_SEEN.has(m[2])) return false;
  SIG_SEEN.set(m[2], now);
  if (SIG_SEEN.size > 2000) for (const [k, t] of SIG_SEEN) if (now - t > 120e3 || SIG_SEEN.size > 2000) SIG_SEEN.delete(k); else break;
  return true;
}

// ── 证明「我是真网关」（审查 S1）──
// 安卓上 127.0.0.1 的端口全机共享：网关没起来（开机、崩溃后重拉的空档）时别的应用能先占住 8791。
// 以前 App 只看端口上有没有人答话，就把令牌头、带 ?t=&k= 的首页地址交过去。现在 App 先发一个随机数 n，
// 真网关用令牌算 HMAC 回过来（令牌只在双方私有目录里，冒牌的算不出），过了才交凭据。
// BOOT 是这次启动的编号，一并算进去，App 据此知道网关换过了没有。
export const BOOT = crypto.randomBytes(16).toString("hex");
const mac = (s) => crypto.createHmac("sha256", TOKEN).update(s).digest("hex");
export function proof(n) {
  return /^[0-9a-f]{32,128}$/.test(String(n || "")) ? `${BOOT} ${mac(`proof:${n}:${BOOT}`)}` : null;
}
// 界面的页面与静态资源由 App 在原生层代取（MainActivity.shouldInterceptRequest，审查 10-29 第六份 中3）：
// App 带一个随机数 X-CC-Nonce，这里用令牌对「随机数 + 请求行 + 内容哈希」算 HMAC 放在 X-CC-Mac 里回去。
// 网关没起来的空档里抢占端口的应用算不出来，它给的页面和脚本 App 一律不交给 WebView
export function staticMac(nonce, url, body) {
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ""))) return null;
  return mac(`static:${nonce}:${url}:${crypto.createHash("sha256").update(body).digest("hex")}`);
}
// cccodroid 里 Cookie 不用令牌本身，用按这次启动派生的会话值：会话中途网关挂了、端口被抢，
// 界面重连时送出去的 Cookie 到了下一个真网关就作废。网关重启后 App 按新的 BOOT 种上新 Cookie（Env.proveGateway），
// 界面的事件总线 2 秒一重连，自己就接上了。开发端照旧用令牌：gw-swap 热换网关时界面不能掉线
export const SESSION = PREFIX ? mac("cookie:" + BOOT) : TOKEN;
const sessionOk = (t) => same(t, SESSION);
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
  if (req.headers["x-cc-sig"] && sigOk(req.headers["x-cc-sig"], String(req.url || ""))) return null;   // 按请求行原样比，不经 URL 规范化
  // 凭 Cookie 的：浏览器标明是别的源发起的就不认。SameSite 不看端口，内置浏览器里开的本机页面（127.0.0.1:3000 之类）
  // 发的 <img> / no-cors 请求不带 Origin、却会带上 Cookie（审查 H7）。界面自己的请求是 same-origin；
  // 地址栏直接打开是 none；claude、curl 这类不发这个头
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return 403;
  if (cookieHostOk(req) && sessionOk(cookieToken(req))) return null;
  return 403;
}
