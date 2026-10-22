// ─────────────────────────────────────────────────────────────────────
//  theme.js —— 外观：两套风格（原生 / 求索）× 浅色 / 深色 / 跟随系统（无依赖；放在 <head> 里同步加载，避免先闪一下深色）
//
//  设置存在 localStorage["ccapp.theme"]："auto"（默认）| "light" | "dark"，求索风格加前缀 "qs-"。
//  结果写到 <html data-theme="light|dark" data-skin="native|qiusuo">，样式只认这两个属性（style.css 里的变量表）。
//
//  「跟随系统」靠什么判断：
//    · 壳里有 CCApp.nightMode() 就以它为准 —— 应用主题固定是深色时，WebView 的
//      prefers-color-scheme 不跟系统走，只有原生层知道系统现在是不是夜间模式；
//      系统切换时壳调用 Theme.system(true|false) 通知这里。
//    · 没有壳（浏览器里打开）就用 matchMedia。
//  定下来以后再告诉壳 CCApp.setBars(dark)，让状态栏 / 导航栏跟着换色。
// ─────────────────────────────────────────────────────────────────────
(function () {
  const LS = "ccapp.theme";
  const MODES = ["auto", "light", "dark", "qs-auto", "qs-light", "qs-dark"];
  // 状态栏 / 导航栏底色要和页面底色一致（壳那边也有一份同样的表：BrowserPane.bg）
  const BAR = { native: { dark: "#1f1e1d", light: "#faf9f5" }, qiusuo: { dark: "#151517", light: "#ffffff" } };
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
    const skin = pref.startsWith("qs-") ? "qiusuo" : "native";
    const mode = pref.replace(/^qs-/, "");
    const dark = mode === "dark" || (mode === "auto" && systemDark());
    const name = dark ? "dark" : "light";
    const root = document.documentElement;
    if (root.dataset.theme !== name) root.dataset.theme = name;
    if (root.dataset.skin !== skin) root.dataset.skin = skin;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = BAR[skin][name];
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
    const skin = b.dataset.sk || (pref.startsWith("qs-") ? "qiusuo" : "native"), mode = b.dataset.md || pref.replace(/^qs-/, "");
    set((skin === "qiusuo" ? "qs-" : "") + mode);
  });
  document.addEventListener("DOMContentLoaded", apply);

  // ── 字体与正文字号：和配色一样同步生效，避免先闪一下系统字体 ──
  //   界面字体  ccapp.uifont   cc（默认：自带 Inter + 思源黑体）| system（跟随系统）
  //   回复字体  ccapp.readfont serif（默认：自带 Spectral + 思源宋体）| sans
  //   正文字号  ccapp.fs       s | m（默认）| l
  //   结果写到 <html data-uifont data-readfont data-fs>，样式只认这三个属性
  const TYPE = { uifont: ["cc", "system"], readfont: ["serif", "sans"], fs: ["m", "s", "l"] };
  const typePref = {};
  for (const k in TYPE) { let v = null; try { v = localStorage.getItem("ccapp." + k); } catch {} typePref[k] = TYPE[k].includes(v) ? v : TYPE[k][0]; }
  function applyType() {
    const root = document.documentElement;
    for (const k in TYPE) if (root.dataset[k] !== typePref[k]) root.dataset[k] = typePref[k];
    document.querySelectorAll("#seg-uifont [data-uf]").forEach((b) => b.classList.toggle("on", b.dataset.uf === typePref.uifont));
    document.querySelectorAll("#seg-readfont [data-rf]").forEach((b) => b.classList.toggle("on", b.dataset.rf === typePref.readfont));
    document.querySelectorAll("#seg-fs [data-fs]").forEach((b) => b.classList.toggle("on", b.dataset.fs === typePref.fs));
  }
  function setType(k, v) {
    if (!TYPE[k] || !TYPE[k].includes(v)) return;
    typePref[k] = v;
    try { localStorage.setItem("ccapp." + k, v); } catch {}
    applyType();
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("#seg-uifont [data-uf], #seg-readfont [data-rf], #seg-fs [data-fs]"); if (!b) return;
    if (b.dataset.uf) setType("uifont", b.dataset.uf);
    else if (b.dataset.rf) setType("readfont", b.dataset.rf);
    else setType("fs", b.dataset.fs);
  });
  document.addEventListener("DOMContentLoaded", applyType);
  applyType();

  window.Theme = { pref, set, system, apply, setType, type: typePref, get current() { return document.documentElement.dataset.theme; } };
  apply();
})();
