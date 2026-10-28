// 老内核的样式兜底：Chrome 104 一档的 WebView（不少国产 ROM 自带、又不走 Play 更新）没有 :has()、@container、color-mix()，
// 用到它们的规则在这些内核上整条作废 —— 子代理列表里待批准的权限藏在折叠里点不到、整页在手机上按宽屏排、转圈和差异底色没了。
// theme.js 检测到不支持才加载本文件，新内核不碰。做法：读原始 style.css，把这三类规则改写成老内核认的样子，插在后面：
//   @container (…) → @media (…)        容器在手机上基本就是整屏宽，近似成立
//   X:has(Y)        → X[data-cch<n>]    哪些元素该命中由这里用 querySelector 算，DOM 一变就重算
//   color-mix(…)    → 算好的 rgba        变量按当前外观取值，换外观 / 强调色时重算
(() => {
  const HAS = CSS.supports("selector(:has(a))");
  const MIX = CSS.supports("color", "color-mix(in srgb, red 50%, blue)");
  const CQ = CSS.supports("container-type", "inline-size");
  if (HAS && MIX && CQ) return;
  const root = document.documentElement;

  // ── 把样式表拆成规则树：{ sel, body } 或 { at, items } ──
  function parse(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      for (; j < text.length && depth; j++) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; }
      const inner = text.slice(open + 1, j - 1);
      if (head.startsWith("@") && /^@(media|container|supports)\b/.test(head)) out.push({ at: head, items: parse(inner) });
      else if (head.startsWith("@")) { /* @keyframes / @font-face 之类原样有效，不管 */ }
      else out.push({ sel: head, body: inner });
      i = j;
    }
    return out;
  }
  // 顶层逗号切分（括号里的逗号不算）
  function splitTop(s) {
    const out = [];
    let d = 0, last = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === "(") d++; else if (c === ")") d--;
      else if (c === "," && !d) { out.push(s.slice(last, k)); last = k + 1; }
    }
    out.push(s.slice(last));
    return out.map((x) => x.trim()).filter(Boolean);
  }
  // 从 s[at] 的 "(" 找到配对的 ")"
  function closeOf(s, at) {
    let d = 0;
    for (let k = at; k < s.length; k++) { if (s[k] === "(") d++; else if (s[k] === ")" && !--d) return k; }
    return -1;
  }

  // ── :has() ──
  const SPECS = [];   // { anchor, args, attr }
  function stripHas(sel) {
    let s = sel, k;
    while ((k = s.indexOf(":has(")) >= 0) {
      const notAt = s.lastIndexOf(":not(", k);
      const wrapped = notAt >= 0 && notAt + 5 === k;
      const end = closeOf(s, k + 4);
      if (end < 0) return s;
      s = wrapped ? s.slice(0, notAt) + s.slice(end + 2) : s.slice(0, k) + s.slice(end + 1);
    }
    return s;
  }
  function rewriteHas(sel) {
    let s = sel, k;
    while ((k = s.indexOf(":has(")) >= 0) {
      const end = closeOf(s, k + 4);
      if (end < 0) break;
      const args = s.slice(k + 5, end);
      const notAt = s.lastIndexOf(":not(", k);
      const wrapped = notAt >= 0 && notAt + 5 === k && s[end + 1] === ")";
      const from = wrapped ? notAt : k;
      // 挂在哪个元素上：往前找到顶层的空白或组合符，之间那段复合选择器就是它
      let d = 0, b = from - 1;
      for (; b >= 0; b--) { const c = s[b]; if (c === ")") d++; else if (c === "(") d--; else if (!d && /[\s>+~]/.test(c)) break; }
      const anchor = stripHas(s.slice(0, from)).trim() || "*";
      const attr = "data-cch" + SPECS.length;
      SPECS.push({ anchor, args: splitTop(args), attr });
      s = s.slice(0, from) + (wrapped ? `:not([${attr}])` : `[${attr}]`) + s.slice(wrapped ? end + 2 : end + 1);
    }
    return s;
  }
  function evalHas() {
    for (const sp of SPECS) {
      let els;
      try { els = document.querySelectorAll(sp.anchor); } catch { continue; }
      const now = new Set();
      for (const el of els) {
        const hit = sp.args.some((a) => { try { return !!el.querySelector(/^[>+~]/.test(a) ? ":scope " + a : a); } catch { return false; } });
        if (hit) { now.add(el); if (!el.hasAttribute(sp.attr)) el.setAttribute(sp.attr, ""); }
      }
      for (const el of document.querySelectorAll(`[${sp.attr}]`)) if (!now.has(el)) el.removeAttribute(sp.attr);
    }
  }

  // ── color-mix() ──
  let probe = null;
  function rgba(v, ctx) {
    v = v.trim();
    for (let n = 0; n < 5 && v.includes("var("); n++) {
      v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (m, name, fb) => getComputedStyle(ctx).getPropertyValue(name).trim() || (fb || "").trim());
    }
    if (/currentcolor/i.test(v) || !v) return null;
    if (v.includes("color-mix(")) v = resolveMix(v, ctx);
    if (!v) return null;
    if (!probe) { probe = document.createElement("i"); probe.style.display = "none"; root.appendChild(probe); }
    probe.style.color = "";
    probe.style.color = v;
    if (!probe.style.color) return null;
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  // color-mix(in srgb, A p%, B [q%])：按规范在预乘 alpha 下线性混合
  function mixOne(args, ctx) {
    const parts = splitTop(args);
    if (parts.length !== 3 || !/^in\s+srgb$/i.test(parts[0])) return null;
    const pick = (s) => { const m = /^(.*?)\s+([\d.]+)%$/.exec(s); return m ? [m[1], parseFloat(m[2]) / 100] : [s, null]; };
    let [a, pa] = pick(parts[1]), [b, pb] = pick(parts[2]);
    if (pa == null && pb == null) pa = 0.5;
    if (pa == null) pa = 1 - pb;
    const A = rgba(a, ctx), B = rgba(b, ctx);
    if (!A || !B) return null;
    const al = A[3] * pa + B[3] * (1 - pa);
    if (!al) return "rgba(0,0,0,0)";
    const ch = (k) => Math.round((A[k] * A[3] * pa + B[k] * B[3] * (1 - pa)) / al);
    return `rgba(${ch(0)},${ch(1)},${ch(2)},${+al.toFixed(3)})`;
  }
  function resolveMix(v, ctx) {
    let k;
    while ((k = v.indexOf("color-mix(")) >= 0) {
      const end = closeOf(v, k + 9);
      if (end < 0) return null;
      const r = mixOne(v.slice(k + 10, end), ctx);
      if (!r) return null;
      v = v.slice(0, k) + r + v.slice(end + 1);
    }
    return v;
  }
  // 只留带 color-mix 的声明并算好；算不出（currentColor 之类）就丢掉，和老内核原本的表现一样
  function mixDecls(body, sel) {
    let ctx = root;
    try { const el = document.querySelector(sel.replace(/::?[\w-]+(\([^)]*\))?/g, "")); if (el) ctx = el; } catch {}
    const out = [];
    for (const d of body.split(/;(?![^(]*\))/)) {
      if (!d.includes("color-mix(")) continue;
      const c = d.indexOf(":");
      if (c < 0) continue;
      const val = resolveMix(d.slice(c + 1).replace(/!important/, ""), ctx);
      if (val) out.push(d.slice(0, c).trim() + ":" + val + (/!important/.test(d) ? " !important" : ""));
    }
    return out.join(";");
  }

  // ── 生成 ──
  let tree = [];
  const style = document.createElement("style");
  style.id = "compat-old";
  function emit(items, whole) {
    let css = "";
    for (const it of items) {
      if (it.at) {
        const isCq = it.at.startsWith("@container");
        if (isCq && CQ) continue;
        const inner = emit(it.items, whole || isCq);
        if (inner) css += (isCq ? it.at.replace(/^@container\s*[\w-]*\s*/, "@media ") : it.at) + "{" + inner + "}\n";
        continue;
      }
      const hasHas = !HAS && it.sel.includes(":has(");
      const mustWhole = whole || hasHas;      // 整条在老内核上作废了：整条补
      let sel = it.sel;
      if (hasHas) sel = splitTop(sel).map((x) => (x.includes(":has(") ? (it.cache || (it.cache = {}))[x] || (it.cache[x] = rewriteHas(x)) : x)).join(",");
      let body = it.body;
      if (!MIX && body.includes("color-mix(")) {
        const mixed = mixDecls(body, sel);
        body = mustWhole ? body.split(/;(?![^(]*\))/).filter((d) => !d.includes("color-mix(")).join(";") + (mixed ? ";" + mixed : "") : mixed;
      } else if (!mustWhole) continue;
      if (body.trim()) css += sel + "{" + body + "}\n";
    }
    return css;
  }
  // 内容没变就别写：写了会触发下面盯着 <head> 的观察器，又回到这里
  function paint() { const css = emit(tree, false); if (style.textContent !== css) style.textContent = css; }
  function build() { paint(); evalHas(); }

  let raf = 0;
  const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; evalHas(); }); };
  fetch("/style.css").then((r) => r.text()).then((text) => {
    tree = parse(text.replace(/\/\*[\s\S]*?\*\//g, ""));
    document.head.appendChild(style);
    build();
    if (!HAS) new MutationObserver(later).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "open"] });
    // 换外观 / 深浅 / 强调色：color-mix 里的变量变了，重算
    if (!MIX) {
      let t = 0;
      const again = () => { clearTimeout(t); t = setTimeout(paint, 50); };
      new MutationObserver(again).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-skin", "style"] });
      new MutationObserver(again).observe(document.head, { childList: true, subtree: true, characterData: true });
    }
  }).catch((e) => console.warn("[cc] compat-old", e));
})();
