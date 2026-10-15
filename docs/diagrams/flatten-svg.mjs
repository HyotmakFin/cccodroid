// 把 Archify 导出的 SVG 化简成 resvg 能吃的：node flat.mjs in.svg out.svg
//   · 选择器按当前主题化简：:is(…) 挑匹配当前主题的那支，别的主题的规则丢掉，:not(…) 去掉
//   · CSS 变量代入成具体值；color-mix(in srgb, …) 算成具体颜色
import fs from "node:fs";
const [src, out] = process.argv.slice(2);
let s = fs.readFileSync(src, "utf8");
const theme = /data-theme="(\w+)"/.exec(s)[1], other = theme === "dark" ? "light" : "dark";
const preset = (/data-preset="([\w-]+)"/.exec(s) || [])[1] || "classic";
const splitTop = (x) => { const r = []; let d = 0, cur = ""; for (const ch of x) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { r.push(cur); cur = ""; } else cur += ch; } r.push(cur); return r.map((y) => y.trim()).filter(Boolean); };
function simplify(sel) {
  sel = sel.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  // :is(a, b) → 选匹配当前主题的一支；都不带主题就选第一支
  for (let i = 0; i < 5 && sel.includes(":is("); i++) sel = sel.replace(/:is\(((?:[^()]|\([^()]*\))*)\)/, (_, inner) => {
    const alts = splitTop(inner);
    return alts.find((a) => a.includes(`data-theme="${theme}"`)) || alts.find((a) => !a.includes("data-theme")) || alts[0];
  });
  if (sel.includes(`data-theme="${other}"`)) return null;
  if (/data-preset="/.test(sel) && !sel.includes(`data-preset="${preset}"`)) return null;
  return sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").replace(new RegExp(`\\[data-theme="${theme}"\\]`, "g"), "")
    .replace(new RegExp(`\\[data-preset="${preset}"\\]`, "g"), "").replace(/\[data-node-ui\]/g, "").replace(/(^|\s)html\s+/g, "$1").trim() || ":root";
}
const vars = {};
s = s.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (_, attrs, css) => {
  css = css.replace(/([^{}@;]+)\{([^{}]*)\}/g, (m, selList, body) => {
    if (/^\s*@|font-face/.test(selList)) return m;
    const sels = splitTop(selList);
    // 同时列了两个主题的（导出用的覆盖规则）不当主题变量
    const both = selList.includes('data-theme="dark"') && selList.includes('data-theme="light"');
    const keep = sels.map(simplify).filter(Boolean);
    if (!keep.length) return "";
    if (!both && keep.some((k) => k === ":root" || k === "svg")) for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) vars[d[1]] = d[2].trim();
    return `${[...new Set(keep)].join(", ")}{${body}}`;
  });
  return `<style${attrs}>${css}</style>`;
});
for (let i = 0; i < 8 && s.includes("var(--"); i++) s = s.replace(/var\((--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, k, fb) => vars[k] ?? (fb ?? "").trim());
const hex = (h) => { if (h === "black") return [0, 0, 0]; if (h === "white") return [255, 255, 255]; h = h.replace("#", ""); if (h.length === 3) h = [...h].map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
s = s.replace(/color-mix\(in srgb,\s*(#[0-9a-fA-F]{3,6})\s+([\d.]+)%,\s*(#[0-9a-fA-F]{3,6}|black|white)\s*\)/g, (_, a, p, b) => {
  const A = hex(a), B = hex(b), k = p / 100;
  return "#" + A.map((x, i) => Math.round(x * k + B[i] * (1 - k)).toString(16).padStart(2, "0")).join("");
});
s = s.replace(/color-mix\(in srgb,\s*(#[0-9a-fA-F]{3,6})\s+([\d.]+)%,\s*transparent\s*\)/g, (_, a, p) => `rgba(${hex(a).join(", ")}, ${p / 100})`);
// 背景：SVG 自己是透明的（页面给底色），PNG 要自己铺一层
const bg = vars["--bg"] || (theme === "dark" ? "#020617" : "#ffffff");
s = s.replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" fill="${bg}"/>`);
fs.writeFileSync(out, s);
console.log(out, theme, Object.keys(vars).length, "vars; var 剩", (s.match(/var\(--/g) || []).length, "color-mix 剩", (s.match(/color-mix\(/g) || []).length, "bg", bg);
