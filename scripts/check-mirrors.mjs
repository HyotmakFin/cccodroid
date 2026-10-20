#!/usr/bin/env node
// 核对 cccodroid.net 上的镜像是否跟得上：Claude Code 版本号三处一致、组件包在 dl.cccodroid.net 上都在且大小对。
// 只读，不验签（验签由客户端和生成器负责），用来发版前或出问题时快速看一眼。用法：node scripts/check-mirrors.mjs
const get = async (url, method = "GET") => {
  const r = await fetch(url, { method, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
};
let bad = 0;

for (const ch of ["stable", "latest"]) {
  const v = await Promise.all([
    "https://downloads.claude.ai/claude-code-releases", "https://cccodroid.net/claude-code", "https://dl.cccodroid.net/claude-code",
  ].map(b => get(`${b}/${ch}`).then(r => r.text()).then(t => t.trim(), e => "取不到(" + e.message + ")")));
  const same = v.every(x => x === v[0]);
  if (!same) bad++;
  console.log(`${same ? "✓" : "✗"} Claude Code ${ch}：官方 ${v[0]} / cccodroid.net ${v[1]} / dl ${v[2]}`);
  if (same) for (const b of ["https://cccodroid.net/claude-code", "https://dl.cccodroid.net/claude-code"])
    for (const f of ["manifest.json", "manifest.json.sig"])
      await get(`${b}/${v[0]}/${f}`, "HEAD").catch(e => { bad++; console.log("✗", e.message); });
}

for (const name of ["official", "community"]) {
  let comps;
  try {
    const j = await (await get(`https://cccodroid.net/components/${name}/components.json`)).json();
    comps = Array.isArray(j.components) ? j.components : Object.entries(j.components).map(([id, c]) => ({ id, ...c }));
  } catch (e) { bad++; console.log(`✗ ${name} 索引：${e.message}`); continue; }
  let n = 0, miss = 0;
  for (const c of comps) for (const b of c.builds || []) {
    const asset = b.asset || String(b.url || "").split("/").pop();
    if (!/^https:\/\/github\.com\//.test(b.url || "") || !(b.bytes > 0)) continue;
    n++;
    try {
      const len = +(await get(`https://dl.cccodroid.net/components/${name}/${asset}`, "HEAD")).headers.get("content-length");
      if (len !== b.bytes) throw new Error(`大小 ${len} ≠ ${b.bytes}`);
    } catch (e) { miss++; console.log(`✗ ${name}/${asset}：${e.message}`); }
  }
  if (miss) bad++;
  console.log(`${miss ? "✗" : "✓"} 组件包 ${name}：${n - miss}/${n}`);
}
process.exit(bad ? 1 : 0);
