// ─────────────────────────────────────────────────────────────────────
//  theme.js —— 外观：四套风格（原生 / 求索 / 逐月 / 构成）× 浅色 / 深色 / 跟随系统（无依赖；放在 <head> 里同步加载，避免先闪一下深色）
//
//  设置存在 localStorage["ccapp.theme"]："auto"（默认）| "light" | "dark"，求索风格加前缀 "qs-"，逐月加 "zy-"，构成加 "gc-"。
//  结果写到 <html data-theme="light|dark" data-skin="native|qiusuo|zhuyue|goucheng">，样式只认这两个属性（style.css 里的变量表）。
//
//  「跟随系统」靠什么判断：
//    · 壳里有 CCApp.nightMode() 就以它为准 —— 应用主题固定是深色时，WebView 的
//      prefers-color-scheme 不跟系统走，只有原生层知道系统现在是不是夜间模式；
//      系统切换时壳调用 Theme.system(true|false) 通知这里。
//    · 没有壳（浏览器里打开）就用 matchMedia。
//  定下来以后再告诉壳 CCApp.setBars(dark)，让状态栏 / 导航栏跟着换色。
// ─────────────────────────────────────────────────────────────────────

// ── 原生桥口令（cccodroid 0.4.6 起）：壳的 CCApp 里有副作用的方法第一个参数要带口令，
//    口令只经首页地址 ?k= 交给主框架（存 sessionStorage，刷新还在）。HTML 预览的 iframe 同样被注入了 CCApp，
//    但和界面不同源，拿不到口令，调了也没用。这里把 CCApp 换成自动带口令的一层，其余代码照旧写 CCApp.xxx(…)。
//    放在 theme.js 开头，因为它是第一个碰 CCApp 的脚本。开发端 / 测试壳没有 keyed()，原样不动
(function () {
  const raw = window.CCApp;
  if (!raw || typeof raw.keyed !== "function") return;
  let k = (/[?&]k=([0-9a-f]{32})/.exec(location.search) || [])[1] || "";
  try { if (k) sessionStorage.setItem("cc.bk", k); else k = sessionStorage.getItem("cc.bk") || ""; } catch {}
  const PLAIN = ["hasPane", "paneCanBack", "whatsNew", "nightMode", "keyed"];
  const KEYED = ["openUrl", "paneOpen", "paneBounds", "paneGoBack", "paneClose", "openBrowser", "shareText", "copyText",
    "pickDevkit", "uninstall", "unfreeze", "whatsNewSeen", "setBars", "skinPref", "accentPref", "langPref", "themePref", "saveAs"];
  const w = {};
  for (const m of PLAIN) if (typeof raw[m] === "function") w[m] = (...a) => raw[m](...a);
  for (const m of KEYED) if (typeof raw[m] === "function") w[m] = (...a) => raw[m](k, ...a);
  window.CCApp = w;
})();

(function () {
  const LS = "ccapp.theme";
  const MODES = ["auto", "light", "dark", "qs-auto", "qs-light", "qs-dark", "zy-auto", "zy-light", "zy-dark", "gc-auto", "gc-light", "gc-dark"];
  const PREFIX = { native: "", qiusuo: "qs-", zhuyue: "zy-", goucheng: "gc-" };
  const skinOf = (p) => (p.startsWith("qs-") ? "qiusuo" : p.startsWith("zy-") ? "zhuyue" : p.startsWith("gc-") ? "goucheng" : "native");
  const modeOf = (p) => p.replace(/^(qs|zy|gc)-/, "");
  // 状态栏 / 导航栏底色要和页面底色一致（壳那边也有一份同样的表：BrowserPane.bg）
  const BAR = { native: { dark: "#1f1e1d", light: "#faf9f5" }, qiusuo: { dark: "#151517", light: "#ffffff" }, zhuyue: { dark: "#111111", light: "#ffffff" }, goucheng: { dark: "#151412", light: "#f3eee3" } };
  const mq = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  const app = () => (window.CCApp && typeof window.CCApp.nightMode === "function" ? window.CCApp : null);

  let pref = "auto";
  try { pref = localStorage.getItem(LS) || "auto"; } catch {}
  if (!MODES.includes(pref)) pref = "auto";

  let sysDark = null;   // 壳推过来的系统状态；null = 没推过
  function systemDark() {
    if (sysDark != null) return sysDark;
    const a = app();
    if (a) { try { return !!a.nightMode(); } catch {} }
    return mq ? mq.matches : true;
  }

  function apply() {
    const skin = skinOf(pref);
    const mode = modeOf(pref);
    const dark = mode === "dark" || (mode === "auto" && systemDark());
    const name = dark ? "dark" : "light";
    const root = document.documentElement;
    if (root.dataset.theme !== name) root.dataset.theme = name;
    if (root.dataset.skin !== skin) root.dataset.skin = skin;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = BAR[skin][name];
    applyAccent(skin, name);
    const a = app();
    // 先告诉壳风格，再让它换栏色 —— 栏色按风格取
    if (a && typeof a.skinPref === "function") { try { a.skinPref(skin); } catch {} }
    if (a && typeof a.setBars === "function") { try { a.setBars(dark); } catch {} }
    // 外壳记下这个选择，下次启动的安装页 / 空白页照着上色（cccodroid 0.1.20 起有）；壳只认 auto/light/dark
    if (a && typeof a.themePref === "function") { try { a.themePref(mode); } catch {} }
    const s = document.getElementById("set-theme");
    if (s && s.value !== pref) s.value = pref;
    // 设置里的两组分段（外观 / 深浅）是 pref 的两半
    document.querySelectorAll("#seg-skin [data-sk]").forEach((b) => b.classList.toggle("on", b.dataset.sk === skin));
    document.querySelectorAll("#seg-mode [data-md]").forEach((b) => b.classList.toggle("on", b.dataset.md === mode));
    return name;
  }

  // ── 强调色（0.4.20）：用户在设置 → 通用里挑的颜色，存在 ccapp-ui.json 的 accent（本地镜像 localStorage cc.ui，这里同步读，启动不闪）。
  //   同一个颜色在浅底、深底上看得清的深浅不一样：按当前外观的底色把亮度往对比度够的方向推，直到正文对比 ≥ 4.5:1；
  //   按钮上的字（--on-accent）在白和近黑里挑对比高的；选中项的浅底（--active-bg）也由它派生。三套外观都盖：构成的红、逐月的蓝点缀也换成它
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = (h) => { const c = hex2rgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function rgb2hsl([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hsl2hex(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return "#" + [0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("");
  }
  /** 把 hex 的亮度往离开 bg 的方向推，直到对比 ≥ min；推到头还不够就返回推到头的那个 */
  function readable(hex, bg, min) {
    let [h, s, l] = rgb2hsl(hex2rgb(hex)), out = hex;
    const dir = lum(bg) > 0.4 ? -1 : 1;
    for (let i = 0; i < 60 && contrast(out, bg) < min; i++) { l = Math.max(0, Math.min(1, l + dir * 0.015)); out = hsl2hex(h, s, l); }
    return out;
  }
  const mix = (a, b, p) => "#" + hex2rgb(a).map((v, i) => Math.round((v * p + hex2rgb(b)[i] * (1 - p)) * 255).toString(16).padStart(2, "0")).join("");
  function accentPref() { try { const v = (JSON.parse(localStorage.getItem("cc.ui")) || {}).accent; return /^#[0-9a-f]{6}$/i.test(v || "") ? v.toLowerCase() : ""; } catch { return ""; } }
  /** 给定外观和深浅，算出实际用的三种颜色（设置页的色块预览也用它） */
  function accentFor(hex, skin, name) {
    const bg = BAR[skin][name], acc = readable(hex, bg, 4.5);
    const on = contrast("#ffffff", acc) >= contrast("#141414", acc) ? "#ffffff" : "#141414";
    return { acc, dim: mix(acc, bg, 0.45), on, soft: mix(acc, bg, lum(bg) > 0.4 ? 0.12 : 0.2) };
  }
  function applyAccent(skin, name) {
    let el = document.getElementById("user-accent");
    const hex = accentPref();
    let css = "";
    if (hex) {
      const { acc, dim, on, soft } = accentFor(hex, skin, name);
      // 构成首屏右侧那块斜切色块（--gc-wedge）原来写死成半透明红，自定颜色时漏了没跟着换；照原版的透明度从强调色派生
      const wedge = `rgba(${hex2rgb(acc).map((v) => Math.round(v * 255)).join(",")},${lum(BAR[skin][name]) > 0.4 ? .13 : .1})`;
      // 选择器带两个属性：压过各外观自己那段（同样两个属性），这段 style 插在 style.css 后面，同分时后者赢
      css = `html[data-theme][data-skin]{--accent:${acc};--accent-dim:${dim};--on-accent:${on};--active-bg:${soft};--gc-red:${acc};--gc-wedge:${wedge};--zy-blue:${acc}}`;
    }
    // 外壳自己画的东西（加载动画、安装页、对话框）也跟着换：把浅色、深色底上实际用的颜色交过去，空串 = 用外观原色
    const a = app();
    if (a && typeof a.accentPref === "function") {
      try { a.accentPref(hex ? accentFor(hex, skin, "light").acc : "", hex ? accentFor(hex, skin, "dark").acc : ""); } catch {}
    }
    if (!el) { if (!css) return; el = document.createElement("style"); el.id = "user-accent"; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  }

  function set(v) {
    if (!MODES.includes(v)) v = "auto";
    pref = v;
    try { localStorage.setItem(LS, v); } catch {}
    window.Theme.pref = v;
    apply();
  }

  /** 壳在系统切换夜间模式时调用 */
  // 外壳 evaluateJavascript 直接调它：自己接住错误，免得变成看不懂的「Script error.」
  function system(dark) { try { sysDark = !!dark; if (pref.endsWith("auto")) apply(); } catch (e) { console.error("[cc] Theme.system", e); } }

  if (mq) {
    const on = () => { if (sysDark == null && !app() && pref.endsWith("auto")) apply(); };
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
  }

  // 设置页的下拉框（index.html 的 #set-theme），事件委托：设置页重新渲染也不失效
  document.addEventListener("change", (e) => { if (e.target && e.target.id === "set-theme") set(e.target.value); }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#seg-skin [data-sk], #seg-mode [data-md]"); if (!b) return;
    const skin = b.dataset.sk || skinOf(pref), mode = b.dataset.md || modeOf(pref);
    set((PREFIX[skin] || "") + mode);
  });
  document.addEventListener("DOMContentLoaded", apply);

  // ── 字体与正文字号：和配色一样同步生效，避免先闪一下系统字体 ──
  //   界面字体  ccapp.uifont   cc（默认：自带 Inter + 思源黑体）| system（跟随系统）
  //   回复字体  ccapp.readfont serif（默认：自带 Spectral + 思源宋体）| sans
  //   正文字号  ccapp.fs       s | m（默认）| l
  //   界面、回复两个字体槽位还能填导入的字体 "u:<id>"（0.4.20 起，见 gw/fonts.mjs；等宽不开放：终端和代码按格子排，换字体容易错位），这时属性写 "u"，具体是哪个字体由下面注入的 <style id="user-fonts"> 定。
  //   结果写到 <html data-uifont data-readfont data-fs>，样式只认这几个属性
  const TYPE = { uifont: ["cc", "system"], readfont: ["serif", "sans"], fs: ["m", "s", "l"] };
  const SLOTS = ["uifont", "readfont"];
  // 导入字体的清单在网关（/api/fonts），这里缓存一份，好在页面一开头就把 @font-face 写进去；界面启动后会再和网关对一次
  const UF = "ccapp.ufonts";
  let ufonts = [];
  try { const j = JSON.parse(localStorage.getItem(UF) || "[]"); if (Array.isArray(j)) ufonts = j.filter((f) => f && /^[0-9a-f]{12}$/.test(f.id)); } catch {}
  const okVal = (k, v) => (TYPE[k] || []).includes(v) || (SLOTS.includes(k) && typeof v === "string" && v.startsWith("u:") && ufonts.some((f) => "u:" + f.id === v));
  const typePref = {};
  for (const k in TYPE) { let v = null; try { v = localStorage.getItem("ccapp." + k); } catch {} typePref[k] = okVal(k, v) ? v : TYPE[k][0]; }
  const FMT = { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" };
  const fam = (id) => `"CCU ${id}"`;
  function paintFonts() {
    let el = document.getElementById("user-fonts");
    if (!el) { el = document.createElement("style"); el.id = "user-fonts"; document.head.appendChild(el); }
    // 只声明不下载：@font-face 要等真有元素用到这个字体时才去取
    let css = ufonts.map((f) => `@font-face{font-family:${fam(f.id)};src:url("/api/fonts/file/${f.id}") format("${FMT[f.fmt] || f.fmt}");font-display:swap}`).join("\n");
    const id = (k) => (typePref[k].startsWith("u:") ? typePref[k].slice(2) : "");
    // 导入的字体排第一，缺字（比如英文字体里没有中文）照旧落回自带字体
    if (id("uifont")) css += `\nhtml[data-uifont="u"]{--font-ui:${fam(id("uifont"))},"CC Inter","CC Hei",sans-serif}`;
    if (id("readfont")) css += `\nhtml[data-readfont="u"]{--font-read:${fam(id("readfont"))},var(--font-serif)}`;
    if (el.textContent !== css) el.textContent = css;
  }
  function applyType() {
    const root = document.documentElement;
    paintFonts();
    for (const k in TYPE) { const v = typePref[k].startsWith("u:") ? "u" : typePref[k]; if (root.dataset[k] !== v) root.dataset[k] = v; }
    const SEG = { uifont: ["#seg-uifont", "uf"], readfont: ["#seg-readfont", "rf"], fs: ["#seg-fs", "fs"] };
    for (const k in SEG) {
      const [sel, d] = SEG[k], v = typePref[k].startsWith("u:") ? "pick" : typePref[k];
      document.querySelectorAll(`${sel} [data-${d}]`).forEach((b) => b.classList.toggle("on", b.dataset[d] === v));
    }
  }
  function setType(k, v) {
    if (!okVal(k, v)) return;
    const was = typePref[k];
    typePref[k] = v;
    try { localStorage.setItem("ccapp." + k, v); } catch {}
    applyType();
    if (was !== v) document.dispatchEvent(new CustomEvent("cc:type", { detail: { key: k, value: v } }));
  }
  /** 网关的字体清单（导入 / 删除后、界面启动时）：更新缓存；正在用的字体没了就退回默认 */
  function setFonts(list) {
    ufonts = (Array.isArray(list) ? list : []).filter((f) => f && /^[0-9a-f]{12}$/.test(f.id)).map((f) => ({ id: f.id, name: f.name, fmt: f.fmt }));
    try { localStorage.setItem(UF, JSON.stringify(ufonts)); } catch {}
    for (const k of SLOTS) if (!okVal(k, typePref[k])) setType(k, TYPE[k][0]);
    applyType();
  }
  const fontOf = (k) => (typePref[k].startsWith("u:") ? ufonts.find((f) => "u:" + f.id === typePref[k]) || null : null);
  document.addEventListener("click", (e) => {
    // 「自选…」不在这里管（要弹菜单、可能还要导入），界面那边接（09-settings.js 的字体一节）
    const b = e.target.closest && e.target.closest("#seg-uifont [data-uf], #seg-readfont [data-rf], #seg-fs [data-fs]"); if (!b) return;
    if (b.dataset.uf) setType("uifont", b.dataset.uf);
    else if (b.dataset.rf) setType("readfont", b.dataset.rf);
    else setType("fs", b.dataset.fs);
  });
  document.addEventListener("DOMContentLoaded", applyType);
  applyType();

  window.Theme = { pref, set, system, apply, accentFor, get skin() { return skinOf(pref); }, setType, type: typePref, setFonts, fontOf, fam, get fonts() { return ufonts.slice(); }, get current() { return document.documentElement.dataset.theme; } };
  apply();
})();
