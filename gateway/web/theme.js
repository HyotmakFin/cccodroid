// ─────────────────────────────────────────────────────────────────────
//  theme.js —— 外观：浅色 / 深色 / 跟随系统（无依赖；放在 <head> 里同步加载，避免先闪一下深色）
//
//  设置存在 localStorage["ccapp.theme"]："auto"（默认）| "light" | "dark"。
//  结果写到 <html data-theme="light|dark">，样式只认这个属性（style.css 里的变量表）。
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
  const MODES = ["auto", "light", "dark"];
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
    const dark = pref === "dark" || (pref === "auto" && systemDark());
    const name = dark ? "dark" : "light";
    const root = document.documentElement;
    if (root.dataset.theme !== name) root.dataset.theme = name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#0d1117" : "#ffffff";
    const a = app();
    if (a && typeof a.setBars === "function") { try { a.setBars(dark); } catch {} }
    const s = document.getElementById("set-theme");
    if (s && s.value !== pref) s.value = pref;
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
  function system(dark) { sysDark = !!dark; if (pref === "auto") apply(); }

  if (mq) {
    const on = () => { if (sysDark == null && !app() && pref === "auto") apply(); };
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
  }

  // 设置页的下拉框（index.html 的 #set-theme），事件委托：设置页重新渲染也不失效
  document.addEventListener("change", (e) => { if (e.target && e.target.id === "set-theme") set(e.target.value); }, true);
  document.addEventListener("DOMContentLoaded", apply);

  window.Theme = { pref, set, system, apply, get current() { return document.documentElement.dataset.theme; } };
  apply();
})();
