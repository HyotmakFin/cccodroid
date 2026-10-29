// 词典就位后翻译静态标记。i18n.js 用 document.write 把它排在词典脚本后面。
// 以前是一段内联 <script>，被 0.5.1 加的 CSP（script-src 'self'）拦掉了，非中文界面的静态文字一直是中文（审查 #47 NEW-R2-001）
try { I18N.apply(document); } catch (e) { console.error("i18n apply 失败", e); }
