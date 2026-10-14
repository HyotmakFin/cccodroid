// components-index.mjs —— 把 devkit.mjs component 产出的 component-<id>.json 合成 App 读的 components.json
//
//   node components-index.mjs <输出 components.json> <URL 前缀> <component-<id>.json>...
//
// 每个构建按底座（工具包 gz 的 sha256）区分；已有的 components.json 里别的底座的构建会保留，
// 这样工具包升级前后的用户都能装到匹配自己那一版的组件（livehime 浏览器组件同一个思路）。
// 资产文件名：<id>-<版本>-for-<底座前 12 位>.tar.gz
import fs from "node:fs";
import path from "node:path";

const [out, prefix, ...inputs] = process.argv.slice(2);
if (!out || !prefix || !inputs.length) { console.error("用法: node components-index.mjs <out> <url前缀> <component-x.json>..."); process.exit(1); }
const MAN = JSON.parse(fs.readFileSync(new URL("./devkit.json", import.meta.url), "utf8"));
let idx = { schema: 1, components: {} };
try { idx = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
for (const f of inputs) {
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  const def = MAN.components[c.id] || {};
  const asset = `${c.id}-${c.version}-for-${c.base.gz.slice(0, 12)}.tar.gz`;
  const e = idx.components[c.id] || { builds: [] };
  e.name = def.name || e.name || { zh: c.id, en: c.id };
  e.desc = def.desc || e.desc || null;
  e.builds = e.builds.filter((b) => b.base !== c.base.gz);
  e.builds.unshift({
    base: c.base.gz, version: c.version, upstream: c.upstream,
    url: prefix.replace(/\/?$/, "/") + asset, asset, local: path.join(path.dirname(f), c.gz.file),
    sha256: c.gz.sha256, bytes: c.gz.bytes, installed: c.installed,
    bin: c.bin, skill: c.skill, selftest: c.selftest, packages: c.packages.length,
  });
  idx.components[c.id] = e;
  console.log(`${c.id} ${c.version} → ${asset}（底座 ${c.base.gz.slice(0, 12)}，${(c.gz.bytes / 1048576).toFixed(0)} MB）`);
}
// local 只给发布脚本找文件用，不进最终清单
const pub = JSON.parse(JSON.stringify(idx));
for (const e of Object.values(pub.components)) for (const b of e.builds) delete b.local;
fs.writeFileSync(out, JSON.stringify(pub, null, 1) + "\n");
if (process.env.KEEP_LOCAL) fs.writeFileSync(out + ".local.json", JSON.stringify(idx, null, 1));
