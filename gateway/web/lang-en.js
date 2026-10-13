// 英文词典：中文原文（键） → 英文。规则见 i18n.js 顶部与 claude-apk/i18n/HANDOFF.md。
// 键必须和代码里 t("…") 的参数、或 HTML 里被标记元素的原始内容**一字不差**
// （data-i18n-html 的键是 innerHTML 去首尾空白、连续空白压成一个空格后的样子）。
// 跑 `node claude-apk/i18n/scan.mjs` 能列出还没译的键。
window.I18N_DICT = window.I18N_DICT || {};
window.I18N_DICT.en = {
  // ── 抽屉标签 ──
  "会话": "Sessions",
  "设置": "Settings",
  "能力": "Capabilities",

  // ── 相对时间（带变量 / 复数） ──
  "刚刚": "just now",
  "{n} 分钟前": "{n} min ago",
  "{n} 小时前": (v) => `${v.n} hour${v.n == 1 ? "" : "s"} ago`,
  "{n} 天前": (v) => `${v.n} day${v.n == 1 ? "" : "s"} ago`,

  // ── 出错提示 ──
  "界面脚本出错：{msg}": "UI script error: {msg}",
};
