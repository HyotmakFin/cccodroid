#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  contrast.mjs —— 主题对比度检查：3 套外观（原生 / 求索 / 逐月）× 深浅，逐对算 WCAG 对比度
//
//  用法:  node scripts/contrast.mjs            有 FAIL 退出码 1；WARN 只提示
//         node scripts/contrast.mjs --all      连通过的也列出来
//  做法:  解析 gateway/web/style.css 里定义主题变量的那几种选择器（:root、html[data-theme="light"]、
//         html[data-skin=…]、html[data-skin=…][data-theme="light"]），按特异性 + 先后顺序叠出每种组合的变量表；
//         var()、color-mix(in srgb …)、半透明（叠在所在的底上）都照算。再按下面 PAIRS 里「什么字压在什么底上」核：
//         正文 4.5、次要提示 3、强调色当字（链接）3 —— 低于下限 FAIL，低于 4.5 WARN。
//  另外列出样式里写死的白 / 黑（#fff、#000、white、rgba(255,255,255…) 等）：换主题时它们不跟着变，
//  确实要写死的在同一行加注释 /* 对比度：固定 */ 就不再报。
//  加主题、改配色后先跑一遍。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CSS = path.join(ROOT, "gateway/web/style.css");
const ALL = process.argv.includes("--all");
const src = fs.readFileSync(CSS, "utf8");
const SKINS = ["native", "qiusuo", "zhuyue"], MODES = ["dark", "light"];

// ── 解析：顶层和 @media 里的规则块（主题变量只认没有媒体条件的） ──
const lineOf = (i) => src.slice(0, i).split("\n").length;
function rules() {
  const out = [];
  const s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));   // 去注释、保留行号
  let i = 0, depth = 0, start = 0, media = [];
  while (i < s.length) {
    const c = s[i];
    if (c === "{") {
      const sel = s.slice(start, i).trim();
      if (sel.startsWith("@")) { media.push(depth); depth++; start = i + 1; i++; continue; }
      const end = s.indexOf("}", i);
      out.push({ sel, body: s.slice(i + 1, end), at: i + 1, inMedia: media.length > 0 });
      i = end + 1; start = i; continue;
    }
    if (c === "}") { depth--; if (media.length && media[media.length - 1] === depth) media.pop(); start = i + 1; }
    i++;
  }
  return out;
}
const RULES = rules();
// 选择器对某个组合是否命中、特异性多少（只认主题变量那几种写法）
function match(sel, skin, mode) {
  const m = sel.match(/^(?::root|html((?:\[data-(?:skin|theme)="[^"]+"\])*))$/);
  if (!m) return -1;
  if (sel === ":root") return 0;
  const attrs = [...(m[1] || "").matchAll(/\[data-(skin|theme)="([^"]+)"\]/g)];
  for (const [, k, v] of attrs) if ((k === "skin" && v !== skin) || (k === "theme" && v !== mode)) return -1;
  return 1 + attrs.length;
}
function varsFor(skin, mode) {
  const hits = [];
  for (const r of RULES) {
    if (r.inMedia) continue;
    for (const one of r.sel.split(",").map((x) => x.trim())) {
      const sp = match(one, skin, mode);
      if (sp >= 0) hits.push({ sp, r });
    }
  }
  hits.sort((a, b) => a.sp - b.sp || a.r.at - b.r.at);
  const v = {};
  for (const { r } of hits) for (const d of r.body.split(";")) {
    const m = d.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) v[m[1]] = m[2];
  }
  return v;
}

// ── 颜色 ──
const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
function split(args) { const out = []; let d = 0, cur = ""; for (const c of args) { if (c === "(") d++; if (c === ")") d--; if (c === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += c; } out.push(cur.trim()); return out; }
function color(str, V, seen = new Set()) {
  str = String(str).trim();
  let m;
  if ((m = str.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/))) {
    if (seen.has(m[1])) return null;
    if (V[m[1]] != null) return color(V[m[1]], V, new Set([...seen, m[1]]));
    return m[2] ? color(m[2], V, seen) : null;
  }
  if (NAMED[str]) return NAMED[str];
  if ((m = str.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1]; if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  if ((m = str.match(/^rgba?\(([^)]*)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  if ((m = str.match(/^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/))) {
    const [a, b] = split(m[1]).map((x) => { const q = x.match(/^([\s\S]*?)\s+([\d.]+)%$/); return q ? { c: q[1], p: +q[2] } : { c: x, p: null }; });
    let pa = a.p, pb = b.p;
    if (pa == null && pb == null) pa = pb = 50; else if (pa == null) pa = 100 - pb; else if (pb == null) pb = 100 - pa;
    const ca = color(a.c, V, seen), cb = color(b.c, V, seen);
    if (!ca || !cb) return null;
    const t = pa / (pa + pb);
    // 预乘 alpha 插值（和浏览器一致）
    const al = ca[3] * t + cb[3] * (1 - t);
    if (!al) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (ca[i] * ca[3] * t + cb[i] * cb[3] * (1 - t)) / al).concat(al);
  }
  return null;
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// ── 要核的组合：[字, 底, 下限, 说明] ──
const BODY = 4.5, MINOR = 3;
const PAIRS = [
  ["--fg", "--bg", BODY, "正文"], ["--fg", "--bg2", BODY, "正文 / 卡片"], ["--fg", "--bg3", BODY, "正文 / 选中底"],
  ["--fg", "--panel", BODY, "设置面板"], ["--fg", "--user-bg", BODY, "用户气泡"], ["--fg", "--code-bg", BODY, "代码块"],
  ["--fg", "--tool-bg", BODY, "工具卡"], ["--fg", "--input-bg", BODY, "输入框"],
  ["--strong", "--bg", BODY, "加粗"], ["--fg2", "--bg", BODY, "次要文字"], ["--fg2", "--bg2", BODY, "次要文字 / 卡片"],
  ["--fg2", "--bg3", MINOR, "次要文字 / 选中底"],
  ["--fg3", "--bg", MINOR, "提示文字"], ["--fg3", "--bg2", MINOR, "提示文字 / 卡片"],
  // 按钮字是粗体，强调色是各套外观的品牌色（原生陶土橙、求索蓝），按 UI 组件 3 的下限，低于 4.5 照样 WARN
  ["--on-accent", "--accent", MINOR, "强调色按钮上的字"],
  ["--accent", "--bg", MINOR, "强调色当字（链接）"], ["--accent", "--bg2", MINOR, "强调色当字 / 卡片"],
  ["--ok", "--bg", MINOR, "成功"], ["--err", "--bg", MINOR, "出错"], ["--warn", "--bg", MINOR, "警告"],
  ["--tool", "--bg", MINOR, "工具名"], ["--purple", "--bg", MINOR, "紫色标记"],
  ["--err-fg", "--err-bg", BODY, "错误框"], ["--think-ink", "--bg", MINOR, "思考标题"],
  // 上下文条的字（#ctxtxt）平常是 --fg2，进度条只有一截、在条的左边；快满 / 满了时字压在暖色 / 红色上，
  // 改用 --fg 加一圈 --bg 描边（style.css #ctxbar.warn #ctxtxt），所以那时核的是 --fg 对 --bg（上面正文那条）
  ["--fg2", "--bg2", MINOR, "上下文条的字"],
];

let fail = 0, warn = 0;
for (const skin of SKINS) for (const mode of MODES) {
  const V = varsFor(skin, mode), rows = [];
  for (const [f, b, min, what] of PAIRS) {
    if (V[f] == null || V[b] == null) continue;
    const bg = color(`var(${b})`, V), fg0 = color(`var(${f})`, V);
    if (!bg || !fg0) { rows.push(`  ?    ${what}：${f} on ${b} 算不出来（${V[f]} / ${V[b]}）`); continue; }
    const base = color("var(--bg)", V) || [0, 0, 0, 1];
    const bgS = over(bg, base), fg = over(fg0, bgS), r = ratio(fg, bgS);
    const tag = r < min ? "FAIL" : r < BODY ? "WARN" : "ok  ";
    if (tag === "FAIL") fail++; else if (tag === "WARN") warn++;
    if (tag !== "ok  " || ALL) rows.push(`  ${tag} ${r.toFixed(2).padStart(5)}  ${what}：${f} ${hex(fg)} on ${b} ${hex(bgS)}（下限 ${min}）`);
  }
  console.log(`▸ ${skin} · ${mode === "dark" ? "深色" : "浅色"}` + (rows.length ? "" : "  全部通过"));
  for (const r of rows) console.log(r);
}

// ── 写死的白 / 黑 ──
const HARD = /(?<![\w-])(?:#fff(?:fff)?|#000(?:000)?|white|black|rgba?\(\s*(?:255\s*,\s*255\s*,\s*255|0\s*,\s*0\s*,\s*0)\b[^)]*\))(?![\w-])/gi;
const hard = [];
src.split("\n").forEach((line, i) => {
  if (/对比度：固定/.test(line)) return;
  const code = line.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const decl of code.split(/[;{}]/)) {
    const m = decl.match(/^\s*([\w-]+)\s*:\s*([\s\S]*)$/);
    if (!m || m[1].startsWith("--")) continue;   // 变量定义是主题表本身，不算
    if (/^var\(/.test(m[2].trim())) continue;   // var(--x, 兜底)：兜底只在变量缺失时用
    if (!/^(color|background|background-color|border(-\w+)?(-color)?|fill|stroke|outline(-color)?|caret-color)$/.test(m[1])) continue;
    if (HARD.test(m[2])) hard.push(`  ${String(i + 1).padStart(5)}  ${m[1]}: ${m[2].trim().slice(0, 90)}`);
    HARD.lastIndex = 0;
  }
});
console.log(`▸ 写死的白 / 黑：${hard.length} 处` + (hard.length ? "（换主题不跟着变；确实要固定的，行尾加 /* 对比度：固定 */）" : ""));
for (const h of hard) console.log(h);
console.log(`\n${fail ? "✗" : "✓"} FAIL ${fail} · WARN ${warn} · 写死 ${hard.length}`);
process.exit(fail ? 1 : 0);
