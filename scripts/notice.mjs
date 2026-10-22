#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  notice.mjs —— 发应用内通知（经 cccodroid.net 推给所有用户；App 里显示在顶栏下面的一条横幅）
//
//  node scripts/notice.mjs list
//  node scripts/notice.mjs add --id 20261022-github --zh "标题|正文" --en "Title|Body"
//        [--warn] [--until 2026-11-05] [--from 2026-10-22] [--min-ver 0.3.10] [--max-ver 0.3.11]
//        [--link https://…] [--link-zh "看说明"] [--link-en "Read more"]
//  node scripts/notice.mjs rm <id>            撤下（用户那边下次取到就不再显示）
//  node scripts/notice.mjs publish            只重签、推送、等官网（手改过 notices.json 时用）
//
//  add / rm 之后自动：签名（组件索引那把 ed25519 钥匙，INDEX_SIGNING_KEY_FILE）→ 自验签 → 提交推送 main
//  → 触发官网生成器（SITE_KICK）→ 等 cccodroid.net/notices.json 与本地逐字节一致。
//  App 每 3 小时取一次（打开、切回前台时也会看是否到期），所以推送后最迟几个小时内大家都看得到。
//  写法：一两句话说清「出了什么事、该怎么办」；中英各写各的。内容按纯文本显示，不支持 Markdown。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const F = path.join(ROOT, "notices/notices.json");
const KEYFILE = process.env.INDEX_SIGNING_KEY_FILE || "/data/user/0/li.dsh.claudecli/files/bldtools/index-signing-ed25519.pem";
const SITE = "https://cccodroid.net/notices.json";
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const die = (s) => { console.error("✗ " + s); process.exit(1); };
const git = (...a) => execFileSync("git", ["-c", "safe.directory=*", "-c", "user.name=greyoak111", "-c", "user.email=suny96636@gmail.com", "-C", ROOT, ...a], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATE = /^\d{4}-\d{2}-\d{2}$/, VER = /^\d+\.\d+\.\d+$/;

const load = () => { try { return JSON.parse(fs.readFileSync(F, "utf8")); } catch { return { v: 1, updated: "", notices: [] }; } };
const cmd = argv.shift();

if (cmd === "list" || !cmd) {
  const d = load();
  if (!d.notices.length) console.log("（没有在发的通知）");
  for (const n of d.notices) console.log(`${n.id}  ${n.level || "info"}  ${n.from || ""}~${n.until || ""}  ${n.minVer || ""}~${n.maxVer || ""}\n  ${n.title?.zh}｜${n.body?.zh}\n  ${n.title?.en}｜${n.body?.en}${n.link ? "\n  " + n.link : ""}`);
  if (!cmd) console.log("\n用法见文件开头注释");
  process.exit(0);
}

const d = load();
let msg;
if (cmd === "add") {
  const id = opt("--id"), zh = opt("--zh"), en = opt("--en");
  const n = { id, level: flag("--warn") ? "warn" : "info", from: opt("--from") || new Date().toISOString().slice(0, 10) };
  const until = opt("--until"), minV = opt("--min-ver"), maxV = opt("--max-ver"), link = opt("--link"), lz = opt("--link-zh"), le = opt("--link-en");
  if (!/^[\w.-]{3,60}$/.test(id || "")) die("--id 要 3–60 个字母数字（如 20261022-github）");
  if (d.notices.some((x) => x.id === id)) die(`已有 ${id}：先 rm，或换个 id`);
  if (!zh || !en) die("--zh 和 --en 都要写（「标题|正文」，正文可省）");
  for (const [k, v] of [["--from", n.from], ["--until", until]]) if (v && !DATE.test(v)) die(`${k} 要 YYYY-MM-DD`);
  for (const [k, v] of [["--min-ver", minV], ["--max-ver", maxV]]) if (v && !VER.test(v)) die(`${k} 要 0.3.11 这样的版本号`);
  if (link && !/^https:\/\/[^\s"'<>]+$/.test(link)) die("--link 只收 https 地址");
  const [tz, ...bz] = zh.split("|"), [te, ...be] = en.split("|");
  n.title = { zh: tz.trim(), en: te.trim() };
  n.body = { zh: bz.join("|").trim(), en: be.join("|").trim() };
  if (until) n.until = until;
  if (minV) n.minVer = minV;
  if (maxV) n.maxVer = maxV;
  if (link) { n.link = link; if (lz || le) n.linkText = { zh: lz || "查看详情", en: le || "Details" }; }
  d.notices.unshift(n);
  msg = `通知：${n.title.zh}`;
} else if (cmd === "rm") {
  const id = argv[0];
  if (!d.notices.some((x) => x.id === id)) die(`没有 ${id}`);
  d.notices = d.notices.filter((x) => x.id !== id);
  msg = `撤下通知 ${id}`;
} else if (cmd === "publish") msg = "重签通知";
else die(`不认识的命令 ${cmd}`);

// 过期的顺手清掉，免得文件越积越长
const today = new Date().toISOString().slice(0, 10);
d.notices = d.notices.filter((n) => !n.until || n.until >= today);
d.v = 1;
d.updated = new Date().toISOString();
const body = Buffer.from(JSON.stringify(d, null, 1) + "\n");
const key = crypto.createPrivateKey(fs.readFileSync(KEYFILE, "utf8"));
const sig = crypto.sign(null, body, key).toString("base64");
// 用 App 里那把公钥验一遍：签错钥匙的话，所有用户都会丢弃这份
const pubPem = /-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/=]+)\\n/.exec(fs.readFileSync(path.join(ROOT, "gateway/gw/notices.mjs"), "utf8"))?.[1];
const pub = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${pubPem}\n-----END PUBLIC KEY-----\n`);
if (!crypto.verify(null, body, pub, Buffer.from(sig, "base64"))) die("签出来的和 App 里的公钥对不上");
fs.mkdirSync(path.dirname(F), { recursive: true });
fs.rmSync(F, { force: true }); fs.writeFileSync(F, body);
fs.rmSync(F + ".sig", { force: true }); fs.writeFileSync(F + ".sig", sig + "\n");
for (const f of [F, F + ".sig"]) if (fs.statSync(f).size !== fs.readFileSync(f).length) die(`${f} 大小对不上（/sdcard FUSE），再跑一次 publish`);
console.log(`✓ 已签名：${d.notices.length} 条在发`);

git("add", "notices/notices.json", "notices/notices.json.sig");
git("commit", "-q", "-m", `${msg}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
git("push", "-q", "origin", "HEAD:main");
console.log(`✓ 已推送 ${git("rev-parse", "--short", "HEAD")}`);

if (!process.env.SITE_KICK) console.log("  没给 SITE_KICK：等官网 30 分钟的定时同步");
for (let i = 0; i < 40; i++) {
  // 生成器从 raw.githubusercontent.com 取，那边缓存几分钟：第一次触发可能还拿到旧的，每 5 分钟再触发一次
  if (process.env.SITE_KICK && i % 10 === 0) execFileSync("sh", [process.env.SITE_KICK], { stdio: "inherit" });
  try {
    const r = await fetch(`${SITE}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (r.ok && Buffer.from(await r.arrayBuffer()).equals(body)) { console.log(`✓ ${SITE} 已是这一版。App 最迟 3 小时内取到`); process.exit(0); }
  } catch {}
  await sleep(30000);
}
die(`20 分钟官网还没同步到这一版（看 cccodroid-site.service 的日志）`);
