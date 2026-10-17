// 从某个工具包 Release 的 devkit.lock.json 摘出 APK 要带的那几项，写成 devkit-pin.json。
// APK 首装（尤其从镜像下）和认本地文件都拿它当准：校验值跟着 APK 走，不靠下载来源。
//   node scripts/pin-devkit.mjs <Release 目录 URL> <输出文件>
// 换工具包版本时：改 devkit-sources.txt，再跑一次这个，两个文件一起提交。build.sh 会核对两者是同一版。
import fs from "node:fs";
const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error("用法: node pin-devkit.mjs <base/> <out.json>"); process.exit(2); }
const r = await fetch(base.replace(/\/?$/, "/") + "devkit.lock.json", { redirect: "follow" });
if (!r.ok) { console.error(`✗ 取不到清单：HTTP ${r.status}`); process.exit(1); }
const lock = await r.json();
const tag = (base.match(/\/download\/([^/]+)\/?$/) || [])[1] || "";
const pick = (o) => o && { file: o.file, sha256: o.sha256, bytes: o.bytes };
const pin = { tag, base: base.replace(/\/?$/, "/"), target: lock.target, compat: lock.compat ?? 1, gz: pick(lock.gz), tar: pick(lock.tar) };
if (!pin.gz || !/^[0-9a-f]{64}$/.test(pin.gz.sha256 || "")) { console.error("✗ 清单里没有 gz 的 sha256"); process.exit(1); }
fs.writeFileSync(out, JSON.stringify(pin, null, 1) + "\n");
console.log(`✓ ${out}：${tag} gz ${pin.gz.sha256.slice(0, 12)}…`);
