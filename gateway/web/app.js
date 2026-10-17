// ─────────────────────────────────────────────────────────────────────
//  app.js —— Claude CLI 图形化入口
//  原生 JS，无依赖。把 CLI 的能力（会话 / 斜杠命令 / 工具 / 设置）搬进界面。
//
//  「家具」三条线：
//    递进来  uploadFiles()  ← 点回形针 / 粘贴 / 拖放 / 文件面板
//    拿出去  /api/file       ← 消息里的本地图片自动内联、点开大图
//    看得见  openFiles()     ← 全屏文件浏览器，能预览能引用
// ─────────────────────────────────────────────────────────────────────
// 宿主 WebView 用 ?t=令牌 首次加载（网关据此种 Cookie）；令牌别留在地址里
if (/[?&]t=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);

(() => {
  "use strict";
  // 界面文字一律过 t()（中文原文即键，见 i18n.js）；i18n.js 没加载时退化成原样返回
  const I18N = window.I18N || { lang: "zh", t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s) };
  const t = I18N.t;

  // 出错要看得见：脚本一挂界面就是死的，把原因写到顶栏副标题上，
  // 而不是让人对着一个不动的东西猜。
  window.addEventListener("error", (e) => {
    const el = document.getElementById("sub-title");
    if (el) { el.textContent = t("界面脚本出错：{msg}", { msg: e.message || String(e.error) }); el.className = "err"; }
  });
  window.addEventListener("unhandledrejection", (e) => {
    const el = document.getElementById("sub-title");
    if (el) { el.textContent = t("界面脚本出错：{msg}", { msg: e.reason?.message || String(e.reason) }); el.className = "err"; }
  });

  const $ = (id) => document.getElementById(id);
  const chatEl = $("chat"), inputEl = $("input"), sendEl = $("btn-send");
  const interjectEl = $("btn-interject");
  const subEl = $("sub-title"), statEl = $("stat-chip"), modelEl = $("model-chip");
  const permEl = $("perm-chip"), drawerEl = $("drawer"), toastEl = $("toast");
  const popupEl = $("popup"), popupList = $("popup-list"), popupHead = $("popup-head");
  const ctxBar = $("ctxbar"), ctxFill = $("ctxfill"), ctxTxt = $("ctxtxt");
  const fileInput = $("file-input"), filesEl = $("files"), lightboxEl = $("lightbox");

  /// 待发队列条：忙碌时排队的消息显示在这里（在附件条上方，composer 内）
  // 待发队列照 Claude Desktop 的样子：排队的消息直接出现在对话末尾（标「排队中」），
  // 底下有「立即发送」—— 递进正在跑的这一轮；停止键只管停止，挂起的不会自动发
  const queueStrip = document.createElement("div");
  queueStrip.id = "queued";
  queueStrip.className = "hidden";

  const state = {
    model: "—",
    permissionMode: "",
    caps: null,
    sessions: [],
    serverStatus: null,
    settings: {},
    providers: [],
    ctxUsed: 0,
    ctxTotal: 0,        // 真实值从 /api/models 拿，不写死
    compactAt: 0,       // 自动压缩窗口；设了就把它当上下文条的满刻度
    popup: { mode: null, items: [], sel: 0, range: null },
    lastUserText: "",
    fileDir: null,
    // 文件浏览器
    fs: { path: null, entries: [], sel: null, roots: [], q: "", hidden: false, parent: null },
    attachments: [],
  };

  // ── 基础工具 ──────────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = isErr ? "err" : "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), isErr ? 4200 : 3200);
  }
  // ── 保存到（A4）：外壳有 CCApp.saveAs 时，下载 / 导出一律走系统「保存到」面板 ──
  //  不要存储权限，也不会把文件落进用户打不开的私有目录。结果由外壳回调 __ccSaved
  const canSaveAs = () => !!(window.CCApp && window.CCApp.saveAs);
  const canShare = () => !!(state.serverStatus && state.serverStatus.product === "cccodroid");
  function saveAs(path, mime) { window.CCApp.saveAs(path, path.split("/").pop(), mime || ""); }
  window.__ccSaved = (ok, msg) => {
    if (ok) return toast(t("已保存：{name}", { name: msg }));
    if (msg === "cancel") return;
    toast(t("保存失败：{msg}", { msg: msg === "missing" ? t("文件不存在") : msg === "nopicker" ? t("系统里没有可用的文件面板") : msg }), true);
  };
  // 页面里所有指向 /api/file 的下载链接（文件浏览器的 ⤓、查看器的「下载」）：WebView 自己不会处理下载
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[download]");
    if (!a || !canSaveAs()) return;
    const u = new URL(a.href, location.href);
    const p = u.pathname === "/api/file" && u.searchParams.get("path");
    if (!p) return;
    e.preventDefault();
    saveAs(p);
  }, true);

  function setStatus(text, cls) { subEl.textContent = text; subEl.className = cls || ""; }

  // ── 跨刷新要记住的东西 ────────────────────────────────────────────
  //  界面代码一变网关就会让前端自动 reload（uiTag 机制）。要是会话号只存在内存里，
  //  一刷新就悄悄开新会话了 —— 上下文全丢，而且毫无提示。必须落盘。
  const LS_SID = "ccapp.sessionId", LS_CTX = "ccapp.ctxUsed";
  function saveUiState() {
    try {
      // 有会话号就记；没有就删掉，让它回到「未定」——
      // 这样下次开机还能问网关要"最近跑过的那条"，而不是默默开新会话。
      if (view.sessionId) localStorage.setItem(LS_SID, view.sessionId);
      else localStorage.removeItem(LS_SID);
      localStorage.setItem(LS_CTX, String(state.ctxUsed || 0));
    } catch {}
  }
  function loadUiState() {
    try {
      state.ctxUsed = Number(localStorage.getItem(LS_CTX)) || 0;
      return localStorage.getItem(LS_SID) || null;
    } catch { return null; }
  }
  // 自动跟到底：用户一往上滑就停，回到底部附近再恢复。
  // 以前只看"离底部 <160px"，生成中每来一条事件就把正在惯性滑动的画面拽回去，表现为"滑不动、只能一点点拖"
  let stick = true, progTop = -1;
  // 对话区只挂一个 scroll 监听，事件里不读排版，攒到下一帧统一处理：跟底判断、翻到顶加载更早的、↓ 圆钮
  const chatScrollHooks = [];
  let chatScrollRaf = 0;
  chatEl.addEventListener("scroll", () => {
    if (chatScrollRaf) return;
    chatScrollRaf = requestAnimationFrame(() => {
      chatScrollRaf = 0;
      if (chatEl.scrollTop !== progTop) stick = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;  // 不是我们自己滚的
      for (const f of chatScrollHooks) f();
    });
  }, { passive: true });
  function scrollDown(force) {
    if (force) stick = true;
    else if (!stick) return;
    chatEl.scrollTop = chatEl.scrollHeight;
    progTop = chatEl.scrollTop;
  }
  function relTime(ms) {
    const d = Date.now() - ms;
    if (d < 60000) return t("刚刚");
    if (d < 3600000) return t("{n} 分钟前", { n: Math.floor(d / 60000) });
    if (d < 86400000) return t("{n} 小时前", { n: Math.floor(d / 3600000) });
    if (d < 2592000000) return t("{n} 天前", { n: Math.floor(d / 86400000) });
    return new Date(ms).toLocaleDateString();
  }
  function fmtSize(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  async function api(path, opts) {
    // X-CC-Lang：网关据此选提示语的语言（网关侧本地化见 claude-apk/i18n/HANDOFF.md）
    opts = Object.assign({}, opts);
    opts.headers = Object.assign({ "X-CC-Lang": I18N.lang }, opts.headers);
    const r = await fetch(path, opts);
    if (!r.ok) {
      // 服务端带出来的 message 比光秃秃的 "HTTP 409" 有用得多
      // （比如切厂商时那句"这一轮还在生成中，等它跑完再切"）
      let msg = "HTTP " + r.status;
      try { const j = await r.json(); msg = j.message || j.error || msg; } catch {}
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r.json();
  }
  const fileUrl = (p, dl) =>
    "/api/file?path=" + encodeURIComponent(p) + (dl ? "&download=1" : "");

  // ── Markdown 渲染 ─────────────────────────────────────────────────
  // 本机绝对路径：回复里出现就变成可点的链接，点了在应用内查看器打开（目录则开文件面板）。
  // 只认这几个根，免得把 "/api/file" 这类接口名、"1/2" 这类分数当成路径。可带 ":行号" 尾巴（file.js:12）。
  const PATH_RE = /(^|[\s(（:：,，、;'"`“])((?:\/storage|\/sdcard|\/data|\/mnt)(?:\/[\w.\-+@%~=\u4e00-\u9fff]+)+\/?)(:\d+(?::\d+)?)?/g;
  const pathLink = (p, line, label) =>
    `<a class="fpath" data-path="${p}" href="#" title="${t("在查看器中打开")}">${label || p + (line || "")}</a>`;
  function inlineMd(s) {
    // 代码片段先换成占位符（片段里整段是路径的照样能点），再统一处理链接、加粗：
    // 这样 **`代码`** 这种跨着片段的加粗也能配上对，片段里的 * 也不会被当成强调
    const keep = [];
    const hold = (h) => "\u0000" + (keep.push(h) - 1) + "\u0000";
    return esc(s)
      .replace(/`([^`\n]+)`/g, (_, c) => {
        const m = c.match(/^((?:\/storage|\/sdcard|\/data|\/mnt)(?:\/[^\s:]+)+\/?)(:\d+(?::\d+)?)?$/);
        return hold(m ? `<code>${pathLink(m[1], m[2], c)}</code>` : `<code>${c}</code>`);
      })
      .replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (_, l, p) => hold(pathLink(p.replace(/:\d+(?::\d+)?$/, ""), "", l)))
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, l, u) => hold(`<a class="weblink" href="${u}" target="_blank" rel="noopener">${l}</a>`))
      // 裸网址也能点（本机开发服务 http://127.0.0.1:端口 最常见）；句末标点不算
      .replace(/https?:\/\/[^\s<>"'`）)】」，。；、\u0000]+/g, (u) => {
        const tail = (u.match(/[.,;:!?]+$/) || [""])[0];
        const h = u.slice(0, u.length - tail.length);
        return hold(`<a class="weblink" href="${h}" target="_blank" rel="noopener">${h}</a>`) + tail;
      })
      .replace(PATH_RE, (_, pre, p, line) => {
        const tail = line ? "" : (p.match(/[.]+$/) || [""])[0];     // 句末的点不算路径
        return pre + hold(pathLink(p.slice(0, p.length - tail.length), line)) + tail;
      })
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\u0000(\d+)\u0000/g, (_, n) => keep[n]);
  }

  /** 支持标题/列表/表格/代码块/引用/分隔线 */
  function renderMd(text) {
    const lines = String(text).split("\n");
    let out = "", inCode = false, codeBuf = [], listType = null, inTable = false, tblRows = [];

    const closeList = () => { if (listType) { out += `</${listType}>`; listType = null; } };
    const flushTable = () => {
      if (!inTable) return;
      inTable = false;
      if (!tblRows.length) return;
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      let html = '<div class="tbl-wrap"><table>';
      tblRows.forEach((row, i) => {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(row) && i === 1) return;   // 分隔行
        const tag = i === 0 ? "th" : "td";
        html += "<tr>" + cells(row).map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join("") + "</tr>";
      });
      out += html + "</table></div>";
      tblRows = [];
    };

    for (const raw of lines) {
      const fence = raw.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        if (inCode) {
          out += `<pre><code>${esc(codeBuf.join("\n"))}</code><button class="copy-btn">${t("复制")}</button></pre>`;
          codeBuf = []; inCode = false;
        } else { closeList(); flushTable(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      if (/^\s*\|.*\|\s*$/.test(raw)) { closeList(); inTable = true; tblRows.push(raw.trim()); continue; }
      flushTable();

      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const lv = Math.min(h[1].length + 1, 4); out += `<h${lv}>${inlineMd(h[2])}</h${lv}>`; continue; }

      if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(raw)) { closeList(); out += "<hr>"; continue; }

      const bq = raw.match(/^>\s?(.*)$/);
      if (bq) { closeList(); out += `<blockquote>${inlineMd(bq[1])}</blockquote>`; continue; }

      const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
        out += `<li>${inlineMd(ul[1])}</li>`; continue;
      }
      const ol = raw.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ol) {
        // 带上起始编号：增量渲染会把一个列表切成几段，不带的话每段都从 1 数起
        if (listType !== "ol") { closeList(); out += Number(ol[1]) > 1 ? `<ol start="${Number(ol[1])}">` : "<ol>"; listType = "ol"; }
        out += `<li>${inlineMd(ol[2])}</li>`; continue;
      }

      if (!raw.trim()) { closeList(); continue; }
      closeList();
      out += `<p>${inlineMd(raw)}</p>`;
    }
    if (inCode && codeBuf.length) out += `<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`;
    flushTable(); closeList();
    return out;
  }

  // ── 本地图片内联（「拿出去」那条线）───────────────────────────────
  //  文本里出现的本机图片路径自动变成可点开的大图。
  //  前缀守卫：前面不能是 \w : / . - ，这样 URL 里的 /photo.png 不会被误认。
  const IMG_PATH_RE =
    /(^|[^\w:/.\-])((?:\/[\w.\-\u4e00-\u9fa5]+)+\.(?:png|jpe?g|gif|webp|bmp|avif|svg))/gi;
  const SKIP_TAGS = new Set(["CODE", "PRE", "A", "BUTTON", "IMG", "SUMMARY", "TEXTAREA"]);

  function makeInlineImg(path) {
    const wrap = document.createElement("span");
    wrap.className = "inline-img";
    const img = document.createElement("img");
    img.src = fileUrl(path);
    img.alt = path;
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(path));
    img.addEventListener("error", () => {
      const a = document.createElement("a");
      a.href = "#"; a.className = "missing-img"; a.textContent = path;
      a.addEventListener("click", (e) => { e.preventDefault(); toast(t("读不到：{path}", { path }), true); });
      wrap.replaceWith(a);
    });
    wrap.appendChild(img);
    return wrap;
  }

  function embedLocalImages(root) {
    if (!root || !root.querySelectorAll) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf("/") < 0) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentNode; p && p !== root; p = p.parentNode) {
          if (SKIP_TAGS.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n; while ((n = walker.nextNode())) targets.push(n);

    for (const node of targets) {
      const text = node.nodeValue;
      IMG_PATH_RE.lastIndex = 0;
      const hits = [];
      let m;
      while ((m = IMG_PATH_RE.exec(text))) {
        const path = m[2];
        const pathAt = m.index + m[1].length;
        // URL 查询串里的路径（…?path=/x.png）不是本机文件，跳过
        const before = text.slice(Math.max(0, pathAt - 60), pathAt);
        const tok = before.slice(Math.max(
          before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1);
        if (tok.includes("://")) continue;
        hits.push({ pathAt, path });
      }
      if (!hits.length) continue;

      const frag = document.createDocumentFragment();
      let last = 0;
      for (const h of hits) {
        if (h.pathAt > last) frag.appendChild(document.createTextNode(text.slice(last, h.pathAt)));
        frag.appendChild(makeInlineImg(h.path));
        last = h.pathAt + h.path.length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** 渲染 + 内联图片，一步到位 */
  function setHtml(el, html) {
    el.innerHTML = html;
    embedLocalImages(el);
    return el;
  }

  // ── 图片查看器 ────────────────────────────────────────────────────
  function openLightbox(path) {
    $("lightbox-img").src = fileUrl(path);
    $("lightbox-cap").textContent = path.split("/").pop();
    $("lightbox-dl").href = fileUrl(path, true);
    lightboxEl.classList.remove("hidden");
  }
  lightboxEl.addEventListener("click", (e) => {
    if (e.target === lightboxEl || e.target.id === "lightbox-close") lightboxEl.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") lightboxEl.classList.add("hidden");
  });

  // 代码复制 + 图片点击（事件委托）
  const onCopyBtn = (e) => {
    const b = e.target.closest(".copy-btn");
    if (!b) return;
    const code = b.parentElement.querySelector("code");
    if (code) navigator.clipboard?.writeText(code.textContent).then(() => {
      b.textContent = t("已复制"); setTimeout(() => (b.textContent = t("复制")), 1400);
    });
  };
  chatEl.addEventListener("click", onCopyBtn);
  $("vw-body").addEventListener("click", onCopyBtn);   // 文件查看器里渲染的 Markdown 也有代码块

  // 回复 / 查看器里的本机路径：点了直接在应用内打开
  async function openPath(p) {
    let r;
    try { r = await api("/api/file/stat?path=" + encodeURIComponent(p)); }
    catch (e) {
      return toast(e.status === 403 ? t("这个位置受保护，不能在界面里打开：{p}", { p }) :
        e.status === 404 ? t("文件不存在：{p}", { p }) : t("打不开：{msg}", { msg: e.message }));
    }
    if (r.dir) return openFiles(r.path);
    openViewer(r.path, r.kind, r.size);
  }
  const onPathLink = (e) => {
    const a = e.target.closest(".fpath");
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    openPath(a.dataset.path);
  };
  chatEl.addEventListener("click", onPathLink);
  $("vw-body").addEventListener("click", onPathLink);

  // 网页链接：有应用内浏览器就在里面开（cccodroid / 开发端外壳提供），否则照常新窗口
  const hasBrowser = () => !!(window.CCApp && window.CCApp.openBrowser);
  // 宽屏（两栏起）且外壳支持嵌入：浏览器开在右侧工作区，和文件 / 终端并列；窄屏照旧全屏窗口。
  // 已经开着窗格时，窄屏下的新链接也送进窗格，别再叠一个全屏窗口
  const browserEl = $("browser");
  const hasPane = () => !!(window.CCApp && window.CCApp.hasPane && window.CCLayout);
  function openWeb(url) {
    if (hasPane() && (CCLayout.tier() >= 2 || !browserEl.classList.contains("hidden"))) {
      browserEl.classList.remove("hidden");
      CCLayout.raise("browser");
      window.CCApp.paneOpen(url || "");
      return;
    }
    if (hasBrowser()) return window.CCApp.openBrowser(url || "");
    if (url) window.open(url, "_blank", "noopener");
  }
  function closeBrowser() {
    if (window.CCApp && CCApp.paneCanBack && CCApp.paneCanBack()) return CCApp.paneGoBack();   // 返回手势先在网页里后退
    browserEl.classList.add("hidden");
    if (window.CCApp && CCApp.paneClose) CCApp.paneClose();
  }
  window.__ccBrowserClosed = () => browserEl.classList.add("hidden");    // 窗格自己的 ✕
  const onWebLink = (e) => {
    const a = e.target.closest("a.weblink");
    if (!a || !hasBrowser()) return;
    e.preventDefault();
    openWeb(a.getAttribute("href"));
  };
  chatEl.addEventListener("click", onWebLink);
  $("vw-body").addEventListener("click", onWebLink);
  if (hasBrowser()) {
    $("btn-web").classList.remove("hidden");
    $("btn-web").addEventListener("click", () => openWeb(""));
  }

  // ── 对话视图 ──────────────────────────────────────────────────────
  //  v3：照 Claude Desktop 的路子 —— 生成归网关管，界面只是订阅者。
  //   · 一条 EventSource（/api/events）收所有进度；断线自动续传，续不上就整轮重放
  //   · 发消息只是 POST 一下拿个号，排队也在网关那边（刷新不丢、两个窗口看到同一份）
  //   · 历史从文件尾倒着按页取，往上滚再取更早的
  //  #chat 里分三层：#older（加载更早）/ #hist（历史页）/ #live（本次打开后实时跑的）
  chatEl.innerHTML = `<button id="older" class="hidden">${t("加载更早的消息")}</button><div id="hist"></div><div id="live"></div>`;
  chatEl.appendChild(queueStrip);
  const olderEl = $("older"), histEl = $("hist"), liveEl = $("live");

  const view = {
    sessionId: null,
    gen: 0,              // 每换一次会话 +1，迟到的历史响应据此作废
    cursor: null,        // 历史翻页游标（字节偏移，0 = 到头）
    loading: false,
    runIds: new Set(),   // 属于本视图的 run（新会话在拿到会话号前靠它认亲）
    cids: new Set(),     // 本窗口发出的消息号
    lastRunId: null,
    title: "",
  };
  // run / queue 只算当前视图的（本会话正在跑的那一轮、本会话排着的）；runs / queueAll 是网关上的全部
  const srv = { run: null, queue: [], runs: [], queueAll: [], max: 3, connected: false };
  const runViews = new Map();     // runId → { av, startedAt }
  const TOOL_CARDS = new Map();   // tool_use id → 卡片（结果可能在另一页、另一个气泡里）
  const PENDING_RESULTS = new Map();

  function mkMsg(role, label, parent) {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    const name = label || (role === "user" ? t("你") : role === "sys" ? t("命令") : "Claude");
    el.innerHTML = `<div class="who"><span class="dot"></span>${esc(name)}</div><div class="bubble" dir="auto"></div>`;
    (parent || liveEl).appendChild(el);
    return el.querySelector(".bubble");
  }
  function addSysMsg(text, title, parent) {
    const b = mkMsg("sys", t("命令"), parent);
    setHtml(b, title
      ? `<div class="cmd-card"><div class="cmd-name">${esc(title)}</div>${renderMd(text)}</div>`
      : renderMd(text));
    scrollDown(true);
    return b;
  }
  function addNote(text, parent) {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = text;
    (parent || liveEl).appendChild(el);
    return el;
  }
  const ICONS = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    share: '<path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/>',
    resend: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
  };
  const actBtn = (a, label) => `<button data-a="${a}" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24">${ICONS[a]}</svg></button>`;
  function renderUser(text, parent) {
    const b = mkMsg("user", null, parent);
    setHtml(b, renderMd(text));
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = actBtn("copy", t("复制")) + actBtn("resend", t("重发"));
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "copy") { navigator.clipboard?.writeText(text); toast(t("已复制")); }
      if (a === "resend") { inputEl.value = text; autoGrow(); inputEl.focus(); }
    });
    b.parentElement.appendChild(acts);
    return b;
  }

  // ── 渲染规矩（沿用 2026-10-13 的教训，并更进一步）──────────────────
  //   · 正文增量渲染：空行处（且不在代码块里）把前面的部分"冻结"成定稿 DOM，
  //     之后每帧只重渲染最后那一小段 —— 再长的回答也是 O(n)，不是 O(n²)
  //   · 思考块折叠时一个字符都不进 DOM，只更新字数；展开流式只贴尾巴
  //   · 工具卡的参数/结果点开才渲染
  const THINK_TAIL = 4000;
  const THINK_CAP  = 200000;
  const THINK_TICK = 250;
  const PAINT_TICK = 60;
  const DOTS = `<div class="dots"><span></span><span></span><span></span></div>`;
  const fmtChars = (n) => (n < 1000 ? t("{n} 字", { n }) : t("{n}k 字", { n: (n / 1000).toFixed(1) }));

  /** from 之后、不在代码块里的最后一个空行位置；没有返回 -1 */
  function safeSplit(s, from) {
    const re = /^[ \t]*```/gm;
    re.lastIndex = from;
    let inCode = false, regionStart = from, best = -1, m;
    const consider = (a, b) => {
      const i = s.lastIndexOf("\n\n", b - 1);
      if (i >= a && i > from) best = i;
    };
    while ((m = re.exec(s))) {
      if (!inCode) consider(regionStart, m.index);
      inCode = !inCode;
      if (!inCode) regionStart = m.index + 3;
    }
    if (!inCode) consider(regionStart, s.length);
    return best;
  }

  function TextBlock(parent, live) {
    const el = document.createElement("div");
    el.className = "txt";
    const frozen = document.createElement("div"), tail = document.createElement("div");
    el.append(frozen, tail);
    parent.appendChild(el);
    let text = "", fz = 0, timer = 0;

    function paint(final) {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!final) {
        const idx = safeSplit(text, fz);
        if (idx > fz) {
          const c = document.createElement("div");
          setHtml(c, renderMd(text.slice(fz, idx)));
          frozen.appendChild(c);
          fz = idx;
        }
        tail.innerHTML = renderMd(text.slice(fz));   // 光标不跟在每段正文后面：整条回复只留一个，见 AssistantView 的 liveTail
      } else {
        setHtml(tail, renderMd(text.slice(fz)));
      }
      scrollDown();
    }
    return {
      kind: "text",
      append(t) { text += t; if (!timer) timer = setTimeout(() => paint(false), PAINT_TICK); },
      set(t) { text = t; if (live) { if (!timer) timer = setTimeout(() => paint(false), PAINT_TICK); } else paint(true); },
      finish() { if (live) paint(true); },
      get text() { return text; },
    };
  }

  function ThinkBlock(parent) {
    const el = document.createElement("details");
    el.className = "think";
    el.innerHTML = `<summary>${t("思考过程")} <span class="think-size"></span></summary><div class="think-body"></div>`;
    parent.appendChild(el);
    const body = el.querySelector(".think-body"), label = el.querySelector(".think-size");
    let thinking = "", timer = 0, shown = 0, moreBtn = null, done = false;

    function moreSync(left) {
      if (!moreBtn) {
        moreBtn = document.createElement("button");
        moreBtn.className = "think-more";
        moreBtn.addEventListener("click", () => { shown += THINK_CAP; render("full"); });
        el.appendChild(moreBtn);
      }
      moreBtn.textContent = t("继续渲染（还有 {left}）", { left: fmtChars(left) });
      moreBtn.style.display = left > 0 ? "block" : "none";
    }
    function render(mode) {
      if (!el.open) return;
      if (mode === "tail") {
        body.textContent = thinking.length > THINK_TAIL ? "…" + thinking.slice(-THINK_TAIL) : thinking;
        shown = 0; moreSync(0);
        return;
      }
      shown = Math.min(Math.max(shown, THINK_CAP), thinking.length);
      const left = thinking.length - shown;
      body.textContent = thinking.slice(0, shown) + (left > 0 ? "\n\n" + t("…（还有 {left}没渲染）", { left: fmtChars(left) }) : "");
      moreSync(left);
    }
    el.addEventListener("toggle", () => {
      if (el.open) render(done ? "full" : "tail");
      else { body.textContent = ""; shown = 0; }
    });
    const tick = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        label.textContent = fmtChars(thinking.length);
        if (el.open && !done) { render("tail"); scrollDown(); }
      }, THINK_TICK);
    };
    return {
      kind: "think",
      el,
      append(t) { thinking += t; tick(); },
      set(t) { thinking = t; done = true; label.textContent = fmtChars(thinking.length); },
      finish() {
        if (timer) { clearTimeout(timer); timer = 0; }
        done = true;
        label.textContent = fmtChars(thinking.length);
        if (el.open) render("full");
      },
    };
  }

  function summarizeTool(name, input) {
    if (!input) return "";
    const v = input.command || input.file_path || input.path || input.pattern ||
              input.url || input.prompt || input.description || input.skill || "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 90 ? s.slice(0, 90) + "…" : s;
  }

  function ToolBlock(parent, id, name, input, live) {
    const card = document.createElement("div");
    card.className = "tool";
    card.innerHTML =
      `<div class="tool-head"><span class="chev">▶</span><span class="tool-name">${esc(name)}</span>` +
      `<span class="tool-arg">${esc(summarizeTool(name, input))}</span>` +
      (input && /^\//.test(input.file_path || input.notebook_path || "") ? `<a class="fpath tool-open" href="#" data-path="${esc(input.file_path || input.notebook_path)}" title="${t("在查看器中打开")}">↗</a>` : "") +
      `<span class="tool-state ${live ? "run" : "ok"}">${live ? t("运行中") : "—"}</span></div>` +
      `<div class="tool-body"></div>`;
    parent.appendChild(card);
    const st = card.querySelector(".tool-state"), bodyEl = card.querySelector(".tool-body");
    let result = null, built = false;
    const build = () => {           // 点开才把参数、结果铺进 DOM
      if (built) return;
      built = true;
      let html = `<div class="lbl">${t("参数")}</div><pre>${esc(JSON.stringify(input, null, 2))}</pre>`;
      if (result) html += `<div class="lbl">${t("结果")}</div><pre>${esc(result.text)}</pre>`;
      bodyEl.innerHTML = html;
      if (result) embedLocalImages(bodyEl);
    };
    card.querySelector(".tool-head").addEventListener("click", (e) => {
      if (e.target.closest(".fpath")) return;          // 点的是"打开文件"，交给对话区的委托
      card.classList.toggle("open");
      if (card.classList.contains("open")) build();
    });
    const api = {
      kind: "tool",
      el: card,
      name, summary: summarizeTool(name, input), state: live ? "run" : "ok",
      onChange: null,
      result(ok, text) {
        result = { ok, text: String(text || "") };
        api.state = ok ? "ok" : "err";
        st.className = "tool-state " + (ok ? "ok" : "err");
        st.textContent = ok ? t("完成") : t("失败");
        if (built) { built = false; build(); }
        if (!ok && live) { card.classList.add("open"); build(); }
        // 工具产出的图片（渲染结果、截图）直接露出来，不用点开
        if (ok && /\.(png|jpe?g|gif|webp)\b/i.test(result.text)) {
          const peek = card.querySelector(".tool-peek") || document.createElement("div");
          peek.className = "tool-peek";
          peek.textContent = result.text.slice(0, 600);
          card.appendChild(peek);
          embedLocalImages(peek);
          const imgs = peek.querySelectorAll(".inline-img");
          if (imgs.length) peek.replaceChildren(...imgs);
          else peek.remove();
        }
        api.onChange && api.onChange();
      },
      stop() { if (!result) { api.state = "err"; st.className = "tool-state err"; st.textContent = t("中断"); api.onChange && api.onChange(); } },
      finish() { if (!result && !live) { st.textContent = "—"; } },
    };
    if (id) {
      TOOL_CARDS.set(id, api);
      const pend = PENDING_RESULTS.get(id);
      if (pend) { PENDING_RESULTS.delete(id); api.result(pend.ok, pend.text); }
    }
    return api;
  }
  /** 两段正文之间的工具调用（连同夹在中间的思考）收进一组：≥2 个工具时顶上出一行摘要
   *  （几步 · 最近一步 · 状态），默认收起。有待确认的权限卡、失败后自动展开的卡、带图片预览的卡时，
   *  样式（:has）让这一组保持展开。 */
  function ToolGroup(parent) {
    const el = document.createElement("div");
    el.className = "tgroup single";
    el.innerHTML = `<button class="tg-head" type="button"></button><div class="tg-body"></div>`;
    parent.appendChild(el);
    const head = el.firstChild, body = el.lastChild, members = [], inner = [];
    head.addEventListener("click", () => el.classList.toggle("open"));
    function refresh() {
      const n = members.length;
      el.classList.toggle("single", n < 2);
      if (n < 2) return;
      const lastM = members[n - 1];
      const run = members.some((m) => m.state === "run"), err = members.some((m) => m.state === "err");
      const [cls, txt] = run ? ["run", t("运行中")] : err ? ["err", t("有失败")] : ["ok", t("完成")];
      head.innerHTML = `<span class="chev">▶</span><span class="tg-count">${esc(t("{n} 个步骤", { n }))}</span>` +
        `<span class="tool-arg">${esc(lastM.name + (lastM.summary ? " " + lastM.summary : ""))}</span>` +
        `<span class="tool-state ${cls}">${esc(txt)}</span>`;
    }
    return {
      kind: "tgroup",
      body,
      get lastInner() { return inner[inner.length - 1]; },
      add(m) { members.push(m); inner.push(m); m.onChange = refresh; refresh(); },
      addThink(b) { inner.push(b); if (b.el.parentNode !== body) body.appendChild(b.el); },
      finish() { for (const b of inner) b.finish && b.finish(); refresh(); },
      stop() { for (const m of members) m.stop(); },
    };
  }
  function toolResult(id, ok, text) {
    const c = TOOL_CARDS.get(id);
    if (c) c.result(ok, text);
    else if (id) PENDING_RESULTS.set(id, { ok, text });   // 卡片在更早的一页里，翻到了再贴上
  }

  // ── 权限确认 ─────────────────────────────────────────────────────
  //  claude 要跑需确认的工具时，网关把 can_use_tool 转成 perm_request 事件。
  //  卡片挂在对应工具卡下面；输入框上方另有一条常驻提示（翻到上面去了、分屏切回来也看得见）。
  //  参数一律以 claude 发来的为准，前端只回「允许 / 拒绝 / 始终允许 / 选项答案」。
  const PERMS = new Map();          // id → { p, runId, el, done }
  const permBar = $("perm-bar");
  let permWaiting = false;          // 状态栏此刻显示的是「等你确认」
  const MODE_KEYS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
  const modeLabel = (m) => ({
    default: t("逐项确认"), acceptEdits: t("自动接受编辑"), plan: t("只做计划"),
    auto: t("自动判断"), dontAsk: t("不询问"), bypassPermissions: t("全部放行"),
  }[m] || m || "");
  function setPermChip(m) {
    if (!m) return;
    state.permissionMode = m;
    permEl.textContent = (m === "bypassPermissions" ? "⚠ " : "🔒 ") + modeLabel(m);
    permEl.classList.toggle("danger", m === "bypassPermissions");
  }

  function permRules(p) {
    const out = [];
    for (const s of p.suggestions || []) {
      if (s.type === "addRules") for (const r of s.rules || []) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    }
    return out;
  }
  const permSuggestsEdits = (p) => (p.suggestions || []).some((s) => s.type === "setMode" && s.mode === "acceptEdits");

  function diffHtml(oldS, newS) {
    const lines = (s, c) => String(s || "").split("\n").slice(0, 60).map((l) => `<span class="${c}">${c === "del" ? "-" : "+"} ${esc(l)}</span>`).join("\n");
    return `<pre class="perm-diff">${lines(oldS, "del")}\n${lines(newS, "add")}</pre>`;
  }
  function permPreview(p) {
    const i = p.input || {};
    let h = "";
    switch (p.tool) {
      case "Bash":
        h = `<pre class="perm-cmd">${esc(i.command || "")}</pre>` + (i.description ? `<div class="perm-sub">${esc(i.description)}</div>` : "");
        break;
      case "Edit":
        h = `<div class="perm-path">${esc(i.file_path || "")}</div>` + diffHtml(i.old_string, i.new_string);
        break;
      case "MultiEdit":
        h = `<div class="perm-path">${esc(i.file_path || "")}</div>` + (i.edits || []).slice(0, 8).map((e) => diffHtml(e.old_string, e.new_string)).join("");
        break;
      case "Write": {
        const c = String(i.content || ""), ls = c.split("\n");
        h = `<div class="perm-path">${esc(i.file_path || "")}</div><pre class="perm-diff">${ls.slice(0, 30).map((l) => `<span class="add">+ ${esc(l)}</span>`).join("\n")}${ls.length > 30 ? "\n" + esc(t("…（共 {n} 行）", { n: ls.length })) : ""}</pre>`;
        break;
      }
      case "NotebookEdit":
        h = `<div class="perm-path">${esc(i.notebook_path || "")}</div><pre class="perm-cmd">${esc(String(i.new_source || "").slice(0, 3000))}</pre>`;
        break;
      case "WebFetch": h = `<pre class="perm-cmd">${esc(i.url || "")}</pre>` + (i.prompt ? `<div class="perm-sub">${esc(i.prompt)}</div>` : ""); break;
      case "WebSearch": h = `<pre class="perm-cmd">${esc(i.query || "")}</pre>`; break;
      case "ExitPlanMode": h = `<div class="perm-plan">${renderMd(String(i.plan || ""))}</div>`; break;
      case "AskUserQuestion":
        h = (i.questions || []).map((q, qi) => `
          <div class="perm-q" data-q="${qi}">
            <div class="perm-qt">${esc(q.question || "")}</div>
            <div class="perm-opts">${(q.options || []).map((o) => `
              <label class="perm-opt"><input type="${q.multiSelect ? "checkbox" : "radio"}" name="pq-${esc(p.id)}-${qi}" value="${esc(o.label)}">
                <span><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ""}</span></label>`).join("")}
            </div>
            <input class="perm-other" placeholder="${t("或者直接写你的回答…")}">
          </div>`).join("");
        break;
      default:
        h = `<pre class="perm-cmd">${esc(JSON.stringify(i, null, 2).slice(0, 4000))}</pre>`;
    }
    if (p.blockedPath && !["Edit", "Write", "MultiEdit"].includes(p.tool) && !String(i.command || "").includes(p.blockedPath)) h += `<div class="perm-sub">${t("涉及路径：{p}", { p: esc(p.blockedPath) })}</div>`;
    if (p.reason && typeof p.reason === "string") h += `<div class="perm-sub">${t("原因：{r}", { r: esc(p.reason) })}</div>`;
    return h;
  }

  function permActions(p) {
    if (p.tool === "ExitPlanMode") return `
      <button class="pa-allow primary" data-mode="default">${t("批准，逐项确认执行")}</button>
      <button class="pa-allow" data-mode="acceptEdits">${t("批准，自动接受编辑")}</button>
      <button class="pa-more">${t("再改改 ▾")}</button>`;
    if (p.tool === "AskUserQuestion") return `
      <button class="pa-answer primary">${t("提交回答")}</button>
      <button class="pa-more">${t("不回答 ▾")}</button>`;
    const rules = permRules(p);
    return `
      <button class="pa-allow primary">${t("允许")}</button>
      ${rules.length ? `<button class="pa-always" title="${esc(rules.join("\n"))}">${t("始终允许")} <code>${esc(rules[0].length > 40 ? rules[0].slice(0, 40) + "…" : rules[0])}</code></button>` : ""}
      ${permSuggestsEdits(p) ? `<button class="pa-allow" data-mode="acceptEdits">${t("允许，之后的编辑都不再问")}</button>` : ""}
      <button class="pa-more">${t("拒绝 ▾")}</button>`;
  }

  function PermCard(p, runId) {
    const el = document.createElement("div");
    el.className = "perm";
    el.dataset.id = p.id;
    const kind = p.tool === "ExitPlanMode" ? t("计划待批准") : p.tool === "AskUserQuestion" ? t("Claude 想问你") : t("需要确认");
    el.innerHTML = `
      <div class="perm-head"><span class="perm-kind">⏸ ${kind}</span><span class="perm-tool">${esc(p.tool)}</span>${p.agentId ? `<span class="perm-sub">${t("子代理")}</span>` : ""}</div>
      <div class="perm-body">${permPreview(p)}</div>
      <div class="perm-acts">${permActions(p)}</div>
      <div class="perm-deny hidden">
        <textarea rows="2" placeholder="${p.tool === "ExitPlanMode" ? t("说说要怎么改（会发回给 Claude）") : t("可选：告诉 Claude 为什么 / 该怎么做")}"></textarea>
        <div class="perm-acts">
          <button class="pa-deny">${p.tool === "ExitPlanMode" ? t("发回意见") : t("拒绝")}</button>
          <button class="pa-stop">${t("拒绝并停止")}</button>
        </div>
      </div>`;
    const tc = p.toolUseId && TOOL_CARDS.get(p.toolUseId);
    if (tc && tc.el && tc.el.isConnected) tc.el.after(el);
    else {
      const rv = runViews.get(runId);
      (rv ? rv.av.bubble : liveEl).appendChild(el);
    }
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || el.classList.contains("done")) return;
      if (b.classList.contains("pa-more")) {
        el.querySelector(".perm-deny").classList.toggle("hidden");
        el.querySelector(".perm-deny textarea").focus();
        return;
      }
      const msg = el.querySelector(".perm-deny textarea").value.trim();
      if (b.classList.contains("pa-allow")) return permAnswer(p.id, { behavior: "allow", mode: b.dataset.mode && b.dataset.mode !== state.permissionMode ? b.dataset.mode : undefined });
      if (b.classList.contains("pa-always")) return permAnswer(p.id, { behavior: "allow", always: true });
      if (b.classList.contains("pa-deny")) return permAnswer(p.id, { behavior: "deny", message: msg });
      if (b.classList.contains("pa-stop")) return permAnswer(p.id, { behavior: "deny", message: msg, interrupt: true });
      if (b.classList.contains("pa-answer")) {
        const answers = {};
        el.querySelectorAll(".perm-q").forEach((qe) => {
          const q = (p.input.questions || [])[+qe.dataset.q];
          const other = qe.querySelector(".perm-other").value.trim();
          const picked = [...qe.querySelectorAll("input:checked")].map((x) => x.value);
          const v = other || picked.join(", ");
          if (q && v) answers[q.question] = v;
        });
        if (!Object.keys(answers).length) return toast(t("先选一个选项，或者写下你的回答"), true);
        return permAnswer(p.id, { behavior: "allow", answers });
      }
    });
    return el;
  }

  async function permAnswer(id, body) {
    const it = PERMS.get(id);
    if (!it || it.done) return;
    it.el?.classList.add("busy");
    try {
      await api("/api/perm/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: it.runId, id, ...body }) });
      permDone(id, body.behavior, { always: body.always, interrupt: body.interrupt });
    } catch (e) {
      it.el?.classList.remove("busy");
      if (e.status === 409) permDone(id, "gone");
      else toast(e.message, true);
    }
  }

  function permDone(id, behavior, o = {}) {
    const it = PERMS.get(id);
    if (!it || it.done) return;
    it.done = true;
    const p = it.p;
    const what = p.tool === "Bash" ? (p.input.command || "") : (p.input.file_path || p.input.url || p.input.query || "");
    const label = behavior === "allow"
      ? (p.tool === "ExitPlanMode" ? t("✓ 已批准计划") : p.tool === "AskUserQuestion" ? t("✓ 已回答") : o.always ? t("✓ 已允许（始终）") : t("✓ 已允许"))
      : behavior === "deny" ? (o.interrupt ? t("✗ 已拒绝并停止") : p.tool === "ExitPlanMode" ? t("↩ 已退回修改") : t("✗ 已拒绝"))
      : behavior === "cancel" ? t("已撤回") : behavior === "stopped" ? t("已停止（这一轮结束了）") : t("已失效");
    const tc = p.toolUseId && TOOL_CARDS.get(p.toolUseId);
    if (it.el && tc && tc.el && tc.el.isConnected && p.tool !== "ExitPlanMode" && p.tool !== "AskUserQuestion") {
      const tag = document.createElement("span");
      tag.className = "perm-tag " + (behavior === "allow" ? "ok" : "no");
      tag.textContent = label;
      tc.el.querySelector(".tool-state")?.before(tag);
      it.el.remove();
      it.el = null;
    } else if (it.el) {
      it.el.classList.remove("busy");
      it.el.classList.add("done", behavior === "allow" ? "ok" : "no");
      // 收起成一行，留在记录里；计划和问答的正文还有用，留着
      if (p.tool !== "ExitPlanMode" && p.tool !== "AskUserQuestion") it.el.querySelector(".perm-body").remove();
      it.el.querySelectorAll(".perm-acts, .perm-deny").forEach((x) => x.remove());
      it.el.querySelectorAll("input").forEach((x) => { x.disabled = true; });
      it.el.querySelector(".perm-head").innerHTML = `<span class="perm-res">${label}</span><span class="perm-tool">${esc(p.tool)}</span><span class="tool-arg">${esc(String(what).slice(0, 90))}</span>`;
    }
    renderPermBar();
  }

  function onPermRequest(ev) {
    const old = PERMS.get(ev.id);
    if (old && old.el && old.el.isConnected) return;      // 重放来的重复事件
    const it = { p: ev, runId: ev.runId, el: null, done: false };
    PERMS.set(ev.id, it);
    it.el = PermCard(ev, ev.runId);
    renderPermBar();
    scrollDown();
  }

  function pendingPerms() {
    return [...PERMS.values()].filter((it) => !it.done && runViews.has(it.runId));
  }
  function renderPermBar() {
    const list = pendingPerms();
    permBar.classList.toggle("hidden", !list.length && !state.settings.permNotice);
    if (!list.length) {
      permBar.innerHTML = state.settings.permNotice ? `
        <div class="pb-note"><span>${t("权限模式已改为「逐项确认」，与官方一致：改文件、跑命令前会先问你。想恢复全部放行，点下方的权限标签。")}</span>
        <button class="pb-x" aria-label="${t("关闭")}">✕</button></div>` : "";
      if (permWaiting && srv.run) setStatus(t("生成中…"), "warn");
      permWaiting = false;
      return;
    }
    const f = list[0].p, simple = (it) => it.p.tool !== "ExitPlanMode" && it.p.tool !== "AskUserQuestion";
    const what = f.tool === "Bash" ? f.input.command : (f.input.file_path || f.input.url || f.input.query || "");
    permBar.innerHTML = `
      <div class="pb-main">
        <span class="pb-txt">⏸ ${f.tool === "ExitPlanMode" ? t("计划待批准") : f.tool === "AskUserQuestion" ? t("Claude 想问你") : t("Claude 在等你确认") + " · "}${simple(list[0]) ? `<b>${esc(f.tool)}</b> <span class="mono">${esc(String(what || "").slice(0, 80))}</span>` : ""}</span>
        ${simple(list[0]) ? `<button class="pb-allow primary">${t("允许")}</button>` : ""}
        <button class="pb-view">${t("查看")}</button>
      </div>
      ${list.length > 1 ? `<div class="pb-more">${t("还有 {n} 项", { n: list.length - 1 })}
        ${list.every(simple) ? `<button class="pb-all">${t("全部允许")}</button>` : ""}</div>` : ""}`;
    setStatus(t("等你确认…"), "warn");
    permWaiting = true;
  }
  permBar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("pb-x")) {
      state.settings.permNotice = false;
      renderPermBar();
      api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permNotice: false }) }).catch(() => {});
      return;
    }
    const list = pendingPerms();
    if (!list.length) return;
    if (b.classList.contains("pb-view")) { list[0].el?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    if (b.classList.contains("pb-allow")) return permAnswer(list[0].p.id, { behavior: "allow" });
    if (b.classList.contains("pb-all")) list.forEach((it) => permAnswer(it.p.id, { behavior: "allow" }));
  });

  // 顶栏（输入框下）的权限标签：点开切模式，对应官方 TUI 的 Shift+Tab
  permEl.addEventListener("click", (e) => {
    e.stopPropagation();
    let m = $("perm-menu");
    if (m) { m.remove(); return; }
    m = document.createElement("div");
    m.id = "perm-menu";
    const desc = {
      default: t("读文件不问；改文件、跑命令、联网前先问你"),
      acceptEdits: t("改文件不问，跑命令还要问"),
      plan: t("只读和出计划，等你批准再动手"),
      auto: t("由 Claude 的分类器判断哪些要问（实验）"),
      bypassPermissions: t("什么都不问。Claude 可以不经你同意删文件、跑任意命令"),
    };
    m.innerHTML = MODE_KEYS.map((k) => `
      <button data-mode="${k}" class="${k === state.permissionMode ? "cur" : ""}${k === "bypassPermissions" ? " danger" : ""}">
        <b>${modeLabel(k)}</b><small>${desc[k]}</small></button>`).join("");
    document.body.appendChild(m);
    const r = permEl.getBoundingClientRect();
    m.style.bottom = (innerHeight - r.top + 6) + "px";
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + "px";
    m.addEventListener("click", async (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      m.remove();
      changePermMode(b.dataset.mode);
    });
  });
  document.addEventListener("click", (e) => { const m = $("perm-menu"); if (m && !m.contains(e.target)) m.remove(); });

  async function changePermMode(mode) {
    if (!mode || mode === state.permissionMode) return;
    if (mode === "bypassPermissions" && !confirm(t("切到「全部放行」？\n\nClaude 将不再询问，可以直接改写、删除文件，运行任意命令，访问网络。只在你信任当前任务、且出了事能承受的时候用。"))) {
      $("set-perm").value = state.permissionMode;
      return;
    }
    try {
      const r = await api("/api/perm/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      state.settings.permissionMode = r.mode;
      setPermChip(r.mode);
      $("set-perm").value = r.mode;
      toast(r.live ? t("已切到「{m}」，这一轮当场生效", { m: modeLabel(r.mode) }) : t("已切到「{m}」", { m: modeLabel(r.mode) }));
    } catch (err) { toast(err.message, true); }
  }

  // 回复底下的「复制 / 转发」：只取正文（Markdown 原文，多段之间空一行），思考和工具调用不算。
  // 转发走外壳的系统分享面板（CCApp.shareText）；外壳没有这个接口时退回 Web Share，都没有就不显示。
  const canShareText = () => !!((window.CCApp && CCApp.shareText) || navigator.share);
  function replyActs(msgEl, getText) {
    if (!getText() || msgEl.querySelector(":scope > .msg-acts")) return;
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = actBtn("copy", t("复制")) + (canShareText() ? actBtn("share", t("转发")) : "");
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a, text = getText();
      if (a === "copy") { navigator.clipboard?.writeText(text); toast(t("已复制")); }
      if (a === "share") {
        if (window.CCApp && CCApp.shareText) CCApp.shareText(text);
        else navigator.share({ text }).catch(() => {});
      }
    });
    msgEl.appendChild(acts);
  }

  /** 一条 Claude 回复：思考 / 正文 / 工具按真实顺序交错排列 */
  function AssistantView(parent, live) {
    const bubble = mkMsg("bot", null, parent);
    const msgEl = bubble.parentElement;
    let dots = null;
    if (live) { bubble.innerHTML = DOTS; dots = bubble.firstChild; }
    const blocks = [];
    let last = null, any = false, ended = false;
    const undot = () => { if (dots) { dots.remove(); dots = null; } };
    // 生成中只在最末尾留一个光标 + 用时：每加一块就把它挪回气泡最后（工具卡跑着时也在）
    let liveTail = null, tailTime = null;
    if (live) {
      liveTail = document.createElement("div");
      liveTail.className = "live-tail";
      liveTail.innerHTML = '<span class="cursor"></span><span class="tail-time"></span>';
      tailTime = liveTail.lastChild;
    }
    const keepTail = () => { if (liveTail && !ended) bubble.appendChild(liveTail); };
    const push = (b) => { undot(); blocks.push(b); last = b; any = true; keepTail(); return b; };
    const textB = () => (last && last.kind === "text" ? last : push(TextBlock(bubble, live)));
    // 正在攒的步骤组（工具 + 中间的思考）；一出正文就收口
    const inGroup = () => last && last.kind === "tgroup";
    const groupThink = () => { const b = ThinkBlock(last.body); last.addThink(b); return b; };
    const thinkB = () => {
      if (inGroup()) { const li = last.lastInner; return li && li.kind === "think" ? li : groupThink(); }
      return last && last.kind === "think" ? last : push(ThinkBlock(bubble));
    };
    return {
      msgEl, bubble, tailTime,
      delta(t) { textB().append(t); },
      text(t) { push(TextBlock(bubble, live)).set(t); },
      thinkDelta(t) { thinkB().append(t); },
      thinking(t) { (inGroup() ? groupThink() : push(ThinkBlock(bubble))).set(t); },
      tool(id, name, input) {
        let g = last;
        if (!inGroup()) {
          const prev = last && last.kind === "think" ? last : null;      // 紧挨着的那段思考也收进来
          g = ToolGroup(bubble);
          if (prev) { blocks.splice(blocks.indexOf(prev), 1); g.addThink(prev); }
          push(g);
        }
        g.add(ToolBlock(g.body, id, name, input, live));
        keepTail();
        scrollDown();
      },
      error(msg) {
        undot(); any = true; last = null;
        bubble.insertAdjacentHTML("beforeend", `<div class="err-box">${esc(msg)}</div>`);
        keepTail();
        scrollDown();
      },
      note(t, solid) { undot(); last = null; if (solid) any = true; bubble.insertAdjacentHTML("beforeend", `<p class="run-note">${esc(t)}</p>`); keepTail(); },
      finish(aborted) {
        if (ended) return;
        ended = true;
        liveTail?.remove();
        for (const b of blocks) { b.finish && b.finish(); if (aborted && b.stop) b.stop(); }
        undot();
        if (!any && live && !aborted) bubble.innerHTML = '<p class="muted">' + t("（无输出）") + '</p>';
        replyActs(msgEl, () => blocks.filter((b) => b.kind === "text").map((b) => b.text.trim()).filter(Boolean).join("\n\n"));
      },
      get empty() { return !any; },
      get ended() { return ended; },
      remove() { msgEl.remove(); },
    };
  }

  // ── 生成计时：从网关记下的开始时刻算（同一台机器的时钟），断线重连接上的那一轮也对得上 ──
  function fmtDur(ms, fine) {
    const s = Math.max(0, ms / 1000);
    if (s < 60) return (fine ? s.toFixed(1) : Math.floor(s)) + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(Math.floor(s % 60)).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function RunTimer(startedAt) {
    const el = document.createElement("span");
    el.className = "tag run-timer live";
    const t0 = startedAt || Date.now();
    let tail = null;     // 回复末尾光标旁的那一份。有它时顶部那份先藏着，结束后才显示「用时」—— 两处同时跳秒太吵
    const tick = () => { const d = fmtDur(Date.now() - t0); if (tail) tail.textContent = d; else el.textContent = d; };
    tick();
    let iv = setInterval(tick, 1000);
    return {
      attach(av) { av.msgEl.querySelector(".who")?.appendChild(el); tail = av.tailTime; el.hidden = !!tail; tick(); },
      stop() {
        if (!iv) return;
        clearInterval(iv); iv = 0;
        el.classList.remove("live"); el.hidden = false;
        el.textContent = t("用时 {d}", { d: fmtDur(Date.now() - t0, true) });
      },
    };
  }

  /** 历史页：一段 transcript 条目 → 一个 .page 容器 */
  function renderItems(items) {
    const page = document.createElement("div");
    page.className = "page";
    let av = null;
    const avs = [];
    for (const m of items) {
      if (m.role === "user") { renderUser(m.text, page); av = null; continue; }
      if (m.role === "note") { addNote(m.text, page); av = null; continue; }
      if (m.role === "tool_result") { toolResult(m.id, m.ok, m.text); continue; }
      if (!av) { av = AssistantView(page, false); avs.push(av); }
      if (m.role === "assistant") av.text(m.text);
      else if (m.role === "thinking") av.thinking(m.text);
      else if (m.role === "tool_use") av.tool(m.id, m.name, m.input);
    }
    for (const a of avs) a.finish();
    return page;
  }

  // ── 上下文用量 ────────────────────────────────────────────────────
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
    return (n / 1048576).toFixed(2) + "M";
  }
  /** 刻度以【自动压缩窗口】为准；没设才退回模型窗口 */
  function updateCtx(used, total) {
    if (used != null) state.ctxUsed = used;
    if (total) state.ctxTotal = total;
    const line = state.compactAt || 0;
    const scale = line > 0 ? line : (state.ctxTotal || 0);
    if (!scale) return;
    const pct = Math.min(100, Math.round((state.ctxUsed / scale) * 100));
    ctxBar.classList.remove("hidden", "warn", "danger");
    if (pct >= 100) ctxBar.classList.add("danger");
    else if (pct >= 85) ctxBar.classList.add("warn");
    ctxFill.style.width = pct + "%";
    ctxTxt.textContent = line > 0
      ? t("上下文 {used} / 压缩线 {line} · {pct}%", { used: fmtTok(state.ctxUsed), line: fmtTok(line), pct })
      : t("上下文 {used} / {total} · {pct}%", { used: fmtTok(state.ctxUsed), total: fmtTok(state.ctxTotal), pct });
    saveUiState();
  }
  /** 从 /context 的输出里抠出真实占用（形如 "**Tokens:** 17.9k / 200k (9%)"） */
  function parseContextText(t) {
    const num = (v, u) => {
      let n = parseFloat(v);
      const s = (u || "").toLowerCase();
      if (s === "k") n *= 1000;
      if (s === "m") n *= 1e6;
      return Math.round(n);
    };
    let m = t.match(/\*{0,2}Tokens:?\*{0,2}\s*([\d.]+)\s*([km])?\s*\/\s*([\d.]+)\s*([km])?/i);
    if (m) return updateCtx(num(m[1], m[2]), num(m[3], m[4]));
    m = t.match(/\|\s*(?:Used|已用)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i);
    if (m) {
      const used = num(m[1], m[2]);
      const tot = t.match(/\|\s*(?:Total|总计)\s*\|\s*([\d.]+)\s*([km])?\s*\|/i);
      return updateCtx(used, tot ? num(tot[1], tot[2]) : state.ctxTotal);
    }
  }

  // ── 会话切换 / 历史翻页 ────────────────────────────────────────────
  function resetView(sessionId) {
    view.sessionId = sessionId || null;
    view.gen++;
    view.cursor = null;
    view.loading = false;
    view.runIds = new Set();
    view.cids = new Set();
    view.lastRunId = null;
    view.title = "";
    histEl.innerHTML = "";
    liveEl.innerHTML = "";
    for (const rv of runViews.values()) rv.timer?.stop();
    runViews.clear();
    TOOL_CARDS.clear();
    PENDING_RESULTS.clear();
    olderEl.classList.add("hidden");
    statEl.textContent = "";
    pickViewRun();                     // 换了会话：「本会话在不在跑」要重新算
    syncInterject();
    saveUiState();
  }

  /** 打开某个会话（null = 新会话）。重连事件流：网关会把正在跑的那一轮从头重放过来 */
  function openSession(id) {
    resetView(id);
    renderSessions();
    connectBus(false);
  }

  function newConversation(note) {
    openSession(null);
    updateCtx(0, state.ctxTotal);
    setStatus(note || t("新会话"), "ok");
    inputEl.focus();
  }

  function liveExclude() {
    const r = srv.run;
    return r && view.sessionId && r.sessionId === view.sessionId ? r.startedAt : 0;
  }

  async function loadOlder(initial) {
    const id = view.sessionId;
    if (!id || view.loading) return;
    if (!initial && !view.cursor) return;
    view.loading = true;
    const gen = view.gen;
    olderEl.textContent = t("加载中…");
    const q = new URLSearchParams({ limit: initial ? "40" : "60" });
    if (!initial) q.set("before", String(view.cursor));
    const ex = liveExclude();
    if (ex) q.set("exclude", String(ex));
    let r;
    try {
      r = await api(`/api/session/${encodeURIComponent(id)}?${q}`);
    } catch (e) {
      if (gen !== view.gen) return;
      view.loading = false;
      olderEl.textContent = t("加载更早的消息");
      if (e.status === 404 && initial) {
        // 记着的会话已经不在了（删掉了 / 清过数据）：当新会话处理，回到欢迎页，别挂一条让人摸不着头脑的提示
        view.sessionId = null;
        saveUiState();
        if (!liveEl.childElementCount) showWelcome();
      } else toast(t("读取历史失败：{msg}", { msg: e.message }), true);
      return;
    }
    if (gen !== view.gen) return;
    view.loading = false;
    view.cursor = r.cursor;
    view.title = r.title || "";
    const page = renderItems(r.items || []);
    if (initial) {
      histEl.innerHTML = "";
      histEl.appendChild(page);
      if (r.contextTokens != null) updateCtx(r.contextTokens, state.ctxTotal);
      setStatus(view.title ? t("会话：{title}", { title: view.title.slice(0, 40) }) : t("就绪"), "ok");
      scrollDown(true);
    } else {
      const h0 = chatEl.scrollHeight, t0 = chatEl.scrollTop;
      histEl.insertBefore(page, histEl.firstChild);
      chatEl.scrollTop = t0 + (chatEl.scrollHeight - h0);   // 往上补内容，视线别跳
    }
    olderEl.textContent = t("加载更早的消息");
    olderEl.classList.toggle("hidden", !r.cursor);
  }
  olderEl.addEventListener("click", () => loadOlder(false));
  chatScrollHooks.push(() => {
    if (chatEl.scrollTop < 240 && view.cursor && !view.loading && histEl.childElementCount) loadOlder(false);
  });

  function showWelcome() {
    const b = mkMsg("bot", null, histEl);
    const tips = [
      ["📎", t("附加图片或文件，也可以直接粘贴、拖进来")],
      ["/ @", t("输入 / 唤起斜杠命令，@ 引用文件路径")],
      ["📁 >_ ‹›", t("顶栏：文件浏览器、终端、命令面板")],
      ["☰", t("左上角：历史会话、设置、能力清单、扩展")],
      ["❄", t("页面滑不动、像卡住了：点顶栏的雪花就能恢复，不用重开应用")],
      ["🔒", t("输入框下方的权限标签：Claude 改文件、跑命令前要不要先问你，点一下就能换")],
      ["⚡", t("生成中可以接着发：回车排队，⚡ 插话（不打断，并进当前这一轮）")],
    ];
    // 第一次不知道问什么：点一下填进输入框，自己看过、改过再发
    const examples = [
      t("看看这台设备上装了哪些开发工具，挑三个各演示一下"),
      t("用 Python 统计工作区里各类文件的数量和总大小，整理成表格"),
      t("写一个单文件的贪吃蛇网页小游戏，做好后在浏览器里打开给我看"),
    ];
    b.innerHTML =
      t("<p>你好，我是跑在这台设备上的 <strong>Claude Code CLI</strong>。</p>") +
      `<ul class="welcome-tips">${tips.map(([k, v]) => `<li><strong>${esc(k)}</strong> ${esc(v)}</li>`).join("")}</ul>
       <p class="welcome-ex-h">${esc(t("不知道从哪开始？点一个试试（只填进输入框，不会直接发）："))}</p>
       <div class="welcome-ex">${examples.map((x) => `<button class="btn ghost sm">${esc(x)}</button>`).join("")}</div>
       <div class="setup-guide hidden"></div>`;
    fillSetupGuide(b.querySelector(".setup-guide"));
    b.querySelector(".welcome-ex").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      inputEl.value = btn.textContent;
      autoGrow(); syncInterject(); inputEl.focus();
    });
  }

  /** 还没接上模型（没登录、没填 Key）：欢迎页里把两条路并排摆出来，不替用户选 */
  async function fillSetupGuide(box) {
    let s = null;
    try { s = await api("/api/status"); } catch { return; }
    let ready = s.keyMode === "key";
    if (s.keyMode === "login") { try { ready = !!(await api("/api/login/status")).loggedIn; } catch {} }
    if (ready || !box.isConnected) return;
    box.innerHTML = `<p><strong>${esc(t("开始之前，先接上模型（两条路选一条）："))}</strong></p>
      <div class="setup-paths">
        <div class="setup-path"><b>${esc(t("用 Claude 账户登录"))}</b>
          <div class="tiny">${esc(t("有 Claude Pro / Max 订阅，或 Anthropic Console 账户：在浏览器里授权一次就好，不用填 Key。"))}</div>
          <button class="btn sm" data-p="login">${esc(t("去登录"))}</button></div>
        <div class="setup-path"><b>${esc(t("填 API Key"))}</b>
          <div class="tiny">${esc(t("用 Anthropic 的 Key，或 DeepSeek、智谱 GLM、通义千问、Kimi 等兼容接口的 Key，按用量付费。"))}</div>
          <button class="btn sm" data-p="key">${esc(t("去选接口、填 Key"))}</button></div>
      </div>
      <div class="tiny">${esc(t("两条路都在 ☰ → 设置 → 接口，以后随时能换。"))}</div>`;
    box.classList.remove("hidden");
    box.addEventListener("click", (e) => {
      const p = e.target.dataset && e.target.dataset.p;
      if (!p) return;
      openDrawer("settings");
      const sel = $("set-provider");
      if (p === "login" && [...sel.options].some((o) => o.value === "anthropic")) {
        sel.value = "anthropic";
        sel.dispatchEvent(new Event("change"));
      }
      setTimeout(() => sel.scrollIntoView({ block: "center" }), 50);
      if (p === "key") sel.focus();
    });
  }

  // ── 事件总线 ──────────────────────────────────────────────────────
  let es = null, lastEventId = "", helloCount = 0, busWatch = 0;

  function connectBus(resume) {
    if (es) { try { es.close(); } catch {} }
    const url = "/api/events" + (resume && lastEventId ? "?since=" + encodeURIComponent(lastEventId) : "");
    es = new EventSource(url);
    es.onmessage = (m) => {
      if (m.lastEventId) lastEventId = m.lastEventId;
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      try { onBus(ev); } catch (e) { console.error(e); }
    };
    es.onopen = () => setConn(true);
    es.onerror = () => {
      setConn(false);
      // 网关重启时浏览器有时会直接放弃（CLOSED）：那就自己再拨
      if (es.readyState === 2) { clearTimeout(busWatch); busWatch = setTimeout(() => connectBus(true), 2000); }
    };
  }
  function setConn(ok) {
    srv.connected = ok;
    if (!ok) setStatus(t("与网关断开，正在重连…（生成不受影响）"), "warn");
  }
  document.addEventListener("visibilitychange", () => {
    // 切回前台：WebView 在后台冻过，连接可能已经悄悄死了
    if (!document.hidden && (!es || es.readyState !== 1)) connectBus(true);
  });

  function belongs(ev) {
    if (view.runIds.has(ev.runId)) return true;
    if (ev.cid && view.cids.has(ev.cid)) return true;
    if (view.sessionId && ev.sessionId === view.sessionId) return true;
    if (ev.follow && view.runIds.has(ev.follow)) return true;
    return false;
  }

  function onBus(ev) {
    switch (ev.type) {
      case "hello": return onHello(ev);
      case "state": return applyState(ev);
      case "sync": return;
      case "run_start": {
        if (!belongs(ev)) return;
        view.runIds.add(ev.runId);
        view.lastRunId = ev.runId;
        if (runViews.has(ev.runId)) return;
        renderUser(ev.text, liveEl);
        const av = AssistantView(liveEl, true);
        if (ev.text.trim().startsWith("/")) av.msgEl.classList.add("sys");
        const timer = RunTimer(ev.startedAt);
        timer.attach(av);
        runViews.set(ev.runId, { av, startedAt: ev.startedAt, timer });
        scrollDown(true);
        return;
      }
      case "inject": {
        // 插话送达：在它被吃进去的位置画出这条消息，之后的回复另起一个气泡，时间顺序才对
        const rv = runViews.get(ev.runId);
        if (!rv) return;
        if (ev.cid) view.cids.add(ev.cid);
        rv.av.finish();
        if (rv.av.empty) rv.av.remove();
        renderUser(ev.text, liveEl);
        rv.av = AssistantView(liveEl, true);
        rv.timer?.attach(rv.av);          // 计时算整轮的，跟着最新的气泡走
        scrollDown(true);
        return;
      }
      case "init": {
        if (!view.runIds.has(ev.runId)) return;
        if (!view.sessionId && ev.sessionId) { view.sessionId = ev.sessionId; saveUiState(); }
        if (ev.model) { state.model = ev.model; modelEl.textContent = ev.model; }
        if (ev.permissionMode) setPermChip(ev.permissionMode);
        return;
      }
      case "run_end": return onRunEnd(ev);
      case "perm_mode":
        state.settings.permissionMode = ev.mode;
        setPermChip(ev.mode);
        if ($("set-perm")) $("set-perm").value = ev.mode;
        return;
      case "perm_request": if (runViews.has(ev.runId)) onPermRequest(ev); return;
      case "perm_resolved": return permDone(ev.id, ev.behavior, ev);
    }
    const rv = runViews.get(ev.runId);
    if (!rv) return;
    const av = rv.av;
    switch (ev.type) {
      case "usage":          if (ev.contextTokens) updateCtx(ev.contextTokens, state.ctxTotal); break;
      case "delta":          av.delta(ev.text); break;
      case "assistant_text": av.text(ev.text); break;
      case "thinking_delta": av.thinkDelta(ev.text); break;
      case "thinking":       av.thinking(ev.text); break;
      case "tool_use":       av.tool(ev.id, ev.name, ev.input); break;
      case "tool_result":    toolResult(ev.id, ev.ok, ev.text); scrollDown(); break;
      case "compacting":     av.note(t("正在压缩上下文…")); scrollDown(); break;
      case "compacted":
        av.note(ev.pre != null && ev.post != null
          ? t("上下文已压缩：{pre} → {post} tokens", { pre: ev.pre.toLocaleString(), post: ev.post.toLocaleString() })
          : t("上下文已压缩"), true);
        if (ev.post != null) updateCtx(ev.post, state.ctxTotal);
        scrollDown(); break;
      case "error":          av.error(ev.message + (ev.detail ? "\n\n" + ev.detail : "")); break;
    }
  }

  function onHello(ev) {
    helloCount++;
    if (ev.uiTag && uiTag != null && ev.uiTag !== uiTag) {
      // 新界面已经部署了：生成在网关里不受影响，放心刷新
      setStatus(t("界面已更新，正在刷新…"), "warn");
      location.reload();
      return;
    }
    if (ev.uiTag) uiTag = ev.uiTag;
    applyState(ev);
    if (ev.resume) { setStatus(t("已连接"), "ok"); return; }

    // 续不上（首次连接 / 网关重启过 / 断太久）：本视图从头来 —— 历史重新取，
    // 正在跑的那一轮紧接着会被网关整轮重放过来
    if (helloCount === 1 && ev.run && !ev.run.ended) {
      // 刚打开界面时网关正忙：直接跟上那一轮（这才是用户最后在干的事）
      if (ev.run.sessionId) view.sessionId = ev.run.sessionId;
      else { view.sessionId = null; view.runIds.add(ev.run.id); }
      saveUiState();
    } else if (helloCount === 1 && !ev.run && ev.interrupted?.sessionId && !view.sessionId) {
      // 刚打开、上一轮是被系统杀掉的：直接回到那个会话，「继续」卡就挂在它底下
      view.sessionId = ev.interrupted.sessionId;
      saveUiState();
    }
    const keepRuns = new Set(view.runIds), keepCids = new Set(view.cids);
    const sid = view.sessionId;
    resetView(sid);
    view.runIds = keepRuns; view.cids = keepCids;
    pickViewRun();
    renderSessions();
    if (sid) loadOlder(true);
    else if (!(ev.run && keepRuns.has(ev.run.id))) showWelcome();
    renderInterrupted(ev.interrupted);   // resetView 清掉了 liveEl，重挂一次
    setStatus(t("已连接"), "ok");
  }

  function onRunEnd(ev) {
    const rv = runViews.get(ev.runId);
    if (!rv) { if (belongs(ev)) loadSessions(); return; }
    const av = rv.av;
    rv.timer?.stop();
    for (const [id, it] of PERMS) if (it.runId === ev.runId && !it.done) permDone(id, "stopped");
    if (ev.sessionId && !view.sessionId && view.runIds.has(ev.runId)) { view.sessionId = ev.sessionId; saveUiState(); }
    if (ev.usage?.context_tokens) updateCtx(ev.usage.context_tokens, ev.usage.context_window || state.ctxTotal);

    if (ev.localCommand && ev.resultText) {
      av.finish();
      if (av.empty) av.remove();
            const b = mkMsg("sys", t("命令"), liveEl);
      setHtml(b, `<div class="cmd-card"><div class="cmd-name">${esc("/" + ev.localCommand)}</div>${renderMd(ev.resultText)}</div>`);
      if (ev.localCommand === "context") parseContextText(ev.resultText);
      if (ev.localCommand === "model" || ev.localCommand === "effort") loadSettings();
      // 压缩线的刻度在 loadModels 里刷（以前只有切模型才会调它，所以设完要切一次模型才看得到）
      if (ev.localCommand === "autocompact") loadModels();
    } else {
      av.finish(ev.aborted);
      if (ev.aborted) av.note(t("已中断"));
      const bits = [];
      if (ev.durationMs) bits.push((ev.durationMs / 1000).toFixed(1) + "s");
      if (ev.usage?.output_tokens) bits.push("↓" + ev.usage.output_tokens + " tok");
      if (ev.costUsd) bits.push("$" + ev.costUsd.toFixed(4));
      statEl.textContent = bits.join(" · ");
    }
    if (ev.failed) setStatus(t("失败"), "err");
    else if (ev.aborted) setStatus(t("已中断"), "warn");
    else setStatus(t("就绪"), "ok");
    scrollDown();
    loadSessions();
    if (!state.caps?.slashCommands?.length) loadCaps();
  }

  // ── 忙闲与排队（都以网关为准）──────────────────────────────────────
  function applyState(s) {
    srv.runs = s.runs || (s.run ? [s.run] : []);
    srv.queueAll = s.queue || [];
    if (s.maxParallel) srv.max = s.maxParallel;
    pickViewRun();
    const busy = !!srv.run;
    sendEl.classList.toggle("busy", busy && !inputEl.value.trim());
    inputEl.placeholder = busy
      ? t("生成中 · 回车 = 排队 · ⚡ = 插话（不打断）")
      : t("给 Claude 发消息，/ 命令，@ 引用文件…");
    syncInterject();
    renderQueue();
    // 别的窗口（或网关那边）已经答掉的，这里也收起来
    const livePerms = new Set((srv.run?.perms || []).map((p) => p.id));
    for (const [id, it] of PERMS) if (!it.done && srv.run && it.runId === srv.run.id && !livePerms.has(id) && it.p.at < Date.now() - 1500) permDone(id, "gone");
    if (busy) setStatus(t("生成中…"), "warn");
    else if (srv.runs.length) setStatus(t("另有 {n} 个会话在生成", { n: srv.runs.length }), "ok");
    // 别的会话在等你确认：当前视图看不到它的卡片，状态栏和会话列表里提醒
    const elsewhere = srv.runs.filter((r) => r !== srv.run && r.perms && r.perms.length);
    if (elsewhere.length) setStatus(t("另一个会话在等你确认 · 打开会话列表查看"), "warn");
    const live = srv.runs.map((r) => (r.sessionId || "") + (r.perms && r.perms.length ? "!" : "")).join(",");
    if (live !== srv.liveKey) { srv.liveKey = live; renderSessions(); }
    renderPermBar();                 // 放最后：有待确认项时状态栏要显示「等你确认」
    renderInterrupted(s.interrupted);
  }

  /** 上一轮被系统结束（App 连同网关被杀）：在那个会话底部挂一张卡，给「继续」 */
  function renderInterrupted(it) {
    let el = $("intr-card");
    const here = it && !srv.run && (it.sessionId ? it.sessionId === view.sessionId : !view.sessionId);
    if (!here) { el?.remove(); return; }
    if (el && el.dataset.id === it.id && el.parentNode === liveEl) return;
    el?.remove();
    const b = mkMsg("sys", t("已中断"), liveEl);
    el = b.closest(".msg"); el.id = "intr-card"; el.dataset.id = it.id;
    const when = new Date(it.startedAt || it.at).toLocaleString();
    setHtml(b, `<p>${esc(t("这一轮没跑完：App 在后台被系统结束了（{when} 开始的）。", { when }))}</p>
      <blockquote>${esc(String(it.text || "").slice(0, 300))}</blockquote>
      <p class="perm-sub">${esc(it.sessionId
        ? t("已经做完的部分都在会话里。点「继续」让 Claude 从断开的地方接着做。")
        : t("会话还没来得及建立，Claude 没收到这条消息。点「重发」把它放回输入框。"))}</p>
      <div class="perm-acts"><button class="primary" data-a="go">${esc(it.sessionId ? t("继续") : t("重发"))}</button>
      <button data-a="no">${esc(t("忽略"))}</button></div>`);
    b.querySelector(".perm-acts").addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (!a) return;
      el.remove();
      if (a === "go" && it.sessionId) return send(t("上一轮被系统中断了，请从断开的地方接着做完。"));
      if (a === "go") { inputEl.value = it.text || ""; autoGrow(); inputEl.focus(); }
      api("/api/interrupted/dismiss", { method: "POST" }).catch(() => {});
    });
    scrollDown(true);
  }
  const isBusy = () => !!srv.run;

  /** 并行多会话：从网关的全部轮次和队列里挑出属于当前视图的 */
  function runInView(r) {
    return (view.sessionId && r.sessionId === view.sessionId) || view.runIds.has(r.id) || (!!r.follow && view.runIds.has(r.follow)) || (!!r.cid && view.cids.has(r.cid));
  }
  function queuedInView(q) {
    if (q.sessionId) return q.sessionId === view.sessionId;
    return view.runIds.has(q.id) || (!!q.follow && view.runIds.has(q.follow)) || (!!q.cid && view.cids.has(q.cid));
  }
  function pickViewRun() {
    srv.run = srv.runs.filter(runInView).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    srv.queue = srv.queueAll.filter(queuedInView);
  }

  /** 插话键只在「正在跑 + 输入框里有字」时露头 */
  function syncInterject() {
    const has = !!inputEl.value.trim();
    interjectEl.classList.toggle("hidden", !(isBusy() && has));
    sendEl.classList.toggle("busy", isBusy() && !has);
  }

  function renderQueue() {
    const q = srv.queue;
    queueStrip.classList.toggle("hidden", !q.length);
    const busy = !!srv.run;
    queueStrip.innerHTML = q.length ? `
      <div class="q-head">
        <span>${q.some((it) => it.held)
          ? q.some((it) => it.intr)
            ? t("上一轮被系统中断，{n} 条排队的消息已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
            : t("点了停止，{n} 条已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
          : busy ? t("待发 {n} 条 · 当前这一轮结束后依次发出", { n: q.length })
          : t("同时在跑的会话已到上限（{max} 个），有空位就依次发出 · 待发 {n} 条", { max: srv.max, n: q.length })}</span>
        <button class="q-clear">${t("全部清除")}</button>
      </div>
      ${q.map((it) => `
        <div class="msg user qitem${it.held ? " held" : ""}" data-id="${esc(it.id)}">
          <div class="who"><span class="dot"></span>${t("你")} · <span class="q-tag">${it.held ? t("已暂停") : t("排队中")}</span></div>
          <div class="bubble" dir="auto">${esc(it.text)}</div>
          <div class="q-acts">
            <button class="q-now" title="${busy ? t("插话：递进正在跑的这一轮，不打断") : t("发出这条")}">${t("立即发送")}</button>
            <button class="q-x" title="${t("撤销这条")}">${t("撤销")}</button>
          </div>
        </div>`).join("")}` : "";
    if (q.length) scrollDown();
  }
  queueStrip.addEventListener("click", async (e) => {
    const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .catch((err) => toast(err.message, true));
    if (e.target.closest(".q-clear")) return post("/api/queue/clear", { ids: srv.queue.map((it) => it.id) });
    const item = e.target.closest(".qitem");
    if (!item) return;
    if (e.target.closest(".q-x")) return post("/api/queue/remove", { id: item.dataset.id });
    if (e.target.closest(".q-now")) return post("/api/queue/promote", { id: item.dataset.id });
  });

  // ── 发送 ──────────────────────────────────────────────────────────
  const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  async function send(forcedText, mode) {
    const fromInput = forcedText == null;
    const text = (fromInput ? inputEl.value : forcedText).trim();
    if (!text) return;
    hidePopup();

    // 纯界面命令：不惊动 claude
    if (text === "/clear" || text === "/new") {
      if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(); }
      newConversation(t("已清空上下文，开始新会话"));
      return;
    }
    // 官方账户登录：OAuth 全程由 claude 自己完成，网关只转递授权页地址；授权码不经手（要贴码就在终端里贴给 claude）
    if (text === "/login" || text === "/login console" || text.startsWith("/login ")) {
      if (fromInput) { inputEl.value = ""; autoGrow(); }
      const arg = text.slice(6).trim();
      const post = (p, body) => api(p, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      try {
        addNote(t("正在启动登录…"));
        const j = await post("/api/login/start", { method: arg === "console" ? "console" : "claudeai" });
        if (!j.ok) throw new Error(j.message || t("启动登录失败"));
        addSysMsg(t("在浏览器打开下面的地址完成授权，授权后浏览器跳回本机，登录自动完成：") + `\n\n[${j.url}](${j.url})\n\n` +
          t("浏览器跳不回来（比如在别的设备上授权）：打开终端运行 {cmd}，把页面给出的授权码直接贴给 claude。", { cmd: "`claude auth login`" }), "/login");
      } catch (e) { toast(e.message, true); }
      return;
    }
    if (text.startsWith("/rename ")) {
      if (!view.sessionId) return toast(t("当前还没有会话"), true);
      try {
        await api(`/api/session/${encodeURIComponent(view.sessionId)}/rename`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: text.slice(8).trim() }),
        });
        if (fromInput) { inputEl.value = ""; autoGrow(); }
        toast(t("已重命名")); loadSessions();
      } catch (e) { toast(e.message, true); }
      return;
    }

    const cid = newCid();
    view.cids.add(cid);
    if (fromInput) { inputEl.value = ""; autoGrow(); clearAttachments(); }
    syncInterject();
    try {
      const r = await api("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: view.sessionId,
          // 新会话还没拿到会话号时连发：告诉网关"跟在上一条后面"，它会接到同一个会话里
          follow: view.sessionId ? null : view.lastRunId,
          cid,
          mode: mode || "auto",
        }),
      });
      view.runIds.add(r.id);
      view.lastRunId = r.id;
      if (r.injected) toast(t("已插话：当前这一步做完，Claude 就会看到"));
      else if (!r.started) toast(mode === "inject" ? t("这一轮正在收尾，插不进去 —— 已排到最前，马上发出")
        : srv.run ? t("已排队，这一轮结束后发出") : t("同时在跑的会话已到上限，已排队，有空位就发出"));
    } catch (e) {
      view.cids.delete(cid);
      if (fromInput && !inputEl.value) { inputEl.value = text; autoGrow(); }   // 别把用户的话吞了
      toast(e.message || t("发送失败"), true);
      if (e.status === 503) openDrawer("settings");
    }
  }

  /** 插话：不打断，把输入框里的字递进正在跑的这一轮（claude 在当前这一步结束后就会看到） */
  function interjectNow() {
    if (!inputEl.value.trim()) return;
    send(null, "inject");
  }

  async function abort() {
    if (!srv.run) return;
    try { await api("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: srv.run.id }) }); }
    catch (e) { toast(e.message, true); }
  }

  // ── 补全浮层（/ 命令 与 @ 文件）───────────────────────────────────
  function hidePopup() {
    popupEl.classList.add("hidden");
    state.popup.mode = null;
    state.popup.items = [];
  }

  function showPopup(mode, items, head) {
    state.popup.mode = mode;
    state.popup.items = items;
    state.popup.sel = 0;
    popupHead.innerHTML = `<span>${esc(head)}</span><span>${t("{n} 项", { n: items.length })}</span>`;
    renderPopup();
    popupEl.classList.remove("hidden");
  }

  function renderPopup() {
    const { items, sel } = state.popup;
    let html = "", lastCat = null;
    items.forEach((it, i) => {
      if (it.cat && it.cat !== lastCat) { html += `<div class="pgroup">${esc(it.cat)}</div>`; lastCat = it.cat; }
      html += `<div class="pitem ${i === sel ? "sel" : ""}" data-i="${i}">` +
        `<span class="pi-name ${state.popup.mode === "cmd" ? "cmd" : ""}">${esc(it.label)}</span>` +
        (it.cat && state.popup.mode === "file" ? `<span class="pi-cat">${it.dir ? t("目录") : t("文件")}</span>` : "") +
        (it.desc ? `<span class="pi-desc">${esc(it.desc)}</span>` : "") +
        `</div>`;
    });
    popupList.innerHTML = html || '<div class="pitem">' + t("没有匹配项") + '</div>';
    const selEl = popupList.querySelector(".pitem.sel");
    if (selEl) selEl.scrollIntoView({ block: "nearest" });
  }

  function openCmdPalette(filter) {
    const caps = state.caps;
    const cmds = (caps?.slashCommands || []).filter((c) => !filter || c.name.includes(filter));
    showPopup("cmd", cmds.map((c) => ({ label: "/" + c.name, desc: c.desc || "", cat: c.cat, raw: c.name })),
      t("斜杠命令") + (filter ? t(" · 匹配 “{q}”", { q: filter }) : ""));
  }

  async function openFilePalette(filter) {
    const dir = state.fileDir || state.settings.workspace || "/sdcard";
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(dir)}&q=${encodeURIComponent(filter || "")}`);
      state.fileDir = r.path;
      const items = r.entries.map((e) => ({
        label: e.name + (e.dir ? "/" : ""),
        dir: e.dir,
        cat: r.path,
        raw: e.name,
      }));
      if (r.parent && r.parent !== r.path) items.unshift({ label: "..", dir: true, cat: r.path, raw: ".." });
      showPopup("file", items, t("引用文件 · {path}", { path: r.path }));
    } catch { hidePopup(); }
  }

  function applyPopupChoice(i) {
    const it = state.popup.items[i];
    if (!it) return;
    if (state.popup.mode === "cmd") {
      inputEl.value = "/" + it.raw + " ";
      hidePopup(); autoGrow(); inputEl.focus();
      return;
    }
    if (state.popup.mode === "file") {
      if (it.dir) { openFilePalette(""); return; }
      const base = state.fileDir || "";
      const full = base.replace(/\/$/, "") + "/" + it.raw;
      const v = inputEl.value;
      const at = v.lastIndexOf("@");
      inputEl.value = (at >= 0 ? v.slice(0, at) : v) + "@" + full + " ";
      hidePopup(); autoGrow(); inputEl.focus();
    }
  }

  // ── 输入框 ────────────────────────────────────────────────────────
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }

  /** 在光标处插入一段文本 */
  function insertAtCursor(s) {
    const v = inputEl.value, caret = inputEl.selectionStart ?? v.length;
    const before = v.slice(0, caret), after = v.slice(caret);
    const glue = before && !/\s$/.test(before) ? " " : "";
    inputEl.value = before + glue + s + " " + after;
    const pos = (before + glue + s + " ").length;
    try { inputEl.setSelectionRange(pos, pos); } catch {}
    autoGrow();
  }

  inputEl.addEventListener("input", () => {
    autoGrow();
    syncInterject();
    const v = inputEl.value;
    const caret = inputEl.selectionStart;
    const before = v.slice(0, caret);

    const cmdM = before.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
    if (cmdM) { openCmdPalette(cmdM[1]); return; }
    const atM = before.match(/@([^\s@]*)$/);
    if (atM) { openFilePalette(atM[1]); return; }
    hidePopup();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!popupEl.classList.contains("hidden") && state.popup.items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); state.popup.sel = (state.popup.sel + 1) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); state.popup.sel = (state.popup.sel - 1 + state.popup.items.length) % state.popup.items.length; renderPopup(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) {
        e.preventDefault(); applyPopupChoice(state.popup.sel); return;
      }
      if (e.key === "Escape") { hidePopup(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  // 粘贴：剪贴板里是图片就直接落盘成路径
  inputEl.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (!files.length) return;             // 纯文本粘贴，走默认行为
    e.preventDefault();
    await uploadFiles(files);
  });

  popupList.addEventListener("click", (e) => {
    const it = e.target.closest(".pitem");
    if (it?.dataset.i != null) applyPopupChoice(Number(it.dataset.i));
  });

  // 有字就发（忙时自动排队）；没字且正在生成 = 停止
  sendEl.addEventListener("click", () => (inputEl.value.trim() || !isBusy() ? send() : abort()));
  interjectEl.addEventListener("click", interjectNow);

  // ── 递东西进来：上传 ──────────────────────────────────────────────
  /// 新建附件条（点回形针/粘贴/拖放都汇到这里）
  const attachStrip = document.createElement("div");
  attachStrip.id = "attach-strip";
  attachStrip.className = "hidden";
  $("composer").insertBefore(attachStrip, $("composer-inner"));

  function renderAttachments() {
    const list = state.attachments;
    attachStrip.classList.toggle("hidden", !list.length);
    attachStrip.innerHTML = list.map((a, i) => `
      <div class="att" data-i="${i}">
        ${a.kind === "image"
          ? `<img src="${fileUrl(a.path)}" alt="">`
          : `<span class="att-ico">${esc((a.name.split(".").pop() || "?").slice(0, 4))}</span>`}
        <span class="att-name">${esc(a.name)}</span>
        <button class="att-x" aria-label="${t("移除")}">✕</button>
      </div>`).join("");
    attachStrip.querySelectorAll(".att").forEach((el) => {
      const a = list[Number(el.dataset.i)];
      el.querySelector("img")?.addEventListener("click", () => openLightbox(a.path));
      el.querySelector(".att-x").addEventListener("click", () => removeAttachment(a));
    });
  }
  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }
  /** 移除附件：连带把它插进输入框的那段路径一起删掉 */
  function removeAttachment(a) {
    state.attachments = state.attachments.filter((x) => x.path !== a.path);
    const re = new RegExp("@?" + a.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s?", "g");
    inputEl.value = inputEl.value.replace(re, "").replace(/\s{2,}/g, " ");
    autoGrow();
    renderAttachments();
  }

  /** 上传一批文件，成功后把路径插进输入框 */
  async function uploadFiles(files, { insert = true } = {}) {
    const list = [...files];
    if (!list.length) return [];
    const done = [];
    for (const f of list) {
      try {
        const r = await fetch("/api/upload?name=" + encodeURIComponent(f.name || "upload.bin"), {
          method: "POST",
          body: f,           // 直接流式送 File，fetch 自己带 content-type
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        done.push(j);
        if (insert) {
          state.attachments.push(j);
          insertAtCursor("@" + j.path);
        }
      } catch (e) {
        toast(t("「{name}」附加失败：{msg}", { name: f.name, msg: e.message }), true);
      }
    }
    if (done.length) {
      renderAttachments();
      toast(t("已附加 {n} 个文件", { n: done.length }));
    }
    return done;
  }

  // 安卓壳递进来的东西：别的应用「分享到 Claude CLI」，或系统选择器的结果
  window.addEventListener("ccapp-attach", (e) => {
    const p = e.detail?.value;
    if (!p) return;
    const name = p.split("/").pop();
    state.attachments.push({
      path: p, name, size: 0,
      kind: /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(p) ? "image" : "other",
    });
    insertAtCursor("@" + p);
    renderAttachments();
    toast(t("已附加 {name}", { name }));
  });
  window.addEventListener("ccapp-insert", (e) => {
    const t = e.detail?.value;
    if (!t) return;
    insertAtCursor(t);
    toast(t("已插入分享的内容"));
  });

  // 三扇门：点回形针 / 设置里选 / ＋ 面板
  function pickFiles() { fileInput.click(); }
  fileInput.addEventListener("change", async () => {
    await uploadFiles(fileInput.files);
    fileInput.value = "";
  });
  $("btn-attach").addEventListener("click", pickFiles);
  $("fs-pick").addEventListener("click", pickFiles);

  // 拖放（接了鼠标键盘的平板 / 桌面浏览器）
  const dropEl = $("dropzone");
  let dragDepth = 0;
  function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes("Files"); }
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++;
    dropEl.classList.remove("hidden");
  });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.add("hidden"); }
  });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; dropEl.classList.add("hidden");
    await uploadFiles(e.dataTransfer.files);
  });

  // ── 文件浏览器 ────────────────────────────────────────────────────
  const KIND_ICON = { dir: "📁", image: "🖼", video: "🎬", audio: "🎵", pdf: "📕", text: "📄", other: "📦" };

  function crumbs(p) {
    const parts = String(p).split("/").filter(Boolean);
    let acc = "";
    const html = ['<span class="crumb" data-p="/">/</span>'];
    parts.forEach((seg, i) => {
      acc += "/" + seg;
      const last = i === parts.length - 1;
      html.push(`<span class="crumb ${last ? "cur" : ""}" data-p="${esc(acc)}">${esc(seg)}</span>`);
    });
    return html.join('<span class="sep">/</span>');
  }

  async function openFiles(path) {
    filesEl.classList.remove("hidden");
    await fsLoad(path || state.fs.path || state.settings.workspace || "/sdcard");
  }

  async function fsLoad(p, { keepSel = false } = {}) {
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(p)}` +
        (state.fs.hidden ? "&hidden=1" : ""));
      Object.assign(state.fs, {
        path: r.path, parent: r.parent, entries: r.entries || [], roots: r.roots || [],
      });
      if (!keepSel) state.fs.sel = null;
      $("fs-search").value = state.fs.q = "";
      renderFs();
    } catch (e) { toast(t("打开目录失败：{msg}", { msg: e.message }), true); }
  }

  function fsVisible() {
    const q = state.fs.q.toLowerCase();
    return q ? state.fs.entries.filter((e) => e.name.toLowerCase().includes(q)) : state.fs.entries;
  }

  function renderFs() {
    $("fs-crumbs").innerHTML = crumbs(state.fs.path || "");
    $("fs-roots").innerHTML = (state.fs.roots || [])
      .map((r) => `<span class="chip" data-p="${esc(r)}">${esc(r.replace(/^\/sdcard/, "~"))}</span>`).join("");

    const list = fsVisible();
    $("fs-count").textContent = t("{n} 项 · {path}", { n: list.length, path: state.fs.path || "" });
    $("fs-list").innerHTML = list.length ? list.map((e, i) => `
      <div class="item fs-item ${state.fs.sel === e.name ? "active" : ""}" data-i="${i}">
        <div class="fs-row">
          <span class="fs-ico">${KIND_ICON[e.kind] || "📦"}</span>
          <span class="it-title">${esc(e.name)}${e.dir ? "/" : ""}</span>
          <span class="fs-meta">${e.dir ? "" : fmtSize(e.size)}</span>
        </div>
      </div>`).join("") : '<div class="tiny">' + t("（空目录）") + '</div>';

    // 图片直接出缩略图，别的类型给一行摘要
    if (list.some((e) => e.kind === "image")) {
      $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
        const e = list[Number(el.dataset.i)];
        if (e.kind !== "image") return;
        const t = document.createElement("img");
        t.className = "fs-thumb";
        t.loading = "lazy";
        t.src = fileUrl(state.fs.path.replace(/\/$/, "") + "/" + e.name);
        el.querySelector(".fs-row").prepend(t);
        el.querySelector(".fs-ico").remove();
      });
    }

    $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
      const e = list[Number(el.dataset.i)];
      el.addEventListener("click", () => (e.dir ? fsLoad(state.fs.path.replace(/\/$/, "") + "/" + e.name) : fsSelect(e)));
      if (!e.dir) el.addEventListener("dblclick", () => { insertFile(e); });
      el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); fsRename(e); });   // 长按 = 重命名
    });

    $("fs-insert").disabled = !state.fs.sel;
    renderFsPreview();
    fsGitDots();
  }

  const fullPathOf = (e) => state.fs.path.replace(/\/$/, "") + "/" + e.name;

  function fsSelect(e) {
    state.fs.sel = e.name;
    renderFs();
  }

  async function renderFsPreview() {
    const box = $("fs-preview");
    if (!state.fs.sel) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const e = state.fs.entries.find((x) => x.name === state.fs.sel);
    if (!e) { box.classList.add("hidden"); return; }
    const full = fullPathOf(e);
    box.classList.remove("hidden");

    let body = "";
    if (e.kind === "image") {
      body = `<img src="${fileUrl(full)}" alt="">`;
    } else if (e.kind === "video") {
      body = `<video src="${fileUrl(full)}" controls preload="metadata"></video>`;
    } else if (e.kind === "audio") {
      body = `<audio src="${fileUrl(full)}" controls></audio>`;
    } else if (e.kind === "text" && e.size < 262144) {
      box.innerHTML = `<div class="fs-prev-head"><span class="mono">${esc(e.name)}</span><span class="tiny">${t("读取中…")}</span></div>`;
      try {
        const txt = await fetch(fileUrl(full)).then((r) => r.text());
        body = `<pre class="fs-pre">${esc(txt.slice(0, 12000))}${txt.length > 12000 ? "\n" + t("…（已截断）") : ""}</pre>`;
      } catch { body = '<div class="tiny">' + t("读取失败") + '</div>'; }
    } else {
      body = `<div class="tiny">${e.kind} · ${fmtSize(e.size)} · ${t("无可内嵌预览")}</div>`;
    }

    box.innerHTML =
      `<div class="fs-prev-head">
         <span class="mono">${esc(e.name)}</span>
         <span class="tiny">${fmtSize(e.size)}</span>
         <button class="btn sm" data-a="open">${e.kind === "text" ? t("打开 / 编辑") : t("打开")}</button>
         <button class="btn ghost sm" data-a="insert">${t("插入 @路径")}</button>
         <button class="btn ghost sm" data-a="rename">${t("重命名")}</button>
         <a class="btn ghost sm" href="${fileUrl(full, true)}" download>⤓</a>
       </div>
       <div class="fs-prev-body">${body}</div>`;
    box.querySelector('[data-a="insert"]')?.addEventListener("click", () => insertFile(e));
    box.querySelector('[data-a="rename"]')?.addEventListener("click", () => fsRename(e));
    box.querySelector('[data-a="open"]')?.addEventListener("click", () => openViewer(full, e.kind, e.size));
    box.querySelector("img")?.addEventListener("click", () => openViewer(full, e.kind, e.size));
  }

  function insertFile(e) {
    const full = e.dir ? fullPathOf(e) + "/" : fullPathOf(e);
    insertAtCursor("@" + full);
    toast(e.dir ? t("已插入目录路径") : t("已插入文件路径"));
    closeFiles();
    inputEl.focus();
  }

  function closeFiles() { filesEl.classList.add("hidden"); }

  // 新建 / 重命名：都不覆盖已有的同名项。新建文件默认 .txt，建好直接进编辑器；想换类型就改后缀
  const fsErr = (e) => toast(/exists|409/.test(e.message) ? t("已经有同名的文件或文件夹") : t("操作失败：{msg}", { msg: e.message }), true);
  const badName = (n) => !n || n === "." || n === ".." || /[\/\0]/.test(n);
  async function fsCreate(dir) {
    if (!state.fs.path) return;
    const name = (prompt(dir ? t("新文件夹名称") : t("新文件名称（改后缀就是别的类型）"), dir ? t("新建文件夹") : t("新建文本") + ".txt") || "").trim();
    if (!name) return;
    if (badName(name)) return toast(t("名称里不能有 /"), true);
    const full = state.fs.path.replace(/\/$/, "") + "/" + name;
    try {
      const r = await api(`/api/file/${dir ? "mkdir" : "new"}?path=${encodeURIComponent(full)}`, { method: "POST" });
      if (dir) return fsLoad(r.path);
      await fsLoad(state.fs.path);
      state.fs.sel = name; renderFs();
      openViewer(r.path, r.kind === "other" ? "text" : r.kind, 0);   // 空文件：没有识别出类型的也当文本开
    } catch (e) { fsErr(e); }
  }
  async function fsRename(e) {
    const name = (prompt(t("重命名为"), e.name) || "").trim();
    if (!name || name === e.name) return;
    if (badName(name)) return toast(t("名称里不能有 /"), true);
    try {
      await api(`/api/file/rename?from=${encodeURIComponent(fullPathOf(e))}&name=${encodeURIComponent(name)}`, { method: "POST" });
      if (state.fs.sel === e.name) state.fs.sel = name;
      await fsLoad(state.fs.path, { keepSel: true });
      toast(t("已重命名"));
    } catch (err) { fsErr(err); }
  }
  $("fs-newfile").addEventListener("click", () => fsCreate(false));
  $("fs-mkdir").addEventListener("click", () => fsCreate(true));

  $("fs-close").addEventListener("click", closeFiles);
  $("fs-reload").addEventListener("click", () => { fsDotsAt = 0; fsLoad(state.fs.path, { keepSel: true }); });
  $("fs-git").addEventListener("click", () => openGit(state.fs.path));
  $("fs-up").addEventListener("click", () => {
    if (state.fs.parent && state.fs.parent !== state.fs.path) fsLoad(state.fs.parent);
  });
  $("fs-hidden").addEventListener("change", (e) => { state.fs.hidden = e.target.checked; fsLoad(state.fs.path); });
  $("fs-search").addEventListener("input", (e) => { state.fs.q = e.target.value.trim(); renderFs(); });
  $("fs-insert").addEventListener("click", () => {
    const e = state.fs.entries.find((x) => x.name === state.fs.sel);
    if (e) insertFile(e);
  });
  $("fs-roots").addEventListener("click", (e) => {
    const c = e.target.closest(".chip");
    if (c) fsLoad(c.dataset.p);
  });
  $("fs-crumbs").addEventListener("click", (e) => {
    const c = e.target.closest(".crumb");
    if (c) fsLoad(c.dataset.p);
  });

  // ── 会话管理 ──────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      const r = await api("/api/sessions");
      state.sessions = r.sessions || [];
      renderSessions();
    } catch {}
  }

  // 会话页三种视图：普通列表 / 多选（导出、批量删除）/ 回收站
  const sess = { mode: "list", sel: new Set(), trash: [], keepDays: 30 };

  function renderSessions() {
    const box = $("session-list");
    renderSessBar();
    if (sess.mode === "trash") return renderTrash(box);
    if (!state.sessions.length) {
      box.innerHTML = '<div class="tiny">' + t("还没有历史会话。") + '</div>';
      return;
    }
    const liveSids = new Set(srv.runs.map((r) => r.sessionId).filter(Boolean));
    const askSids = new Set(srv.runs.filter((r) => r.perms && r.perms.length).map((r) => r.sessionId).filter(Boolean));
    const picking = sess.mode === "select";
    box.innerHTML = state.sessions.map((s) => `
      <div class="item ${s.id === view.sessionId ? "active" : ""} ${picking && sess.sel.has(s.id) ? "picked" : ""}" data-id="${esc(s.id)}">
        <div class="it-title">${picking ? `<input type="checkbox" class="sess-ck" ${sess.sel.has(s.id) ? "checked" : ""}> ` : ""}${esc(s.title)}</div>
        <div class="it-meta">
          <span>${relTime(s.mtime)}</span>
          <span>${s.sizeKb} KB</span>
          ${askSids.has(s.id) ? `<span class="badge warn">${t("等你确认")}</span>` : liveSids.has(s.id) ? `<span class="badge cur">${t("生成中")}</span>` : ""}
          ${s.currentProject ? `<span class="badge cur">${t("当前项目")}</span>` : ""}
          ${s.renamed ? `<span class="badge">${t("已命名")}</span>` : ""}
        </div>
        ${picking ? "" : `<div class="it-acts">
          <button data-a="open">${t("切换到此会话")}</button>
          <button data-a="rename">${t("重命名")}</button>
          <button data-a="del">${t("删除")}</button>
        </div>`}
      </div>`).join("");
  }

  function renderSessBar() {
    const bar = $("sess-bar");
    $("btn-sess-select").textContent = sess.mode === "select" ? t("取消选择") : t("选择");
    $("btn-sess-trash").textContent = sess.mode === "trash" ? t("返回会话") : t("回收站");
    $("btn-sess-select").classList.toggle("hidden", sess.mode === "trash");
    if (sess.mode === "select") {
      const n = sess.sel.size, all = state.sessions.length && n === state.sessions.length;
      bar.innerHTML = `<button class="btn ghost sm" data-b="all">${all ? t("全不选") : t("全选")}</button>
        <span class="tiny">${t("已选 {n} 个", { n })}</span>
        <button class="btn sm" data-b="export" ${n ? "" : "disabled"}>${t("导出所选")}</button>
        <button class="btn ghost sm danger" data-b="trash" ${n ? "" : "disabled"}>${t("删除所选")}</button>`;
    } else if (sess.mode === "exported") {
      const r = sess.exported;
      bar.innerHTML = `<span class="tiny">${t("已导出 {n} 个会话", { n: r.count })}</span>
        ${canSaveAs() ? `<button class="btn sm" data-b="save">${t("保存到…")}</button>` : ""}
        ${canShare() ? `<button class="btn sm" data-b="share">${t("分享…")}</button>` : ""}
        <button class="btn ghost sm" data-b="done">${t("完成")}</button>
        ${canSaveAs() || canShare() ? "" : `<div class="tiny">${esc(r.file)}</div>`}`;
    } else if (sess.mode === "trash") {
      bar.innerHTML = `<span class="tiny">${t("删除的会话在这里保留 {n} 天，之后自动清除。", { n: sess.keepDays })}</span>
        ${sess.trash.length ? `<button class="btn ghost sm danger" data-b="empty">${t("清空回收站")}</button>` : ""}`;
    }
    bar.classList.toggle("hidden", sess.mode === "list");
  }

  function renderTrash(box) {
    if (!sess.trash.length) { box.innerHTML = '<div class="tiny">' + t("回收站是空的。") + '</div>'; return; }
    box.innerHTML = sess.trash.map((m) => `
      <div class="item" data-id="${esc(m.id)}">
        <div class="it-title">${esc(m.title || m.id)}</div>
        <div class="it-meta">
          <span>${t("删除于 {time}", { time: relTime(m.deletedAt) })}</span>
          <span>${Math.round((m.size || 0) / 1024)} KB</span>
        </div>
        <div class="it-acts">
          <button data-a="restore">${t("恢复")}</button>
          <button data-a="purge">${t("彻底删除")}</button>
        </div>
      </div>`).join("");
  }

  async function loadTrash() {
    try {
      const r = await api("/api/trash");
      sess.trash = r.items || []; sess.keepDays = r.keepDays || 30;
    } catch (e) { toast(e.message, true); }
    renderSessions();
  }

  $("btn-sess-select").addEventListener("click", () => {
    sess.mode = sess.mode === "select" ? "list" : "select";
    sess.sel.clear();
    renderSessions();
  });
  $("btn-sess-trash").addEventListener("click", () => {
    if (sess.mode === "trash") { sess.mode = "list"; loadSessions(); return; }
    sess.mode = "trash"; loadTrash();
  });
  $("btn-sess-import").addEventListener("click", () => $("sess-import-file").click());
  $("sess-import-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    toast(t("正在导入…"));
    try {
      const r = await api("/api/sessions/import", {
        method: "POST", headers: { "content-type": "application/zip" }, body: await f.arrayBuffer(),
      });
      toast(r.skipped.length
        ? t("已导入 {n} 个会话，跳过 {m} 个已存在的", { n: r.imported.length, m: r.skipped.length })
        : t("已导入 {n} 个会话", { n: r.imported.length }));
    } catch (err) { toast(t("导入失败：{msg}", { msg: err.message }), true); }
    if (sess.mode === "trash") sess.mode = "list";
    loadSessions();
  });

  $("sess-bar").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const act = b.dataset.b;
    if (act === "all") {
      if (sess.sel.size === state.sessions.length) sess.sel.clear();
      else state.sessions.forEach((s) => sess.sel.add(s.id));
      return renderSessions();
    }
    if (act === "export") {
      if (!confirm(t("会话记录可能含有你贴过的密钥、令牌或文件内容。导出的压缩包请只发给你信任的地方。继续？"))) return;
      let r;
      try { r = await post("/api/sessions/export", { ids: [...sess.sel] }); }
      catch (err) { return toast(t("导出失败：{msg}", { msg: err.message }), true); }
      if (!r.ok) return toast(t("导出失败：{msg}", { msg: r.message || "" }), true);
      // 导出包在网关这边；交给用户选：「保存到」（系统文件面板，挑哪都行）或「分享」（网盘、聊天、另一台设备）
      sess.exported = r; sess.mode = "exported"; sess.sel.clear(); renderSessions();
      if (canSaveAs()) saveAs(r.file, "application/zip");
      else if (!canShare()) toast(t("已导出 {n} 个会话：{file}", { n: r.count, file: r.file }));
      return;
    }
    if (act === "save") return saveAs(sess.exported.file, "application/zip");
    if (act === "share") return post("/api/app/share_file", { path: sess.exported.file, mime: "application/zip" })
      .then((j) => { if (!j.ok) toast(j.message || t("分享失败"), true); }).catch((err) => toast(err.message, true));
    if (act === "done") { sess.mode = "list"; sess.exported = null; return renderSessions(); }
    if (act === "trash") {
      if (!confirm(t("把选中的 {n} 个会话移进回收站？{d} 天内可以恢复。", { n: sess.sel.size, d: sess.keepDays }))) return;
      const r = await post("/api/sessions/trash", { ids: [...sess.sel] }).catch((err) => ({ done: [], failed: [], err }));
      if (r.done.includes(view.sessionId)) newConversation();
      toast(r.failed.length ? t("{n} 个已删除，{m} 个正在生成没删", { n: r.done.length, m: r.failed.length }) : t("已移进回收站"), !!r.failed.length);
      sess.mode = "list"; sess.sel.clear(); loadSessions();
      return;
    }
    if (act === "empty") {
      if (!confirm(t("彻底删除回收站里全部 {n} 个会话？不可恢复。", { n: sess.trash.length }))) return;
      await post("/api/trash/purge", { all: true }).catch((err) => toast(err.message, true));
      loadTrash();
    }
  });

  $("session-list").addEventListener("click", async (e) => {
    const el = e.target.closest(".item");
    if (!el) return;
    const id = el.dataset.id;
    if (sess.mode === "select") {
      if (sess.sel.has(id)) sess.sel.delete(id); else sess.sel.add(id);
      return renderSessions();
    }
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.a;
    if (a === "restore") {
      const r = await post("/api/trash/restore", { ids: [id] }).catch((err) => ({ failed: [{ error: err.message }] }));
      if (r.failed && r.failed.length) toast(t("恢复失败：{msg}", { msg: r.failed[0].error === "exists" ? t("同名会话已存在") : r.failed[0].error }), true);
      else toast(t("已恢复"));
      return loadTrash();
    }
    if (a === "purge") {
      if (!confirm(t("彻底删除这个会话？不可恢复。"))) return;
      await post("/api/trash/purge", { ids: [id] }).catch((err) => toast(err.message, true));
      return loadTrash();
    }
    if (a === "open") { closeDrawer(); openSession(id); return; }
    if (a === "rename") {
      const cur = state.sessions.find((s) => s.id === id);
      const name = prompt(t("新的会话名称"), cur?.title || "");
      if (!name) return;
      try {
        await api(`/api/session/${encodeURIComponent(id)}/rename`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: name }),
        });
      } catch (err) { toast(err.message, true); }
      loadSessions();
      return;
    }
    if (a === "del") {
      try { await api(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }); }
      catch (err) { return toast(err.message, true); }
      if (view.sessionId === id) newConversation();
      loadSessions();
      toast(t("已移进回收站（{d} 天内可恢复）", { d: sess.keepDays }));
    }
  });

  // ── 扩展：插件 / 技能 / MCP ──────────────────────────────────────────
  const ext = { q: "", offset: 0, busy: false };
  const extItem = (title, meta, acts, desc, tags) => `<div class="item"${tags ? ` data-tags="${esc(tags.join(" "))}"` : ""}>
      <div class="it-title">${title}</div>
      ${meta ? `<div class="it-meta">${meta}</div>` : ""}
      ${desc || ""}
      ${acts ? `<div class="it-acts">${acts}</div>` : ""}</div>`;

  function loadExt() { loadComponents(60); loadExtPlugins(); loadExtSkills(); loadExtMcp(); loadExtMarkets(); }

  // ── 分类索引条：扩展页每节一条，横向滚动。点一下只看那一类，点「全部」复原；刷新列表后选中的分类保留 ──
  // 条目带 data-tags（空格分隔的分类键）。labels 定顺序和显示名；没列出的键（如插件市场名 m:<名字>）按名字附在后面
  const tg = (s) => encodeURIComponent(String(s));
  const extPick = {}, extLabels = {};
  const CAT = () => ({ dev: t("开发工具"), office: t("文档办公"), media: t("图像影音"), science: t("科学计算"), eda: t("电子设计"),
    cad: t("3D 与建模"), ai: t("AI 推理"), gpu: t("GPU 与驱动"), net: t("网络"), other: t("其他") });
  function renderIdx(sec, labels) {
    if (labels) extLabels[sec] = labels; else labels = extLabels[sec] || [];
    const bar = $(sec + "-idx"); if (!bar) return;
    const items = [...document.querySelectorAll(`details[data-sec="${sec}"] .item[data-tags]`)];
    const count = new Map();
    for (const it of items) for (const g of it.dataset.tags.split(" ")) count.set(g, (count.get(g) || 0) + 1);
    const known = new Set(labels.map(([g]) => g));
    const chips = [...labels.filter(([g]) => count.get(g)),
      ...[...count.keys()].filter((g) => !known.has(g)).sort().map((g) => [g, decodeURIComponent(g.replace(/^[a-z]+:/, ""))])];
    if (extPick[sec] && !count.get(extPick[sec])) extPick[sec] = "";
    const cur = extPick[sec] || "";
    bar.classList.toggle("hidden", chips.length < 2 && !cur);      // 只有一类时没什么可切的
    bar.innerHTML = [["", t("全部"), items.length], ...chips.map(([g, l]) => [g, l, count.get(g)])]
      .map(([g, l, n]) => `<button class="idx-chip${g === cur ? " on" : ""}" data-sec="${sec}" data-idx="${esc(g)}">${esc(l)}<span>${n}</span></button>`).join("");
    for (const it of items) it.classList.toggle("hidden", !!cur && !it.dataset.tags.split(" ").includes(cur));
  }
  $("tab-ext").addEventListener("click", (e) => {
    const c = e.target.closest(".idx-chip"); if (!c) return;
    extPick[c.dataset.sec] = c.dataset.idx; renderIdx(c.dataset.sec);
  });
  // 折叠状态记在本机：收起的下次还是收起
  const extOpen = (() => { try { return JSON.parse(localStorage.getItem("cc.extOpen") || "{}"); } catch { return {}; } })();
  for (const d of document.querySelectorAll("#tab-ext details.ext-sec")) {
    if (extOpen[d.dataset.sec] === false) d.open = false;
    d.addEventListener("toggle", () => { extOpen[d.dataset.sec] = d.open; try { localStorage.setItem("cc.extOpen", JSON.stringify(extOpen)); } catch {} });
  }

  // ── 可选组件（浏览器组件 = 无头 Chromium）：下载 → 校验 → 换进工具包，进度靠轮询 ──
  let compTimer = 0;
  const pickLang = (o) => (o && typeof o === "object" ? o[(window.I18N && I18N.lang) || "zh"] || o.en || o.zh || "" : o || "");
  const MB = (n) => Math.max(1, Math.round((n || 0) / 1048576)) + " MB";
  // 「A、B 和 C」这种并列按当前语言的习惯拼
  const listOf = (a) => { try { return new Intl.ListFormat((window.I18N && I18N.lang) || "zh", { type: "conjunction" }).format(a); } catch { return a.join(", "); } };
  async function loadComponents(refresh) {
    clearTimeout(compTimer);
    const r = await api("/api/components" + (refresh ? "?refresh=" + (refresh === true ? 1 : refresh) : "")).catch((e) => ({ supported: true, items: [], indexError: e.message }));
    $("comp-field").classList.toggle("hidden", !r.supported);
    if (!r.supported) return loadGhField();
    const box = $("comp-list");
    const btn = (c, id, label) => `<button data-c="${c}" data-id="${esc(id)}">${label}</button>`;
    const html = (r.items || []).map((c) => {
      const name = esc(pickLang(c.name) || c.id), pr = c.progress;
      const size = c.available ? t("下载约 {a}，装好后约 {b}", { a: MB(c.bytes), b: MB(c.installed) }) : "";
      const st = {
        absent: c.available ? t("未安装") : t("暂无适配当前工具包的版本"),
        downloading: t("下载中"), verifying: t("校验中"), installing: t("正在装进工具包…"),
        ok: t("已安装"), update: t("有新版本"), outdated: t("工具包已更新，需要重新安装"),
        damaged: t("安装不完整，需要重新安装"), error: t("安装失败"),
      }[c.state] || c.state;
      // 依赖没装齐：安装按钮置灰，下面写明要先装哪个；只限骁龙的组件在别家 SoC 上干脆不给装
      const miss = (c.requires || []).filter((d) => !d.ok).map((d) => esc(pickLang(d.name) || d.id));
      const adreno = c.needs && c.needs.gpu === "adreno";
      let acts = "";
      if (c.state === "absent" && c.available && !c.unsupported) acts = btn("install", c.id, t("下载安装"));
      else if (c.state === "downloading" || c.state === "verifying") acts = btn("cancel", c.id, t("取消"));
      else if (c.state === "ok") acts = btn("remove", c.id, t("卸载"));
      else if (["update", "outdated", "damaged", "error"].includes(c.state)) {
        if (c.available) acts += btn("install", c.id, c.state === "update" ? t("更新") : t("重新安装"));
        if (c.installedVersion) acts += btn("remove", c.id, t("卸载"));
      }
      let bar = "";
      if (pr && pr.total) {
        const pct = Math.min(100, (pr.done / pr.total) * 100).toFixed(1);
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + MB(pr.done) + " / " + MB(pr.total) + "</div>";
      }
      const ver = c.installedVersion || c.version;
      const meta = "<span>" + esc(st) + "</span>" + (ver ? "<span>" + esc(ver) + "</span>" : "") +
        (size && c.state !== "ok" ? "<span>" + esc(size) + "</span>" : "") +
        // 社区组件标出来；没有真机验证记录的再加一个提醒
        (c.source === "community" ? "<span>" + t("社区") + "</span>" : "") +
        (!c.verified ? '<span class="warn">' + t("未经真机验证") + "</span>" : "") +
        (c.license && c.state !== "ok" ? "<span>" + esc(c.license) + "</span>" : "") +
        (adreno && c.state !== "ok" ? (c.unsupported ? '<span class="warn">' + t("只限高通骁龙（Adreno GPU）设备，本机用不了") + "</span>" : "<span>" + t("骁龙专用") + "</span>") : "");
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(c.desc)) + "</div>";
      if (c.error) desc += '<div class="tiny err">' + esc(c.error) + "</div>";
      if (miss.length && c.state !== "ok") desc += '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>";
      if (c.homepage && c.state !== "ok") desc += '<div class="tiny"><a class="weblink" href="' + esc(c.homepage) + '">' + esc(c.homepage) + "</a></div>";
      if (c.state === "ok" && c.bin.length) desc += '<div class="tiny">' + t("命令") + "：" + c.bin.map((b) => "<code>" + esc(b) + "</code>").join(" ") + "</div>";
      if (c.id === "gh" && c.state === "ok") desc += '<div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div>";
      const used = (c.usedBy || []).map((d) => esc(pickLang(d.name) || d.id));
      const tags = ["cat:" + (c.category && CAT()[c.category] ? c.category : "other")];
      if (c.state === "ok") tags.push("inst");
      if (["update", "outdated", "damaged", "error"].includes(c.state)) tags.push("upd");
      return extItem(name, meta, acts, desc + bar, tags)
        .replace("<button data-c=\"install\"", "<button data-c=\"install\"" + (c.verified ? "" : " data-unverified=\"1\"") + (miss.length ? " disabled" : ""))
        .replace("<button data-c=\"remove\"", "<button data-c=\"remove\"" + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
    }).join("");
    box.innerHTML = (html || '<div class="tiny">' + (r.indexError ? t("组件清单取不到：{msg}", { msg: esc(r.indexError) }) : t("暂时没有可装的组件。")) + "</div>") +
      (html && r.indexError ? '<div class="tiny err">' + t("部分组件清单取不到：{msg}", { msg: esc(r.indexError) }) + "</div>" : "") +
      (r.indexError ? '<div class="it-acts"><button class="btn ghost sm" data-c="reindex">' + t("重试") + "</button></div>" : "");
    $("comp-count").textContent = (r.items || []).length || "";
    renderIdx("comp", [["inst", t("已装")], ["upd", t("要更新")], ...Object.entries(CAT()).map(([k, v]) => ["cat:" + k, v])]);
    if ($("gh-auth")) loadGhAuth(refresh);
    // 有在跑的就一秒刷一次；抽屉关了 / 换了页签就停
    if ((r.items || []).some((c) => c.progress) && !$("tab-ext").classList.contains("hidden") && !$("drawer").classList.contains("hidden"))
      compTimer = setTimeout(loadComponents, 1000);
  }

  // ── gh 登录卡：设备码流程。令牌只在 gh 自己那儿，网关只回账号名与状态 ──
  const ghAuth = { html: "", at: 0, timer: 0, polling: false };
  // 没有组件系统的地方（开发端）：gh 在 PATH 里就单独给一张 GitHub 卡片，登录卡同一套
  async function loadGhField() {
    const st = await api("/api/gh/auth").catch(() => null);
    $("gh-field").classList.toggle("hidden", !(st && st.installed));
    if (!st || !st.installed) return;
    $("gh-field-box").innerHTML = '<div class="item"><div class="it-title">GitHub CLI（gh）</div><div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div></div>";
    loadGhAuth(true);
  }
  async function loadGhAuth(force) {
    clearTimeout(ghAuth.timer);
    // 组件列表下载时一秒刷一次，gh auth status 要联网验令牌，别跟着每秒跑
    if (!force && !ghAuth.polling && Date.now() - ghAuth.at < 30000) return;
    ghAuth.at = Date.now();
    const r = await api("/api/gh/auth").catch((e) => ({ installed: true, accounts: [], error: e.message }));
    const j = r.job, wasPolling = ghAuth.polling;
    ghAuth.polling = !!j && ["starting", "waiting"].includes(j.state);
    if (wasPolling && j && j.state === "done") toast(j.git ? t("GitHub 已登录，git 推送已配好") : t("GitHub 已登录，但 git 凭据没配上，可在终端运行 gh auth setup-git"), !j.git);
    let h = "";
    if (j && j.state === "starting") h = '<div class="tiny">' + t("正在向 GitHub 申请一次性码…") + "</div>" + '<div class="it-acts"><button data-g="cancel">' + t("取消") + "</button></div>";
    else if (j && j.state === "waiting") {
      h = '<div class="tiny">' + t("在浏览器里输入这个一次性码，授权后这里会自动完成：") + "</div>" +
        '<div class="gh-code" data-g="copy">' + esc(j.code) + "</div>" +
        '<div class="it-acts"><button data-g="open" data-code="' + esc(j.code) + '" data-url="' + esc(j.url || "https://github.com/login/device") + '">' + t("复制并打开浏览器") + "</button>" +
        '<button data-g="cancel">' + t("取消") + "</button></div>";
    } else {
      const acc = r.accounts || [];
      h = acc.length ? acc.map((a) => '<div class="gh-acc"><span>@' + esc(a.login) + "</span>" +
          (a.active && acc.length > 1 ? '<span class="badge">' + t("当前") + "</span>" : "") +
          (a.ok ? "" : '<span class="warn">' + t("登录已失效") + "</span>") +
          (a.active ? "" : '<button data-g="switch" data-user="' + esc(a.login) + '">' + t("切换到这个") + "</button>") +
          '<button data-g="logout" data-user="' + esc(a.login) + '">' + t("退出") + "</button></div>").join("")
        : '<div class="tiny">' + t("还没登录 GitHub。登录后 gh 和 git 推送都能用。") + "</div>";
      if (j && j.state === "error") h += '<div class="tiny err">' + (j.error === "timeout" ? t("一次性码过期了，重新登录吧") : t("登录失败：{msg}", { msg: esc(j.error) })) + "</div>";
      if (r.error) h += '<div class="tiny err">' + esc(r.error) + "</div>";
      h += '<div class="it-acts"><button data-g="login">' + (acc.length ? t("再登录一个账号") : t("登录 GitHub")) + "</button></div>";
    }
    ghAuth.html = h;
    const box = $("gh-auth");
    if (box) box.innerHTML = h;
    if (ghAuth.polling && box && !$("tab-ext").classList.contains("hidden") && !$("drawer").classList.contains("hidden"))
      ghAuth.timer = setTimeout(loadGhAuth, 2000);
  }

  async function loadExtPlugins() {
    const box = $("ext-plugins");
    let r;
    try { r = await api("/api/ext/plugins"); } catch (e) { box.innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    if (r.ok === false) { box.innerHTML = `<div class="tiny">${esc(r.message)}</div>`; return; }
    $("ext-p-count").textContent = r.installed.length;
    box.innerHTML = r.installed.length ? r.installed.map((p) => extItem(
      esc(p.id.split("@")[0]) + (p.enabled ? "" : ` <span class="badge">${t("已停用")}</span>`),
      `<span>${esc(p.id.split("@")[1] || "")}</span><span>${esc(String(p.version || "").slice(0, 16))}</span><span>${esc(p.scope || "")}</span>`,
      `<button data-x="${p.enabled ? "disable" : "enable"}" data-id="${esc(p.id)}">${p.enabled ? t("停用") : t("启用")}</button>
       <button data-x="uninstall" data-id="${esc(p.id)}">${t("卸载")}</button>`, "", [p.enabled ? "on" : "off", "m:" + tg(p.id.split("@")[1] || "")])).join("")
      : `<div class="tiny">${t("还没装插件。在下面搜索可安装的。")}</div>`;
    renderIdx("plugin", [["on", t("已启用")], ["off", t("已停用")]]);
  }

  async function searchPlugins(more) {
    const box = $("ext-catalog");
    if (!more) { ext.offset = 0; ext.q = $("ext-p-q").value.trim(); box.innerHTML = `<div class="tiny">${t("正在拉取插件目录…")}</div>`; }
    let r;
    try { r = await api(`/api/ext/plugins?available=1&q=${encodeURIComponent(ext.q)}&offset=${ext.offset}`); }
    catch (e) { box.innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    if (r.ok === false) { box.innerHTML = `<div class="tiny">${esc(r.message)}</div>`; return; }
    const html = (r.available || []).map((p) => extItem(
      esc(p.name),
      `<span>${esc(p.marketplace)}</span>${p.version ? `<span>${esc(p.version)}</span>` : ""}`,
      `<button data-x="install" data-id="${esc(p.id)}">${t("安装")}</button>`,
      `<div class="tiny ext-desc">${esc(p.description)}</div>`, ["m:" + tg(p.marketplace)])).join("");
    const old = box.querySelector(".ext-more-btn"); if (old) old.remove();
    if (!more) box.innerHTML = `<div class="tiny">${t("找到 {n} 个", { n: r.total || 0 })}</div>` + html;
    else box.insertAdjacentHTML("beforeend", html);
    ext.offset += (r.available || []).length;
    if (ext.offset < (r.total || 0)) box.insertAdjacentHTML("beforeend", `<button class="btn ghost sm ext-more-btn">${t("再显示 40 个")}</button>`);
    renderIdx("plugin");
  }

  async function installPlugin(id, btn) {
    btn.disabled = true; btn.textContent = t("安装中…");
    let r = await post("/api/ext/plugins/install", { id }).catch((e) => ({ ok: false, message: e.message }));
    // 要执行命令才能装的插件：claude 把命令亮出来，人点头了才装
    if (r.needConfirm) {
      if (confirm(t("这个插件安装时要在本机执行下面这条命令，确认是你信任的来源再继续：\n\n{cmd}", { cmd: r.command }))) {
        r = await post("/api/ext/plugins/install", { id, accept: r.sha256 }).catch((e) => ({ ok: false, message: e.message }));
      } else r = { ok: false, message: t("已取消") };
    }
    if (r.ok) { toast(t("已安装 {name}，下一条消息生效", { name: id.split("@")[0] })); btn.closest(".item").remove(); loadExtPlugins(); }
    else { toast(t("安装失败：{msg}", { msg: r.message || "" }), true); btn.disabled = false; btn.textContent = t("安装"); }
  }

  async function loadExtMarkets() {
    const r = await api("/api/ext/marketplaces").catch(() => ({ items: [] }));
    $("ext-markets").innerHTML = (r.items || []).map((m) => extItem(esc(m.name), `<span>${esc(m.source)}</span>`,
      `<button data-x="market-rm" data-id="${esc(m.name)}">${t("移除")}</button>`)).join("")
      || `<div class="tiny">${t("只有内置的官方目录。可以添加别的插件市场（GitHub 仓库或网址）。")}</div>`;
  }

  async function loadExtSkills() {
    const r = await api("/api/ext/skills").catch(() => ({ items: [] }));
    $("ext-s-count").textContent = (r.items || []).length;
    $("ext-skills").innerHTML = (r.items || []).map((s) => extItem(esc(s.name), "",
      `<button data-x="skill-rm" data-id="${esc(s.dir)}">${t("删除")}</button>`,
      `<div class="tiny ext-desc">${esc(s.description)}</div>`, [s.component ? "comp" : s.official ? "official" : "user"])).join("")
      || `<div class="tiny">${t("~/.claude/skills 里还没有技能。插件也可能自带技能。")}</div>`;
    renderIdx("skill", [["official", t("官方")], ["comp", t("组件自带")], ["user", t("自己装的")]]);
    if ($("ext-s-catbox").open) loadSkillCat();
  }

  async function loadExtMcp() {
    const box = $("ext-mcp");
    const r = await api("/api/ext/mcp").catch((e) => ({ items: [], err: e.message }));
    $("ext-m-count").textContent = (r.items || []).length;
    box.innerHTML = (r.items || []).map((m) => extItem(
      esc(m.name) + (m.cloud ? ` <span class="badge">${t("账户连接器")}</span>` : ""),
      `<span class="mono">${esc(m.target)}</span>`,
      m.cloud ? "" : `<button data-x="mcp-rm" data-id="${esc(m.name)}">${t("移除")}</button>`,
      `<div class="tiny ext-st ${m.ok ? "ok" : "warn"}">${esc(m.status)}</div>`,
      m.cloud ? ["cloud"] : [m.ok ? "ok" : "bad", /^https?:/i.test(m.target || "") ? "remote" : "local"])).join("")
      || `<div class="tiny">${esc(r.err || t("还没有 MCP 服务器。"))}</div>`;
    renderIdx("mcp", [["ok", t("已连接")], ["bad", t("连不上")], ["cloud", t("账户连接器")], ["local", t("本地")], ["remote", t("远程")]]);
  }

  // ── 官方技能目录（anthropics/skills）：展开时才拉；装好后上面「技能」列表跟着刷新 ──
  const KB = (n) => (n < 1048576 ? Math.max(1, Math.ceil((n || 0) / 1024)) + " KB" : MB(n));
  async function loadSkillCat(force) {
    const box = $("ext-s-cat");
    if (!box.children.length || force) box.innerHTML = `<div class="tiny">${t("正在拉取官方技能目录…")}</div>`;
    const r = await api("/api/ext/catalog/skills" + (force ? "?refresh=1" : "")).catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) { box.innerHTML = `<div class="tiny err">${esc(r.message || "")}</div><div class="it-acts"><button data-x="skillcat-retry">${t("重试")}</button></div>`; return; }
    box.innerHTML = r.items.map((x) => extItem(esc(x.name),
      `<span>${KB(x.bytes)}</span>${x.installed ? `<span>${t("已安装")}</span>` : ""}`,
      x.installed ? "" : `<button data-x="skillcat-install" data-id="${esc(x.dir)}">${t("安装")}</button>`,
      `<div class="tiny ext-desc">${esc(x.description)}</div><div class="tiny"><a class="weblink" href="https://github.com/${esc(r.repo)}/tree/main/skills/${esc(x.dir)}">${t("源码与许可证")}</a></div>`)).join("")
      || `<div class="tiny">${t("官方目录是空的。")}</div>`;
  }
  $("ext-s-catbox").addEventListener("toggle", () => { if ($("ext-s-catbox").open) loadSkillCat(); });

  // ── 官方 MCP 注册表：搜索 → 条目里展开小表单（名字、装法、环境变量 / 请求头）→ 交给 claude mcp add ──
  const mcpCat = { q: "", next: "", npx: false, items: new Map() };
  const mcpShort = (n) => (String(n).split("/").pop() || "mcp").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  async function searchMcpCat(more) {
    const box = $("ext-mcp-cat");
    if (!more) { mcpCat.q = $("ext-mcp-q").value.trim(); mcpCat.next = ""; mcpCat.items.clear(); box.innerHTML = `<div class="tiny">${t("正在查注册表…")}</div>`; }
    const r = await api(`/api/ext/catalog/mcp?q=${encodeURIComponent(mcpCat.q)}&cursor=${encodeURIComponent(more ? mcpCat.next : "")}`).catch((e) => ({ ok: false, message: e.message }));
    const old = box.querySelector(".mcpcat-more"); if (old) old.remove();
    if (!r.ok) { box.insertAdjacentHTML(more ? "beforeend" : "afterbegin", `<div class="tiny err">${esc(r.message || "")}</div>`); if (!more) box.querySelector(".tiny:not(.err)")?.remove(); return; }
    mcpCat.npx = r.npx; mcpCat.next = r.next;
    const html = r.items.filter((m) => !mcpCat.items.has(m.name)).map((m) => {
      mcpCat.items.set(m.name, m);
      const usable = m.options.filter((o) => o.kind === "remote" || r.npx);
      const meta = (m.version ? `<span>${esc(m.version)}</span>` : "") +
        m.options.map((o) => `<span>${o.kind === "remote" ? esc(t("远程") + " · " + o.transport) : "npm"}</span>`).join("") +
        (m.other.length ? `<span class="warn">${t("另有 {kinds} 装法，本机用不了", { kinds: esc(m.other.join(" / ")) })}</span>` : "");
      const acts = usable.length ? `<button data-x="mcpcat-add" data-id="${esc(m.name)}">${t("添加")}</button>`
        : `<span class="tiny warn">${m.options.length ? t("要 npx（cccodroid 的工具包里有）") : t("本机装不了")}</span>`;
      return extItem(esc(m.title || m.name), meta, acts,
        `<div class="tiny mono">${esc(m.name)}</div><div class="tiny ext-desc">${esc(m.description)}</div>` +
        (m.homepage ? `<div class="tiny"><a class="weblink" href="${esc(m.homepage)}">${esc(m.homepage)}</a></div>` : "") + `<div class="mcpcat-form hidden"></div>`);
    }).join("");
    if (!more) box.innerHTML = html || `<div class="tiny">${t("没找到。换个关键词试试（英文更全）。")}</div>`;
    else box.insertAdjacentHTML("beforeend", html);
    if (r.next) box.insertAdjacentHTML("beforeend", `<button class="btn ghost sm mcpcat-more">${t("再显示 30 个")}</button>`);
  }
  function mcpCatForm(m, form, oi = 0) {
    const usable = m.options.filter((o) => o.kind === "remote" || mcpCat.npx), o = usable[oi];
    const fields = (o.kind === "npm" ? o.env : o.headers) || [];
    form.innerHTML = `<div class="ext-form">
      ${usable.length > 1 ? `<select data-f="opt">${usable.map((x, i) => `<option value="${i}"${i === oi ? " selected" : ""}>${x.kind === "npm" ? "npm · " + esc(x.package) : esc(t("远程") + " · " + x.target)}</option>`).join("")}</select>` : ""}
      <input data-f="name" value="${esc(mcpShort(m.name))}" placeholder="${esc(t("名字（字母、数字、- _ .）"))}" autocomplete="off">
      <div class="tiny mono">${esc(o.target)}</div>
      ${fields.map((x) => `<input data-k="${esc(x.name)}" data-req="${x.required ? 1 : ""}" type="${x.secret ? "password" : "text"}" autocomplete="off"
        placeholder="${esc(x.name + (x.required ? " *" : "") + (x.description ? " — " + x.description : ""))}">`).join("")}
      <button class="btn sm" data-x="mcpcat-go" data-id="${esc(m.name)}" data-oi="${oi}">${t("确认添加")}</button></div>`;
    form.classList.remove("hidden");
  }
  $("tab-ext").addEventListener("change", (e) => {
    if (e.target.dataset.f !== "opt") return;
    const form = e.target.closest(".mcpcat-form"), id = form.parentElement.querySelector("[data-x=mcpcat-add]")?.dataset.id;
    if (id) mcpCatForm(mcpCat.items.get(id), form, Number(e.target.value));
  });
  $("tab-ext").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.classList.contains("mcpcat-more")) return searchMcpCat(true);
    const x = b.dataset.x;
    if (x === "skillcat-retry") return loadSkillCat(true);
    if (x === "skillcat-install") {
      b.disabled = true; b.textContent = t("安装中…");
      const r = await post("/api/ext/catalog/skills/install", { dir: b.dataset.id }).catch((er) => ({ ok: false, message: er.message }));
      toast(r.ok ? t("已安装 {name}，下一条消息生效", { name: b.dataset.id }) : t("安装失败：{msg}", { msg: r.message || "" }), !r.ok);
      if (r.ok) loadExtSkills(); else { b.disabled = false; b.textContent = t("安装"); }
      return;
    }
    if (x === "mcpcat-add") {
      const form = b.closest(".item").querySelector(".mcpcat-form");
      if (!form.classList.contains("hidden")) return form.classList.add("hidden");
      return mcpCatForm(mcpCat.items.get(b.dataset.id), form);
    }
    if (x === "mcpcat-go") {
      const m = mcpCat.items.get(b.dataset.id), form = b.closest(".mcpcat-form");
      const o = m.options.filter((y) => y.kind === "remote" || mcpCat.npx)[Number(b.dataset.oi) || 0];
      const vals = [...form.querySelectorAll("input[data-k]")].map((i) => [i.dataset.k, i.value.trim(), !!i.dataset.req]);
      const lack = vals.filter(([, v, req]) => req && !v).map(([k]) => k);
      if (lack.length) return toast(t("要先填：{names}", { names: lack.join(", ") }), true);
      const filled = vals.filter(([, v]) => v);
      const body = { name: form.querySelector("[data-f=name]").value.trim(), transport: o.transport, target: o.target,
        env: o.kind === "npm" ? filled.map(([k, v]) => k + "=" + v) : [], headers: o.kind === "remote" ? filled.map(([k, v]) => k + ": " + v) : [] };
      if (o.kind === "npm" && !confirm(t("这个 MCP 服务器会在本机运行下面的 npm 包（注册表里任何人都能发布，没人审核），确认是你信任的来源再继续：\n\n{cmd}", { cmd: o.target }))) return;
      b.disabled = true;
      const r = await post("/api/ext/mcp/add", body).catch((er) => ({ ok: false, message: er.message }));
      b.disabled = false;
      toast(r.ok ? t("已添加 {name}", { name: body.name }) : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
      if (r.ok) { form.classList.add("hidden"); loadExtMcp(); }
    }
  });
  $("ext-mcp-search").addEventListener("click", () => searchMcpCat(false));
  $("ext-mcp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMcpCat(false); });
  $("ext-mcp-catbox").addEventListener("toggle", () => { if ($("ext-mcp-catbox").open && !$("ext-mcp-cat").children.length) searchMcpCat(false); });

  $("ext-p-search").addEventListener("click", () => searchPlugins(false));
  $("ext-p-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlugins(false); });
  $("ext-s-import").addEventListener("click", () => $("ext-s-file").click());
  $("ext-s-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    const r = await api("/api/ext/skills/import", { method: "POST", headers: { "content-type": "application/zip" }, body: await f.arrayBuffer() })
      .catch((err) => ({ ok: false, message: err.message }));
    toast(r.ok ? t("已安装技能 {name}", { name: r.dir }) : t("安装失败：{msg}", { msg: r.message || "" }), !r.ok);
    loadExtSkills();
  });
  $("ext-m-add").addEventListener("click", async () => {
    const source = $("ext-m-src").value.trim();
    if (!source) return;
    toast(t("正在添加市场…"));
    const r = await post("/api/ext/marketplaces/add", { source }).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("已添加") : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) $("ext-m-src").value = "";
    loadExtMarkets();
  });
  $("ext-mcp-add").addEventListener("click", async () => {
    const transport = $("ext-mcp-tr").value;
    const extra = $("ext-mcp-env").value.split(",").map((x) => x.trim()).filter(Boolean);
    const body = {
      name: $("ext-mcp-name").value.trim(), transport, target: $("ext-mcp-target").value.trim(),
      env: extra.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)),
      headers: extra.filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && x.includes(":")),
    };
    const r = await post("/api/ext/mcp/add", body).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("已添加 {name}", { name: body.name }) : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) { ["ext-mcp-name", "ext-mcp-target", "ext-mcp-env"].forEach((id) => ($(id).value = "")); loadExtMcp(); }
  });

  $("tab-ext").addEventListener("click", async (e) => {
    if (e.target.classList.contains("ext-more-btn")) return searchPlugins(true);
    const g = e.target.closest("[data-g]");
    if (g && !g.disabled) {
      const a = g.dataset.g;
      if (a === "copy") { navigator.clipboard?.writeText(g.textContent.trim()); return toast(t("已复制")); }
      if (a === "open") { navigator.clipboard?.writeText(g.dataset.code); toast(t("一次性码已复制，在打开的页面里粘贴")); return openExternal(g.dataset.url); }
      if (a === "logout" && !confirm(t("退出 GitHub 账号 {name}？gh 会删掉它保存的令牌。", { name: g.dataset.user }))) return;
      g.disabled = true;
      const r = await post("/api/gh/" + a, { user: g.dataset.user || "" }).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
      if (a === "login") ghAuth.polling = true;
      return loadGhAuth(true);
    }
    const cb = e.target.closest("button[data-c]");
    if (cb && !cb.disabled) {
      const c = cb.dataset.c, id = cb.dataset.id;
      if (c === "reindex") { cb.disabled = true; return loadComponents(true); }
      const nm = (cb.closest(".item")?.querySelector(".it-title")?.textContent || id).trim();
      if (c === "install" && cb.dataset.unverified && !confirm(t("{name} 还没人在真机上验证过，可能装不上或用不了。仍然安装？", { name: nm }))) return;
      if (c === "remove" && cb.dataset.usedby) return toast(t("{names} 要用它，先卸载那些组件", { names: cb.dataset.usedby }), true);
      if (c === "remove" && !confirm(t("卸载组件 {name}？会删掉它装进工具包的文件，你自己的文件不受影响。", { name: nm }))) return;
      cb.disabled = true;
      const r = await post("/api/components/" + c, { id }).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
      else if (c === "remove") {
        toast(t("已卸载"));
        // 组件自己攒的运行数据（下载缓存、解开的运行环境）不随卸载删，问一句
        if (r.data && r.data.bytes > 0 && confirm(t("{name} 还留着 {size} 运行数据（{path}：下载缓存、解开的运行环境等）。一起删掉？以后再装要重新下载。", { name: nm, size: fmtSize(r.data.bytes), path: r.data.path }))) {
          const p = await post("/api/components/purge", { id }).catch((err) => ({ ok: false, message: err.message }));
          toast(p.ok ? t("运行数据已删除") : t("失败：{msg}", { msg: p.message || "" }), !p.ok);
        }
      }
      return loadComponents();
    }
    const b = e.target.closest("button[data-x]");
    if (!b || b.disabled) return;
    const x = b.dataset.x, id = b.dataset.id;
    if (x === "install") return installPlugin(id, b);
    const ask = {
      uninstall: t("卸载插件 {name}？", { name: id }),
      "skill-rm": t("删除技能 {name}？文件夹会被整个删掉。", { name: id }),
      "mcp-rm": t("移除 MCP 服务器 {name}？", { name: id }),
      "market-rm": t("移除插件市场 {name}？从它装的插件也会一并卸载。", { name: id }),
    }[x];
    if (ask && !confirm(ask)) return;
    b.disabled = true;
    const url = { uninstall: "/api/ext/plugins/uninstall", enable: "/api/ext/plugins/enable", disable: "/api/ext/plugins/disable",
      "skill-rm": "/api/ext/skills/delete", "mcp-rm": "/api/ext/mcp/remove", "market-rm": "/api/ext/marketplaces/remove" }[x];
    const key = x === "skill-rm" ? "dir" : x === "mcp-rm" || x === "market-rm" ? "name" : "id";
    const r = await post(url, { [key]: id }).catch((err) => ({ ok: false, message: err.message }));
    toast(r.ok ? t("完成") : t("失败：{msg}", { msg: r.message || "" }), !r.ok);
    b.disabled = false;
    if (x === "skill-rm") loadExtSkills();
    else if (x === "mcp-rm") loadExtMcp();
    else if (x === "market-rm") { loadExtMarkets(); loadExtPlugins(); }
    else loadExtPlugins();
  });

  // ── 排障：安全模式 / 日志分享 / 修复账本 ───────────────────────────
  function paintSafeMode(on) {
    $("safe-mode").checked = !!on;
    let bar = $("safe-bar");
    if (on && !bar) {
      bar = document.createElement("div");
      bar.id = "safe-bar"; bar.className = "safe-bar";
      bar.innerHTML = `<span>${t("安全模式：自定义配置（CLAUDE.md、技能、插件、钩子、MCP）没有加载")}</span> <button class="btn sm ghost" id="safe-off">${t("退出安全模式")}</button>`;
      $("chat").before(bar);
      $("safe-off").onclick = () => setSafe(false);
    } else if (!on && bar) bar.remove();
  }
  async function setSafe(on) {
    const r = await post("/api/safe-mode", { on }).catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) return toast(r.message || "", true);
    paintSafeMode(r.safeMode);
    toast(r.safeMode ? t("已进入安全模式，下一条消息生效") : t("已退出安全模式，下一条消息生效"));
  }
  $("safe-mode").addEventListener("change", (e) => setSafe(e.target.checked));
  $("btn-share-logs").addEventListener("click", async () => {
    // 打包前给用户看清单：发出去的是什么、去掉了什么
    if (!confirm(t("打一个诊断包，经系统分享发出去。\n\n包里有：\n· 版本与设备：cccodroid / Android 版本、机型、芯片、剩余空间\n· 开发工具包：装的是哪一版、更新与自检状态\n· 最近的日志：本应用的系统日志、网关日志的最后一段\n· 修复账本：安装、校验、修复做过哪些、成没成\n\n已经去掉：\n· 密钥、令牌、登录凭据、邮箱\n· 你发给 Claude 的消息内容\n· 会话记录本身不在包里\n\n继续？"))) return;
    toast(t("正在打包日志…"));
    const r = await post("/api/app/share_logs").catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) toast(t("没分享成：{msg}", { msg: r.message || "" }), true);
  });
  const LEDGER_KIND = () => ({ verify: t("校验"), repair: t("修复"), install: t("安装"), recover: t("恢复"), "safe-mode": t("安全模式"), logs: t("日志") });
  $("btn-ledger").addEventListener("click", async () => {
    const box = $("ledger-list");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    const r = await api("/api/ledger").catch(() => ({ items: [] }));
    const K = LEDGER_KIND();
    box.innerHTML = (r.items || []).map((e) => `<div class="item ledger ${e.ok ? "" : "bad"}">
        <div class="it-meta"><span>${esc(new Date(e.at).toLocaleString())}</span><span class="badge">${esc(K[e.kind] || e.kind)}</span><span>${e.ok ? "✓" : "✗"}</span></div>
        <div class="it-title wrap">${esc(e.msg || "")}</div>
        ${e.detail && e.detail.samples && e.detail.samples.length ? `<div class="tiny mono">${e.detail.samples.slice(0, 5).map((x) => esc(typeof x === "string" ? x : JSON.stringify(x))).join("<br>")}</div>` : ""}
      </div>`).join("") || `<div class="tiny">${r.items === null ? t("这个版本没有修复账本。") : t("还没有记录。安装、校验、修复、启动时的恢复都会记在这里。")}</div>`;
    box.classList.remove("hidden");
  });

  // ── 设置 ──────────────────────────────────────────────────────────
  let MODELS = [];

  // ── 接口（厂商）────────────────────────────────────────────────────
  // 下拉框只决定"看哪一家的配置卡"；真正切换要在卡上点「使用这个接口」——
  // 配置和切换分开，免得填密钥填到一半就把正在用的接口换掉了。
  // 选接口这张单子：界面不是中文时整张用英文（厂商名、线路名本来就是英文世界的叫法，逐语言翻反而对不上官网）
  const provEn = () => !/^zh/.test((window.I18N && I18N.lang) || "zh");
  const pLabel = (x) => (provEn() && x.labelEn) || x.label;
  const pHint = (x) => (provEn() && x.hintEn) || x.hint || "";
  const GROUP_NAME = provEn() ? { claude: "Claude", third: "Third-party (just add a key)", custom: "Custom endpoints" }
    : { claude: "Claude", third: t("第三方（填 Key 即用）"), custom: t("自定义接口") };
  const post = (p, body) => api(p, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
  });

  async function loadProviders() {
    try {
      const r = await api("/api/providers");
      state.providers = r.providers || [];
      state.providerActive = r.active;
      if (!state.provView || (state.provView !== "__new__" && !state.providers.some((p) => p.id === state.provView))) {
        state.provView = r.active;
      }
      const sel = $("set-provider");
      const groups = {};
      for (const p of state.providers) (groups[p.group] = groups[p.group] || []).push(p);
      const opt = (p) => {
        const tag = p.active ? "● " : "";
        const st = p.login ? "" : (p.hasKey ? "" : (provEn() ? " · no key yet" : t(" · 未配 Key")));
        return `<option value="${esc(p.id)}">${tag}${esc(pLabel(p))}${st}</option>`;
      };
      sel.innerHTML = ["claude", "third", "custom"].map((g) =>
        `<optgroup label="${GROUP_NAME[g]}">` + (groups[g] || []).map(opt).join("") +
        (g === "custom" ? `<option value="__new__">${provEn() ? "+ Add a custom endpoint…" : t("＋ 新增自定义接口…")}</option>` : "") + `</optgroup>`).join("");
      sel.value = state.provView;
      $("provider-count").textContent = t("{n} 个", { n: state.providers.length });
      const cur = state.providers.find((p) => p.id === r.active) || {};
      $("provider-info").innerHTML = t("当前在用：<b>{name}</b>　<code>{url}</code>", { name: esc(pLabel(cur) || r.active), url: esc(cur.baseUrl || "") });
      renderProvCard();
    } catch (e) {
      $("provider-info").textContent = t("读取接口清单失败：{msg}", { msg: e.message });
    }
  }

  function renderProvCard() {
    const box = $("prov-card");
    const id = state.provView;
    // 卡片容器是复用的：密钥卡 / 自定义卡会在它上面挂 onclick（闭包里记着那一家）。
    // 换卡前必须摘掉，否则旧处理还在 —— 在登录卡上点「使用这个接口」，冒泡上来又把接口切回上一家
    // （实测：同一毫秒发出 provider=anthropic 和 provider=deepseek，后者赢）。
    box.onclick = null;
    if (id === "__new__") return renderCustomCard(box, null);
    const p = (state.providers || []).find((x) => x.id === id);
    if (!p) { box.innerHTML = ""; return; }
    if (p.login) return renderLoginCard(box, p);
    if (p.custom) return renderCustomCard(box, p);
    return renderKeyCard(box, p);
  }

  const useBtn = (p) => p.active
    ? `<span class="pill">${t("● 正在使用")}</span>`
    : `<button class="btn sm" data-act="use">${t("使用这个接口")}</button>`;

  async function useProvider(p) {
    if (!p.login && !p.hasKey) return toast(t("先填 Key 并保存"), true);
    const r = await saveSettings({ provider: p.id });
    if (!r) return;
    await loadSettings();
    await refreshStatus();
    toast(t("已切到 {name}（下一条消息生效）", { name: p.label }));
  }

  // ── 账户登录卡 ──
  async function renderLoginCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div>
      <div class="prov-state" id="login-state">${t("查询登录状态…")}</div>
      <div class="row-actions" id="login-actions"></div>
      <div id="login-flow"></div>
      <div class="tiny">${esc(pHint(p))}</div>`;
    let st;
    try { st = await api("/api/login/status"); } catch (e) { $("login-state").textContent = t("查询失败：{msg}", { msg: e.message }); return; }
    if (state.provView !== p.id) return;      // 查询期间用户换了卡
    paintLoginState(st, p);
    if (st.pending) watchLogin(p);
  }
  function paintLoginState(st, p) {
    const el = $("login-state"); if (!el) return;
    if (st.loggedIn) {
      el.className = "prov-state ok";
            el.innerHTML = (st.email ? t("✓ 已登录：<b>{email}</b>", { email: esc(st.email) }) : t("✓ 已登录")) +
        (st.plan ? ` · ${esc(st.plan)}` : "") + (st.org ? `<br><span class="tiny">${esc(st.org)}</span>` : "") +
        quotaHtml(st.limits);
    } else {
      el.className = "prov-state warn";
      el.textContent = st.pending ? t("等待浏览器里完成授权…") : t("未登录");
    }
    $("login-actions").innerHTML = (st.pending
      ? `<button class="btn sm ghost" data-act="cancel">${t("取消登录")}</button>`
      : `<button class="btn sm" data-act="login">${st.loggedIn ? t("换个账户登录") : t("登录 Claude 账户")}</button>` +
        `<button class="btn sm ghost" data-act="login-console">${t("用 Console 账户")}</button>` +
        (st.loggedIn ? `<button class="btn sm ghost danger" data-act="logout">${t("退出登录")}</button>` : "")) +
      (st.loggedIn ? useBtn(p) : "");
    $("login-actions").onclick = (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "login") startLogin(p, "claudeai");
      else if (act === "login-console") startLogin(p, "console");
      else if (act === "cancel") post("/api/login/cancel").then(() => renderProvCard());
      else if (act === "logout") logout(p);
      else if (act === "use") useProvider(p);
    };
  }
  /** 订阅额度：claude 每轮回报一次，网关记下最近一次（不另外查接口） */
  function quotaHtml(l) {
    if (!l) return `<div class="quota tiny">${t("额度：发一条消息后显示（5 小时 / 每周）")}</div>`;
    const when = (sec) => {
      if (!sec) return "";
      const d = new Date(sec * 1000), now = new Date();
      const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + hm;
    };
    const row = (label, w) => {
      if (!w) return "";
      const pct = Math.max(0, Math.min(100, w.used));
      const cls = pct >= 90 ? " hot" : pct >= 70 ? " warm" : "";
      return `<div class="quota-row"><span class="quota-l">${label}</span>
        <span class="quota-bar"><i class="${cls.trim()}" style="width:${pct}%"></i></span>
        <span class="quota-v">${Math.round(pct)}%</span>
        <span class="tiny">${w.resetsAt ? t("{time} 重置", { time: esc(when(w.resetsAt)) }) : ""}</span></div>`;
    };
    const ago = Math.max(0, Math.round((Date.now() - l.at) / 60000));
    return `<div class="quota">${row(t("5 小时"), l.fiveHour)}${row(t("每周"), l.sevenDay)}
      <div class="tiny">${ago < 1 ? t("额度刚刚更新") : t("额度更新于 {n} 分钟前（每轮对话后刷新）", { n: ago })}</div></div>`;
  }
  /** 交给系统浏览器：安卓壳把非本机地址都转给外部浏览器（WebView 里登录会被 Google 等拦） */
  function openExternal(url) {
    if (window.CCApp && window.CCApp.openUrl) return window.CCApp.openUrl(url);
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function startLogin(p, method) {
    $("login-state").className = "prov-state";
    $("login-state").textContent = t("正在启动登录…");
    let r;
    try { r = await post("/api/login/start", { method }); } catch (e) { return toast(e.message, true); }
    if (!r.ok) { $("login-state").textContent = "✗ " + (r.message || t("启动失败")); return; }
    openExternal(r.url);
        $("login-flow").innerHTML = `<div class="tiny">${t("已在浏览器打开授权页。授权后浏览器会跳回本机，登录自动完成。")}
        ${t("没自动打开？")}<a href="${esc(r.url)}" target="_blank" rel="noopener">${t("点这里打开")}</a></div>
      <div class="prov-manual">
        <div class="tiny">${t("浏览器没跳回来（或在别的设备上授权）？在终端里登录：授权码由你直接贴给 claude，本应用不经手。")}</div>
        <button class="btn sm" id="btn-login-term">${t("在终端里登录")}</button>
      </div>`;
    $("btn-login-term").onclick = async () => {
      await post("/api/login/cancel").catch(() => {});
      clearInterval(state.loginTimer);
      openLoginTerm(method === "console" ? "console" : "claudeai");
    };
    watchLogin(p);
  }
  function watchLogin(p) {
    clearInterval(state.loginTimer);
    state.loginTimer = setInterval(async () => {
      let st;
      try { st = await api("/api/login/status"); } catch { return; }
      if (st.pending) { if (state.provView === p.id) paintLoginState(st, p); return; }
      clearInterval(state.loginTimer);
      if (st.loggedIn) toast((st.email ? t("✓ 已登录：{email}", { email: st.email }) : t("✓ 已登录")) + (p.active ? "" : t("，点「使用这个接口」切过去")));
      else if (st.last && !st.last.ok) toast(t("登录没有完成"), true);
      if (state.provView === p.id) renderProvCard();
      refreshStatus();
    }, 2000);
  }
  async function logout(p) {
    if (!confirm(t("退出这台设备上的 Claude 账户登录？"))) return;
    const r = await post("/api/login/logout").catch((e) => ({ ok: false, output: e.message }));
    toast(r.ok ? t("已退出登录") : t("退出失败：{msg}", { msg: r.output || r.message || "" }), !r.ok);
    renderProvCard();
  }

  // ── 密钥卡（Claude API Key 与第三方厂商）──
  // ── 余额与消费（密钥卡底部）──
  // 余额问平台；消费是网关按余额变化自己记的（平台都不给账单接口）；token 每轮结束记。
  // 显示货币跟界面语言走：中文用人民币，其余用美元；账户币种不同就按汇率换算，标「≈」
  const billCur = () => (/^zh/.test(I18N.lang) ? "CNY" : "USD");
  function money(v, cur) {
    try { return new Intl.NumberFormat(I18N.lang, { style: "currency", currency: cur, maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 }).format(v); }
    catch { return cur + " " + v.toFixed(2); }
  }
  function toDisp(v, from, fx) {
    const to = billCur();
    if (!from || from === to) return { v, cur: to, approx: false };
    if (!fx || !fx.rate) return { v, cur: from, approx: false };          // 拿不到汇率就照原币种显示
    return { v: from === "CNY" ? v / fx.rate : v * fx.rate, cur: to, approx: true };
  }
  const compact = (n) => { try { return new Intl.NumberFormat(I18N.lang, { notation: "compact", maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
  async function loadBill(p, force) {
    const el = $("pc-bill"); if (!el) return;
    if (!el.innerHTML) el.innerHTML = `<div class="tiny">${t("查询余额…")}</div>`;
    let b;
    try { b = await api(`/api/billing?id=${encodeURIComponent(p.id)}${force ? "&refresh=1" : ""}`); }
    catch (e) { el.innerHTML = `<div class="tiny">${esc(t("查询失败：{msg}", { msg: e.message }))}</div>`; return; }
    if (state.provView !== p.id || !$("pc-bill")) return;
    const fx = b.fx;
    const fmt = (v, cur) => { const d = toDisp(v, cur, fx); return (d.approx ? "≈ " : "") + money(d.v, d.cur); };
    const rows = [];
    // 余额 / 套餐额度
    if (b.balanceError) rows.push(`<div class="prov-state err">${esc(t("余额查询失败：{msg}", { msg: b.balanceError }))}</div>`);
    else if (Number.isFinite(b.balance)) {
      const PART = { granted: t("赠送"), topped: t("充值"), voucher: t("代金券"), cash: t("现金") };
      const parts = (b.parts || []).filter((x) => Number.isFinite(x.v)).map((x) => `${PART[x.k] || x.k} ${fmt(x.v, b.currency)}`).join(" · ");
      rows.push(`<div class="bill-big">${t("余额")} <b>${fmt(b.balance, b.currency)}</b>${b.available === false ? ` <span class="badge warn">${t("不可用")}</span>` : ""}</div>` +
        (parts ? `<div class="tiny">${parts}</div>` : ""));
    } else if (b.kind === "openrouter" && Number.isFinite(b.usage)) {
      rows.push(`<div class="bill-big">${t("已用")} <b>${fmt(b.usage, "USD")}</b></div><div class="tiny">${t("这把 Key 没设额度上限，查不到余额")}</div>`);
    }
    if (Array.isArray(b.plan)) {
      const W = { "5h": t("5 小时"), week: t("每周"), month: t("每月") };
      rows.push(b.plan.length
        ? `<div class="quota">${b.plan.map((x) => {
            const pct = Math.max(0, Math.min(100, x.pct)), cls = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
            const reset = x.resetsAt ? new Date(x.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
            return `<div class="quota-row"><span class="quota-l">${esc(W[x.window] || x.window)}</span>
              <span class="quota-bar"><i class="${cls}" style="width:${pct}%"></i></span><span class="quota-v">${Math.round(pct)}%</span>
              <span class="tiny">${reset ? t("{time} 重置", { time: esc(reset) }) : ""}</span></div>`;
          }).join("")}<div class="tiny">${t("Coding Plan 套餐额度（智谱没有公开的余额接口，按量计费的 Key 查不到）")}</div></div>`
        : `<div class="tiny">${t("这把 Key 没有 Coding Plan 套餐额度；智谱没有公开的按量余额接口，请到控制台查看")}</div>`);
    }
    if (b.kind === "none") rows.push(`<div class="tiny">${esc(p.id === "qwen"
      ? t("百炼的余额挂在阿里云主账号上，API Key 查不到，请到百炼控制台查看。下面是本机记录的 token 用量。")
      : t("这个平台没有开放余额查询接口。下面是本机记录的 token 用量。"))}</div>`);
    // 消费（按余额变化记的）
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    if (b.ledgerCurrency) {
      const sp = b.spends || [];
      const today = sp.filter((x) => x[0] >= midnight.getTime()).reduce((a, x) => a + x[1], 0);
      const total = (b.spentOld || 0) + sp.reduce((a, x) => a + x[1], 0);
      rows.push(`<div class="bill-grid"><span>${t("今日消费")}</span><b>${fmt(today, b.ledgerCurrency)}</b>
        <span>${t("累计消费")}</span><b>${fmt(total, b.ledgerCurrency)}</b></div>
        <div class="tiny">${esc(t("按余额变化记账，{date} 起；充值不算消费。同一把 Key 在别处用掉的也算在内。", { date: new Date(b.since).toLocaleDateString() }))}</div>`);
    }
    // token
    const tk = b.tok || [];
    const sum = (arr) => arr.reduce((a, x) => [a[0] + x[1], a[1] + x[2], a[2] + x[3]], [0, 0, 0]);
    const td = sum(tk.filter((x) => x[0] + 3600e3 > midnight.getTime()));
    const all = sum(tk), old = b.tokOld || { in: 0, out: 0, cache: 0 };
    const tl = (a) => t("输入 {i} · 输出 {o} · 缓存 {c}", { i: compact(a[0]), o: compact(a[1]), c: compact(a[2]) });
    rows.push(`<div class="bill-grid"><span>${t("今日 token")}</span><span>${tk.length ? tl(td) : "—"}</span>
      <span>${t("累计 token")}</span><span>${tk.length || old.in ? tl([all[0] + old.in, all[1] + old.out, all[2] + old.cache]) : "—"}</span></div>
      ${tk.length ? "" : `<div class="tiny">${t("用这个接口跑完一轮后开始记录")}</div>`}`);
    if (fx && fx.rate && [b.currency, b.ledgerCurrency].some((c) => c && c !== billCur()))
      rows.push(`<div class="tiny">${esc(t("按 1 美元 ≈ {r} 人民币换算（{src}，{time}）", { r: fx.rate.toFixed(3), src: fx.src, time: new Date(fx.at).toLocaleString() }))}</div>`);
    el.innerHTML = `<div class="bill-head"><span class="sub">${t("余额与消费")}</span>
      <button class="btn sm ghost" data-bill="refresh">${t("刷新")}</button></div>${rows.join("")}`;
    el.querySelector('[data-bill="refresh"]').onclick = (e) => { e.stopPropagation(); loadBill(p, true); };
  }

  function renderKeyCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div>
      ${p.endpoints.length > 1 ? `<div class="tiny" style="margin:0 0 4px">${t("线路")}</div>
        <select id="pc-endpoint">${p.endpoints.map((e) =>
          `<option value="${esc(e.id)}" ${e.id === p.endpoint ? "selected" : ""}>${esc(pLabel(e))}</option>`).join("")}</select>` : ""}
      <input id="pc-key" type="password" autocomplete="off"
        placeholder="${p.hasKey ? t("已保存（…{tail}），留空则不改", { tail: esc(p.keyTail) }) : t("粘贴 API Key")}">
      <div class="row-actions">
        <button class="btn sm" data-act="save">${t("保存")}</button>
        <button class="btn sm ghost" data-act="test">${t("测试")}</button>
        ${p.hasKey ? `<button class="btn sm ghost danger" data-act="clear">${t("清除 Key")}</button>` : ""}
        ${useBtn(p)}
      </div>
      <div class="prov-state" id="pc-result"></div>
      <div class="tiny">${t("端点")} <code>${esc(p.baseUrl)}</code>${p.defaultModel ? ` · ${t("默认模型")} <code>${esc(p.defaultModel)}</code>` : ""}
        ${p.keyUrl ? `<br><a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${t("去官网创建 Key ↗")}</a>` : ""}
        <br>${esc(pHint(p) || t("Key 只存在本机应用私有目录，由 claude 的 apiKeyHelper 按需读取（不进环境变量），直连厂商的 Anthropic 兼容端点。"))}</div>
      ${p.hasKey ? `<div id="pc-bill" class="bill"></div>` : ""}`;
    if (p.hasKey) loadBill(p);
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "use") return useProvider(p);
      if (act === "clear") {
        if (!confirm(t("清除 {name} 的 Key？", { name: p.label }))) return;
        await post("/api/providers/save", { id: p.id, clearKey: true }).catch((e2) => toast(e2.message, true));
        return reloadProv(t("已清除"));
      }
      const body = { id: p.id, apiKey: $("pc-key").value.trim() };
      if ($("pc-endpoint")) body.endpoint = $("pc-endpoint").value;
      if (act === "save" || body.apiKey || body.endpoint !== p.endpoint) {
        try { await post("/api/providers/save", body); } catch (e2) { return toast(e2.message, true); }
        $("pc-key").value = "";
        if (act === "save") return reloadProv(t("已保存"), true);
      }
      await testAndShow(p.id);
    };
  }
  async function testAndShow(id) {
    const el = $("pc-result"); if (!el) return;
    el.className = "prov-state"; el.textContent = t("测试中…");
    const r = await post("/api/providers/test", { id }).catch((e) => ({ ok: false, message: e.message }));
    el.className = "prov-state " + (r.ok ? "ok" : "err");
    el.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
  }
  async function reloadProv(msg, thenTest) {
    toast(msg);
    const id = state.provView;
    await loadProviders();
    if (id === state.providerActive) await loadModels(true);
    if (thenTest) {
      const p = state.providers.find((x) => x.id === id);
      if (p && p.hasKey) testAndShow(id);
    }
  }

  // ── Shizuku ──
  const PRIV_TEXT = {
        not_installed: ["warn", t("没装 Shizuku")],
        not_running: ["warn", t("Shizuku 已安装，但服务没在运行（重启手机后需要在 Shizuku 里重新启动）")],
        no_permission: ["warn", t("Shizuku 在运行，还没授权给 cccodroid")],
        unreachable: ["err", t("连不上应用的后台服务")],
  };
  const SETUP_BUSY = ["downloading", "installing", "connecting", "pairing", "starting", "permission"];
  let privPoll = null;
  // 各家系统里"允许后台运行"的位置。红魔/中兴为实测，其余是常见路径
  const BG_HOW = {
        nubia: t("红魔 / 努比亚：应用信息 → 应用的电池用量 → 电池优化 → <b>后台运行：允许</b>（<b>自启动</b>也选允许，开机激活 Shizuku、更新后自动恢复都靠它）"),
        zte: t("中兴：应用信息 → 应用的电池用量 → 电池优化 → <b>后台运行：允许</b>，<b>自启动：允许</b>"),
        xiaomi: t("小米 / 红米：应用信息 → <b>省电策略：无限制</b>，<b>自启动</b>打开（常见路径，可能因系统版本不同）"),
        redmi: t("小米 / 红米：应用信息 → <b>省电策略：无限制</b>，<b>自启动</b>打开（常见路径，可能因系统版本不同）"),
        oppo: t("OPPO / 一加 / 真我：应用信息 → 耗电管理 → <b>允许后台行为</b>、<b>允许自启动</b>（常见路径）"),
        oneplus: t("OPPO / 一加 / 真我：应用信息 → 耗电管理 → <b>允许后台行为</b>、<b>允许自启动</b>（常见路径）"),
        realme: t("OPPO / 一加 / 真我：应用信息 → 耗电管理 → <b>允许后台行为</b>、<b>允许自启动</b>（常见路径）"),
        vivo: t("vivo / iQOO：设置 → 电池 → 后台耗电管理 → cccodroid <b>允许后台高耗电</b>；i管家里允许<b>自启动</b>（常见路径）"),
        huawei: t("华为 / 荣耀：设置 → 应用启动管理 → cccodroid 关闭「自动管理」，手动允许<b>自启动</b>和<b>后台活动</b>（常见路径）"),
        honor: t("华为 / 荣耀：设置 → 应用启动管理 → cccodroid 关闭「自动管理」，手动允许<b>自启动</b>和<b>后台活动</b>（常见路径）"),
  };
  function renderBg(fz) {
    const show = fz && fz.count > 0;
    $("bg-field").classList.toggle("hidden", !show);
    if (!show) return;
        $("bg-state").textContent = t("检测到 cccodroid 在后台被系统冻结过 {n} 次（最近一次约 {sec} 秒，{at}）。", { n: fz.count, sec: Math.round(fz.ms / 1000), at: new Date(fz.at).toLocaleString() }) +
      t("冻结期间网关和正在跑的任务全部停住，回到前台才继续。前台服务挡不住这类厂商冻结器。");
    $("bg-how").innerHTML = BG_HOW[fz.vendor] || t("在系统设置里给 cccodroid 允许后台运行、关闭电池优化、允许自启动（各家叫法不同）。");
  }
  $("bg-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === "appsettings") post("/api/app/open_app_settings").catch(() => {});
    if (act === "ack") { const st = await post("/api/app/freeze_ack").catch(() => null); if (st) renderBg(st.frozen); }
  });

  async function loadPriv() {
    let st;
    try { st = await api("/api/priv/status"); } catch { return; }
    if (st.state === "unsupported") return;          // 旧版：没有这项集成
    renderBg(st.frozen);
    $("priv-field").classList.remove("hidden");
    const el = $("priv-state");
    if (st.state === "ok") {
      el.className = "prov-state ok";
      el.textContent = t("✓ 已就绪 · 以 {who} 身份执行", { who: st.uid === 0 ? "root" : st.uid === 2000 ? "shell" : "uid " + st.uid }) + (st.version ? " · Shizuku v" + st.version : "");
    } else {
      const [cls, txt] = PRIV_TEXT[st.state] || ["err", st.message || t("状态未知")];
      el.className = "prov-state " + cls;
      el.textContent = txt + (st.lastPermission === "denied" ? t("（上次被拒绝了）") : "");
    }
    // 一键安装 / 激活的进度
    const su = st.setup || { phase: "idle" };
    const busy = SETUP_BUSY.includes(su.phase);
    const se = $("priv-setup");
    const showSetup = su.message && !(st.state === "ok" && su.phase !== "done");
    se.classList.toggle("hidden", !showSetup);
    if (showSetup) {
      se.className = "prov-state " + (su.phase === "error" ? "err" : su.phase === "done" ? "ok" : "warn");
      se.textContent = su.message + (su.phase === "downloading" && su.total ? `（${fmtSize(su.done)} / ${fmtSize(su.total)}）` : "");
    }
    $("priv-pair").classList.toggle("hidden", su.phase !== "pairing");
    const wl = st.wireless !== false;
    $("priv-actions").innerHTML =
      st.state === "not_installed" ? `<button class="btn sm" data-act="activate" ${busy ? "disabled" : ""}>${t("一键安装并激活")}</button>
        <a class="btn sm ghost" href="https://shizuku.rikka.app/download/" target="_blank" rel="noopener">${t("手动下载")} ↗</a>` :
      st.state === "not_running" ? (wl ? `<button class="btn sm" data-act="activate" ${busy ? "disabled" : ""}>${t("一键激活（无线调试）")}</button>` : "") +
        `<button class="btn sm ghost" data-act="open">${t("打开 Shizuku")}</button>` :
      st.state === "no_permission" ? `<button class="btn sm" data-act="request">${t("授权给 cccodroid")}</button>` : "";
    // Shizuku 在跑，但没有（或已失效的）无线调试配对：重启后就没法自动激活。这种情况平时看不出来，主动提示
    if (st.state === "ok" && wl && !st.paired && !busy) {
      se.classList.remove("hidden");
      se.className = "prov-state warn";
      se.textContent = st.pairOk === 0
                ? t("无线调试里 cccodroid 的配对已被取消：现在还能用，但重启手机后没法自动激活。")
        : t("Shizuku 不是由 cccodroid 激活的：重启手机后 cccodroid 没法自动激活它。配对一次即可。");
      $("priv-actions").insertAdjacentHTML("afterbegin", `<button class="btn sm" data-act="repair">${st.pairOk === 0 ? t("重新配对") : t("配对")}</button>`);
    }
    // 说的是「这次开机」，允许了自启动也要等下次开机才会消失；点「已允许」就收起到下次开机
    if (st.bootMissed && !(st.bootAt && Math.abs(st.bootAt - (+localStorage.getItem("cc.bootAck") || 0)) <= 1)) {
      se.classList.remove("hidden");
      se.className = "prov-state warn";
      se.textContent = t("这次开机系统没通知 cccodroid（被系统的「自启动」管理拦了），所以开机没能自动激活；打开 cccodroid 时会补上。") +
        t("想开机就激活：在应用详情里允许 cccodroid 自启动 / 后台启动，下次开机生效。");
      $("priv-actions").insertAdjacentHTML("beforeend", `<button class="btn sm ghost" data-act="appsettings">${t("去允许自启动")}</button>` +
        (st.bootAt ? `<button class="btn sm ghost" data-act="bootack" data-boot="${st.bootAt}">${t("已允许，下次开机再看")}</button>` : ""));
    }
    if (st.dev) {                                     // 开发端：Shizuku 由它自己的应用管理，这里只报实测状态
      $("priv-actions").innerHTML = "";
      if (st.state !== "ok") {
        se.classList.remove("hidden");
        se.className = "prov-state warn";
        se.textContent = t("在 Shizuku 应用里启动服务（建议开「开机启动（无线调试）」），并确认已授权给本应用。") + (st.message ? "（" + st.message + "）" : "");
      }
    }
    $("priv-actions").insertAdjacentHTML("beforeend", `<button class="btn sm ghost" data-act="refresh">${t("刷新")}</button>`);
    $("priv-auto-row").classList.toggle("hidden", !(wl && st.paired));
    $("priv-auto").checked = st.autostart !== false;
    $("priv-ka-row").classList.toggle("hidden", !!st.dev);
    $("priv-ka-row").style.opacity = st.state === "ok" ? "1" : ".45";
    $("priv-ka").disabled = st.state !== "ok";
    $("priv-ka").checked = !!st.keepalive;
    // 安装、配对、启动都在进行时自己刷新（设置页开着才刷）
    clearTimeout(privPoll);
    if (busy && !$("tab-settings").classList.contains("hidden")) privPoll = setTimeout(loadPriv, 1500);
  }
  $("priv-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === "open") await post("/api/priv/open").catch(() => {});
    if (act === "appsettings") return post("/api/app/open_app_settings").catch(() => {});
    // 原地换成一句确认、不重排：整段收起会让下面的开关挪到手指底下被误点。下次打开设置页才真正消失
    if (act === "bootack") { localStorage.setItem("cc.bootAck", e.target.dataset.boot); $("priv-setup").textContent = t("好的，下次开机后再检查。"); e.target.disabled = true; return; }
    if (act === "repair") { await post("/api/app/shz_repair").catch((e2) => toast(e2.message, true)); return setTimeout(loadPriv, 500); }
    if (act === "activate") { await post("/api/app/shz_activate").catch((e2) => toast(e2.message, true)); return setTimeout(loadPriv, 500); }
    if (act === "request") {
      const r = await post("/api/priv/request").catch((e2) => ({ message: e2.message }));
      toast(r.message || t("已请求"));
      // 授权对话框在 Shizuku 那边弹，回来后多刷几次
      for (let i = 0; i < 10; i++) { await new Promise((ok) => setTimeout(ok, 1500)); await loadPriv(); if ($("priv-state").classList.contains("ok")) break; }
      return;
    }
    loadPriv();
  });
  $("priv-pair").addEventListener("click", async (e) => {
    if (!(e.target.dataset && e.target.dataset.act === "pair")) return;
    const code = $("priv-code").value.replace(/\D/g, "");
    if (code.length !== 6) return toast(t("配对码是 6 位数字"), true);
    const port = $("priv-port").value.replace(/\D/g, "");
    $("priv-code").value = "";
    await post("/api/app/shz_pair", { code: port ? code + " " + port : code }).catch((e2) => toast(e2.message, true));
    setTimeout(loadPriv, 500);
  });
  $("priv-auto").addEventListener("change", (e) => post("/api/app/shz_autostart", { enable: e.target.checked }).catch(() => {}));

  // ── 更新：应用本体 / 开发工具包 / Claude Code ──
    const UPD_TEXT = { uptodate: t("已是最新"), available: t("有新版本"), downloading: t("下载中"), ready: t("已下载，待安装"), installing: t("安装中"), error: t("出错"), unknown: t("未检查"), verifying: t("校验中"), damaged: t("已损坏") };
  let updPoll = null;
  let updFollowUntil = 0;
  const followUpd = () => { updFollowUntil = Date.now() + 15000; };
  async function loadUpd() {
    let st;
    try { st = await api("/api/app/upd_status"); } catch { return; }
    if (!st.ok || !st.items) return;                 // 旧版 / 开发端：没有这项
    $("upd-field").classList.remove("hidden");
    $("upd-auto").checked = !!st.auto;
    $("upd-channel").value = st.channel || "stable";
    let moving = st.checking;
    $("upd-items").innerHTML = st.items.map((it) => {
      const busy = it.state === "downloading" || it.state === "installing" || it.state === "verifying";
      moving ||= busy;
      const ver = esc(it.current || "?") + (it.latest && it.latest !== it.current && it.state !== "uptodate" ? " → " + esc(it.latest) : "");
      const prog = it.state === "downloading" && it.total ? `（${fmtSize(it.done)} / ${fmtSize(it.total)} · ${Math.floor(it.done * 100 / it.total)}%）`
        : (it.state === "installing" || it.state === "verifying") && it.total ? `（${Math.floor(it.done * 100 / it.total)}%）` : "";
      const cls = it.state === "error" || it.state === "damaged" ? "err" : it.state === "uptodate" ? "ok" : it.state === "unknown" ? "" : "warn";
      const btn = it.state === "available" ? (it.id === "claude" ? t("更新") : t("下载并安装"))
        : it.state === "ready" ? t("安装") : it.state === "damaged" ? t("修复") : it.state === "error" && it.latest ? t("重试") : "";
      // 工具包：随时可以逐个核对文件；坏了就「修复」（重装同一版本）
      const act = it.state === "damaged" ? "repair" : "";
      const verifyBtn = it.id === "devkit" && it.current && ["uptodate", "unknown", "error", "damaged"].includes(it.state)
        ? `<button class="btn sm ghost" data-item="devkit" data-act="verify">${t("校验")}</button>` : "";
      return `<div class="row-actions" style="justify-content:space-between">
        <div><b>${esc(it.name)}</b> <span class="tiny">${ver}</span><br>
          <span class="prov-state ${cls}" style="margin:0">${UPD_TEXT[it.state] || esc(it.state)}${prog}${it.message ? " · " + esc(it.message) : ""}</span></div>
        <div class="row-actions">${verifyBtn}${btn ? `<button class="btn sm" data-item="${esc(it.id)}"${act ? ` data-act="${act}"` : ""}>${btn}</button>` : ""}</div></div>`;
    }).join("");
    const v = st.verify;
    if (v && v.manifest && (v.missing || v.changed) && (v.samples || []).length)
      $("upd-items").insertAdjacentHTML("beforeend", `<pre class="tiny mono" style="white-space:pre-wrap;margin:6px 0 0;color:var(--fg3)">${esc(v.samples.join("\n"))}${v.missing + v.changed > v.samples.length ? "\n…" : ""}</pre>`);
    $("upd-last").textContent = st.checking ? t("检查中…") : st.error ? "✗ " + st.error
      : st.lastCheck ? t("上次检查：{at}", { at: new Date(st.lastCheck).toLocaleString() }) : t("还没检查过");
    clearTimeout(updPoll);
    // 点完按钮 / 换完渠道后的一小段时间也接着刷：后台的检查、换版本要过一会儿才开始，只看「正在进行」会漏掉结果
    if ((moving || st.checking || Date.now() < updFollowUntil) && !$("tab-settings").classList.contains("hidden")) updPoll = setTimeout(loadUpd, 1500);
  }
  $("upd-items").addEventListener("click", async (e) => {
    const item = e.target.dataset && e.target.dataset.item;
    if (!item) return;
    const act = e.target.dataset.act;
    if (act === "verify" || act === "repair") {
      if (act === "repair" && !confirm(t("修复开发工具包？\n\n会重新下载当前这一版（约 600 MB，断点续传）并重装，装的时候暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
      const r = await post(act === "verify" ? "/api/app/upd_verify" : "/api/app/upd_repair", { full: true }).catch((e2) => ({ ok: false, message: e2.message }));
      toast(r.message || (r.ok ? t("开始") : t("失败")), !r.ok);
      followUpd(); setTimeout(loadUpd, 500);
      return;
    }
    if (item === "devkit" && !confirm(t("更新开发工具包？\n\n下载约 600 MB（断点续传），装的时候会暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
    const r = await post("/api/app/upd_apply", { item }).catch((e2) => ({ ok: false, message: e2.message }));
    toast(r.message || (r.ok ? t("开始") : t("失败")), !r.ok);
    followUpd(); setTimeout(loadUpd, 500);
  });
  // ── 通知（只有 cccodroid：GatewayService 订阅事件流发通知）──
  async function loadNotify() {
    let st;
    try { st = await api("/api/app/notify_status"); } catch { return; }
    if (!st.ok) return;                              // 开发端 / 旧版：没有这项
    $("ntf-field").classList.remove("hidden");
    $("ntf-done").checked = !!st.done;
    $("ntf-ask").checked = !!st.ask;
    // 系统层面关掉了（整个应用 / 单个渠道）：开关开着也收不到，说清楚并给个入口
    const off = !st.system ? t("系统设置里关掉了本应用的通知，上面的开关不起作用。")
      : (st.ask && !st.chAsk) || (st.done && !st.chDone) ? t("系统设置里关掉了其中一类通知（「等你确认」或「任务完成」）。") : "";
    $("ntf-off").textContent = off;
    $("ntf-off").classList.toggle("hidden", !off);
    $("ntf-actions").classList.toggle("hidden", !off);
  }
  for (const k of ["done", "ask"])
    $("ntf-" + k).addEventListener("change", (e) => post("/api/app/notify_set", { [k]: e.target.checked }).then(loadNotify).catch(() => {}));
  $("ntf-sys").addEventListener("click", () => post("/api/app/notify_settings").catch(() => {}));

  $("upd-check").addEventListener("click", async () => {
    await post("/api/app/upd_check").catch((e2) => toast(e2.message, true));
    followUpd(); setTimeout(loadUpd, 300);
  });
  $("upd-auto").addEventListener("change", (e) => post("/api/app/upd_set", { auto: e.target.checked }).then(loadUpd).catch(() => {}));
  $("upd-channel").addEventListener("change", (e) => { followUpd(); post("/api/app/upd_set", { channel: e.target.value }).then(loadUpd).catch(() => {}); });
  $("priv-ka").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (on && !confirm(t("开启后台保活增强？\n\n会改几项系统设置：幽灵进程上限（影响所有应用）、本应用的电池白名单与后台运行限制。关掉开关会恢复前两项。"))) {
      e.target.checked = false; return;
    }
    const out = $("priv-ka-result");
    out.className = "prov-state"; out.textContent = on ? t("正在应用…") : t("正在恢复…");
    const r = await post("/api/priv/keepalive", { enable: on }).catch((e2) => ({ ok: false, message: e2.message }));
    out.className = "prov-state " + (r.ok ? "ok" : "err");
    out.textContent = r.ok
            ? (on ? t("✓ 已应用") + (r.phantom ? t("（幽灵进程上限 {n}）", { n: r.phantom }) : "") : t("✓ 已恢复"))
      : "✗ " + (r.message || t("失败"));
    loadPriv();
  });

  // ── 内存管家（cc-mem）──
  function fillMem() {
    const g = (state.settings && state.settings.memGuard) || {};
    $("mem-on").checked = !!g.enabled;
    if (document.activeElement !== $("mem-wl")) $("mem-wl").value = (g.whitelist || []).join("\n");
  }
  function memOut(cls, text) { const o = $("mem-result"); o.className = "prov-state " + cls; o.textContent = text; }
  const GB = (b) => (b / 1073741824).toFixed(1) + "G";
  async function saveMem(patch) {
    const g = { ...((state.settings && state.settings.memGuard) || {}), ...patch };
    const r = await api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memGuard: g }) });
    if (r && r.settings) state.settings.memGuard = r.settings.memGuard;
    fillMem();
    return r;
  }
  $("mem-on").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (on && !confirm(t("开启内存管家？\n\n开启后，清理时会停掉白名单以外的后台应用：它们要等你再打开、或被系统重新唤起才会恢复，这段时间可能收不到它们的消息。要一直收消息的应用（比如聊天软件）请加进白名单。"))) {
      e.target.checked = false; return;
    }
    try { await saveMem({ enabled: on }); memOut("ok", on ? t("✓ 已开启") : t("✓ 已关闭")); }
    catch (e2) { e.target.checked = !on; memOut("err", "✗ " + e2.message); }
  });
  $("mem-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === "save") {
      const wl = $("mem-wl").value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
      const bad = wl.filter((x) => !/^[A-Za-z][\w]*(\.[\w]+)+$/.test(x));
      if (bad.length) return memOut("err", t("不是合法的包名：{list}", { list: bad.join("、") }));
      try { await saveMem({ whitelist: wl }); memOut("ok", t("✓ 白名单已保存（{n} 个）", { n: wl.length })); }
      catch (e2) { memOut("err", "✗ " + e2.message); }
      return;
    }
    if (act === "status") {
      memOut("", t("正在统计…"));
      const r = await api("/api/mem/status").catch((e2) => ({ ok: false, message: e2.message }));
      if (!r.ok) return memOut("err", "✗ " + (r.message || t("失败")));
      const stop = r.apps.filter((a) => !a.protect), sum = stop.reduce((n, a) => n + a.pss, 0);
      memOut("ok", t("可用 {avail} / 共 {total}。可停的后台应用 {n} 个，约占 {sum}：{list}", {
        avail: GB(r.mem.available), total: GB(r.mem.total), n: stop.length, sum: GB(sum),
        list: stop.slice(0, 8).map((a) => a.pkg).join("、") + (stop.length > 8 ? " …" : ""),
      }));
      return;
    }
    if (act === "clear") {
      if (!$("mem-on").checked) return memOut("err", t("先打开上面的开关"));
      memOut("", t("正在清理…"));
      const r = await api("/api/mem/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch((e2) => ({ ok: false, message: e2.message }));
      if (!r.ok) return memOut("err", "✗ " + (r.message || t("失败")));
      memOut("ok", r.stopped.length
        ? t("✓ 停了 {n} 个，可用内存 {a} → {b}", { n: r.stopped.length, a: GB(r.availableBefore), b: GB(r.availableAfter) })
        : t("没有可停的后台应用"));
    }
  });

  // ── 自定义接口卡（任何讲 Anthropic Messages 协议的端点）──
  function renderCustomCard(box, p) {
    const v = p || { label: "", baseUrl: "", authStyle: "bearer", modelsUrl: "", defaultModel: "", fastModel: "" };
    box.innerHTML = `<div class="sub">${p ? esc(pLabel(p)) : t("新增自定义接口")}</div>
      <input id="cc-label" placeholder="${t("名字（比如：公司网关）")}" value="${esc(v.label)}">
      <input id="cc-base" placeholder="${t("端点地址，如")} https://example.com/anthropic" value="${esc(v.baseUrl)}">
      <select id="cc-auth">
        <option value="bearer" ${v.authStyle !== "x-api-key" ? "selected" : ""}>${t("认证：Authorization: Bearer（多数第三方）")}</option>
        <option value="x-api-key" ${v.authStyle === "x-api-key" ? "selected" : ""}>${t("认证：x-api-key（Anthropic 风格）")}</option>
      </select>
      <input id="cc-model" placeholder="${t("默认模型名（必填，claude 不认识第三方模型）")}" value="${esc(v.defaultModel || "")}">
      <input id="cc-fast" placeholder="${t("快模型名（选填，子代理用；留空同上）")}" value="${esc(v.fastModel || "")}">
      <input id="cc-models" placeholder="${t("模型清单地址（选填，OpenAI 形状的 /models）")}" value="${esc(v.modelsUrl || "")}">
      <input id="pc-key" type="password" autocomplete="off"
        placeholder="${p && p.hasKey ? t("已保存（…{tail}），留空则不改", { tail: esc(p.keyTail) }) : t("粘贴 API Key")}">
      <div class="row-actions">
        <button class="btn sm" data-act="save">${p ? t("保存") : t("添加")}</button>
        ${p ? `<button class="btn sm ghost" data-act="test">${t("测试")}</button>
               <button class="btn sm ghost danger" data-act="del">${t("删除")}</button>${useBtn(p)}` : ""}
      </div>
      <div class="prov-state" id="pc-result"></div>
            <div class="tiny">${t("要求对端讲 <b>Anthropic Messages</b> 协议（各家文档里写“Claude Code 接入”的那个地址）。")}
        ${t("地址末尾不要带 <code>/v1</code>，claude 会自己补 <code>/v1/messages</code>。")}</div>`;
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "use") return useProvider(p);
      if (act === "test") return testAndShow(p.id);
      if (act === "del") {
        if (!confirm(t("删除接口「{name}」？", { name: p.label }))) return;
        try { await post("/api/providers/delete", { id: p.id }); } catch (e2) { return toast(e2.message, true); }
        state.provView = state.providerActive === p.id ? null : state.providerActive;
        return reloadProv(t("已删除"));
      }
      const body = {
        id: p ? p.id : "", label: $("cc-label").value.trim(), baseUrl: $("cc-base").value.trim(),
        authStyle: $("cc-auth").value, defaultModel: $("cc-model").value.trim(), fastModel: $("cc-fast").value.trim(),
        modelsUrl: $("cc-models").value.trim(), apiKey: $("pc-key").value.trim(),
      };
      if (!body.defaultModel) return toast(t("默认模型名必填"), true);
      let r;
      try { r = await post("/api/providers/save", body); } catch (e2) { return toast(e2.message, true); }
      state.provView = r.id;
      await reloadProv(p ? t("已保存") : t("已添加"), true);
    };
  }

  /** 模型与 effort 档位都从厂商的 /models 实时拉 */
  async function loadModels(refresh) {
    try {
      const r = await api("/api/models" + (refresh ? "?refresh=1" : ""));
      MODELS = r.models || [];
      const sel = $("set-model");
      // 原生厂商（官方账户）：不挑 = 用它自己的默认模型。
      // 这时候列表框里得有个诚实的"默认"项 —— 否则列表第一条（比如 haiku）会顶在上面，
      // 让人以为正在用的就是它，其实 claude 用的是自己挑的那个。
      const dfltOpt = r.nativeModels
        ? (r.defaultModel ? `<option value="">${t("（默认：{model}）", { model: esc(r.defaultModel) })}</option>`
                           : `<option value="">${t("（默认，由 claude 决定）")}</option>`)
        : "";
      sel.innerHTML = (dfltOpt + (MODELS.length
        ? MODELS.map((m) => {
            const img = (m.input_modalities || []).includes("image") ? " 🖼" : "";
            // 官方 /v1/models 只报能力，不报窗口 —— 报不出来就别写 "0k"
            const ctx = m.context_window ? Math.round(m.context_window / 1024) + "k" : "—";
            return `<option value="${esc(m.id)}">${esc(m.id)} · ${esc(m.name || "")} · ${ctx}${img}</option>`;
          }).join("")
        : (dfltOpt ? "" : '<option value="">' + t("（该厂商不提供模型清单）") + '</option>')));
      if (r.current) {
        sel.value = r.current;
        // 当前模型不在厂商 /models 的清单里（比如 DeepSeek 的 deepseek-flash 是兼容端点认的别名）：
        // 不补一项的话下拉框会显示空白，像是没选模型
        if (sel.value !== r.current) {
          sel.insertAdjacentHTML("afterbegin", `<option value="${esc(r.current)}">${esc(r.current)} · ${t("（当前，不在厂商清单里）")}</option>`);
          sel.value = r.current;
        }
      } else if (r.nativeModels) sel.value = "";
      $("model-count").textContent = t("{n} 个", { n: MODELS.length });
      renderEffort(r.effortLevels || [], r.effort || "", r.effortDefault);

      // 用量条：总刻度用厂商给的真实窗口，但设了压缩窗口就改以它为满刻度
      if (r.contextWindow) state.ctxTotal = r.contextWindow;
      state.compactAt = Number(r.autoCompactWindow) || 0;
      updateCtx(state.ctxUsed, state.ctxTotal);
      const cur = MODELS.find((m) => m.id === r.current);
      if (cur) {
        const k = (v) => (v ? Math.round(v / 1024) + "k" : "—");
        $("model-info").innerHTML =
                    t("上下文 {n} · 输出上限 {out} · 输入 {mods}", { n: k(cur.context_window), out: k(cur.max_output_tokens), mods: (cur.input_modalities || []).join(" / ") }) +
          t("｜也可直接打 <code>/model &lt;id&gt;</code>");
        const ac = $("set-autocompact");
        if (ac && document.activeElement !== ac) ac.value = r.autoCompactWindow || "";
      } else if (r.nativeModels) {
        $("model-info").innerHTML =
                    t("没指定模型 → <b>由 claude 自己决定</b>（官方账户当前默认 <code>{model}</code>）。", { model: esc(r.defaultModel || t("claude 内置默认")) }) +
          t("<br>上面的清单就是账户里能用的全部型号，挑一个即锁定。");
      } else if (!MODELS.length) {
        $("model-info").innerHTML =
                    t("该厂商由 claude 自己决定模型，没有可切换的清单。要指定就改 <code>ccapp-providers.json</code> 的 <code>defaultModel</code>。");
      }
    } catch (e) {
      $("model-info").textContent = t("拉取模型清单失败：{msg}", { msg: e.message });
    }
  }

  function renderEffort(levels, current, dflt) {
    const sel = $("set-effort");
    // 留一个"不指定"：没设过档位时 claude 按模型自己的默认走。
    // 以前没这一项，下拉框会显示第一档 low，让人以为正在用 low，而且一旦选过就再也撤不回默认
    sel.innerHTML = (dflt ? `<option value="">${t("（默认：{model}）", { model: esc(dflt) })}</option>`
                            : `<option value="">${t("（默认，由 claude 按模型决定）")}</option>`) +
      levels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
    sel.value = current && levels.includes(current) ? current : "";
    $("effort-info").innerHTML =
      t("档位越高思考越久。也可在输入框打 <code>/effort &lt;level&gt;</code>");
  }

  async function loadSettings() {
    try {
      state.settings = await api("/api/settings");
      $("set-perm").value = state.settings.permissionMode || "default";
      // 输出风格清单由网关列（内置 + 自定义 .md），不再写死 —— 以前写死的 concise 根本不存在
      $("set-style").innerHTML = '<option value="">' + t("（默认）") + '</option>' +
        (state.settings.outputStyles || []).map((o) =>
          `<option value="${esc(o.id)}">${esc(o.id)}${o.desc ? " · " + esc(o.desc) : ""}</option>`).join("");
      $("set-style").value = state.settings.outputStyle || "";
      // 没指定模型时别把顶栏写成 "—"：init 报过的真实模型更有用
      modelEl.textContent = state.settings.model || state.model || t("默认");
      setPermChip(state.settings.permissionMode || "default");
      renderPermBar();
      renderDirs();
      fillMem();
      await loadProviders();
      await loadModels();
      $("set-model").value = state.settings.model || "";
      $("set-effort").value = state.settings.effort || "";
      const pe = $("set-parallel");
      if (pe && document.activeElement !== pe) { pe.max = state.settings.maxParallelCap || 16; pe.value = state.settings.maxParallel || 3; }
    } catch {}
  }


  function renderDirs() {
    const dirs = state.settings.addDirs || [];
    $("dir-list").innerHTML = dirs.length
      ? dirs.map((d, i) => `<div class="item"><div class="it-title">${esc(d)}</div>
          <div class="it-acts"><button data-i="${i}">${t("移除")}</button></div></div>`).join("")
      : '<div class="tiny">' + t("（没有附加目录）") + '</div>';
    $("dir-list").querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const dirs2 = (state.settings.addDirs || []).filter((_, i) => i !== Number(b.dataset.i));
      await saveSettings({ addDirs: dirs2 });
    }));
  }

  async function saveSettings(patch) {
    try {
      const r = await api("/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      state.settings = { ...state.settings, ...(r.settings || {}) };
      modelEl.textContent = state.settings.model || state.model || t("默认");
      setPermChip(state.settings.permissionMode || "default");
      renderDirs();
            toast(t("已保存"));
      return r;
    } catch (e) { toast(e.message || t("保存失败"), true); }
  }

  $("set-provider").addEventListener("change", (e) => {
    state.provView = e.target.value;
    renderProvCard();
  });

  $("set-model").addEventListener("change", async (e) => {
    await saveSettings({ model: e.target.value });
    await loadModels();                                  // 换模型后 effort 档位可能不同
    $("set-effort").value = state.settings.effort || "";
  });
  $("set-perm").addEventListener("change", (e) => changePermMode(e.target.value));
  $("set-style").addEventListener("change", (e) => saveSettings({ outputStyle: e.target.value }));
  $("set-effort").addEventListener("change", (e) => saveSettings({ effort: e.target.value }));

  $("set-parallel").addEventListener("change", (e) => {
    const v = Math.round(Number(e.target.value));
    if (!(v >= 1)) { e.target.value = state.settings.maxParallel || 3; return; }
    saveSettings({ maxParallel: v }).then(() => { e.target.value = state.settings.maxParallel || v; });
  });
  $("set-autocompact").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    saveSettings({ autoCompactWindow: v ? Number(v) : null }).then(() => loadModels());
  });
  $("btn-add-dir").addEventListener("click", () => {
    const v = $("inp-dir").value.trim();
    if (!v) return;
    saveSettings({ addDirs: [...(state.settings.addDirs || []), v] });
    $("inp-dir").value = "";
  });
  $("btn-cli-doctor").addEventListener("click", async () => {
    const box = $("cli-out");
    box.classList.remove("hidden");
    box.textContent = t("正在运行 claude doctor…");
    try {
      const r = await api("/api/cli?cmd=" + encodeURIComponent("doctor"));
      box.textContent = (r.out || "") + (r.err ? "\n" + r.err : "") || t("(无输出)");
    } catch (e) { box.textContent = t("失败：{msg}", { msg: e.message }); }
  });

  // ── 能力面板 ──────────────────────────────────────────────────────
  function cacheCapsFromInit(ev) {
    state.caps = state.caps || {};
    state.caps.tools = ev.tools || state.caps.tools || [];
    state.caps.skills = ev.skills || state.caps.skills || [];
    state.caps.agents = ev.agents || state.caps.agents || [];
    state.caps.mcpServers = ev.mcpServers || state.caps.mcpServers || [];
    state.caps.slashCommands = (ev.slashCommands || []).filter((c) => !String(c).startsWith("__"))
      .map((c) => (typeof c === "string" ? { name: c, cat: t("其他"), desc: "" } : c));
    renderCaps();
  }

  async function loadCaps() {
    try {
      state.caps = await api("/api/capabilities");
      renderCaps();
    } catch {}
  }

  function chips(el, arr, hl) {
    el.innerHTML = arr?.length
      ? arr.map((x) => `<span class="chip ${hl ? "hl" : ""}">${esc(x)}</span>`).join("")
      : '<span class="tiny">' + t("（暂无数据，先发一条消息即可从 CLI 获取）") + '</span>';
  }

  function renderCaps() {
    const c = state.caps || {};
    $("caps-summary").innerHTML = c.version
      ? t("Claude Code {ver} · 模型 {model} · 权限 {perm} · 输出风格 {style}", { ver: esc(c.version), model: esc(c.model || "—"), perm: esc(c.permissionMode || "—"), style: esc(c.outputStyle || "default") })
      : t("还没有从 CLI 拿到能力清单 —— 发出第一条消息后会自动填充。");

    const cmds = (c.slashCommands || []).map((x) => "/" + (x.name || x));
    $("c-count").textContent = cmds.length;
    chips($("caps-cmds"), cmds, true);
    $("t-count").textContent = (c.tools || []).length;
    chips($("caps-tools"), c.tools);
    $("s-count").textContent = (c.skills || []).length;
    chips($("caps-skills"), c.skills);
    $("a-count").textContent = (c.agents || []).length;
    chips($("caps-agents"), c.agents);
    chips($("caps-mcp"), (c.mcpServers || []).map((m) => m.name || String(m)));
    chips($("caps-plugins"), c.plugins);
  }

  $("btn-refresh-mcp").addEventListener("click", async () => {
    chips($("caps-mcp"), [t("查询中…")]);
    try {
      const r = await api("/api/cli?cmd=" + encodeURIComponent("mcp list"));
      const lines = (r.out || "").split("\n").map((s) => s.trim()).filter(Boolean);
      chips($("caps-mcp"), lines.length ? lines.slice(0, 40) : [t("(无 MCP 服务器)")]);
    } catch (e) { chips($("caps-mcp"), [t("查询失败：{msg}", { msg: e.message })]); }
  });

  // ── 抽屉 / 面板 ───────────────────────────────────────────────────
  function openDrawer(tab) {
    drawerEl.classList.remove("hidden");
    if (tab) switchTab(tab);
    refreshStatus();
    if (!tab) { loadSessions(); loadCaps(); }
  }
  // 三栏宽屏时侧栏常驻在左边：开会话之类顺手的关闭不收它，只有用户点 ✕ / 菜单键（force）才收
  function closeDrawer(force) { if (!force && window.CCLayout && CCLayout.docked()) return; drawerEl.classList.add("hidden"); }
  // 切到哪个标签就加载哪个的数据 —— 点标签和 openDrawer 都走这里
  // （以前加载只写在 openDrawer 里，点"设置"标签进去 Shizuku / 更新几块永远不出来）
  function switchTab(name) {
    const cur = document.querySelector(".tab.active")?.dataset.tab;
    if (cur && cur !== name) { const pn = document.querySelector(".drawer-panel"); if (pn) pn.scrollTop = 0; }   // 换标签从顶上看起
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + name));
    if (name === "sessions") loadSessions();
    if (name === "caps") loadCaps();
    if (name === "ext") loadExt();
    if (name === "help") loadHelp();
    if (name === "settings") { loadProviders(); loadPriv(); loadUpd(); loadNotify(); }
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // ── 帮助 ── 文档是 web/help/zh.md、en.md（其他语言先用英文）。第一次点开才取、才渲染；
  // 「## 」小节做成目录，点了在侧栏里滚到那一节；每节标题旁一个 ↑ 回目录。换了界面语言下次点开重新取。
  let helpLang = "";
  async function loadHelp() {
    const lang = /^zh/.test((window.I18N && I18N.lang) || "zh") ? "zh" : "en";
    if (helpLang === lang) return;
    const body = $("help-body"), toc = $("help-toc");
    body.innerHTML = `<p class="muted">${esc(t("加载中…"))}</p>`;
    try {
      const r = await fetch("/help/" + lang + ".md", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setHtml(body, renderMd(await r.text()));
      helpLang = lang;
    } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    toc.textContent = "";
    body.querySelectorAll("h3").forEach((h, i) => {        // renderMd 把 ## 渲染成 h3
      h.id = "help-" + i;
      const a = document.createElement("button");
      a.type = "button";
      a.className = "help-link";
      a.textContent = h.textContent;
      a.onclick = () => h.scrollIntoView({ block: "start", behavior: "smooth" });
      toc.appendChild(a);
      const up = document.createElement("button");
      up.type = "button";
      up.className = "help-up";
      up.textContent = "↑";
      up.title = t("回到目录");
      up.onclick = () => toc.scrollIntoView({ block: "start", behavior: "smooth" });
      h.appendChild(up);
    });
  }
  $("btn-menu").addEventListener("click", () => { if (!(window.CCLayout && CCLayout.toggleDock())) openDrawer("sessions"); });
  // ── 文件查看 / 编辑器 ──────────────────────────────────────────────
  // 文本 / 代码：直接改，保存时带上打开那一刻的 mtime —— Claude 在这期间改过就先问，别互相覆盖。
  // Markdown：默认渲染，可切到编辑。图片：点一下在「适应屏幕」和「原始大小」之间切。
  // PDF：pdf.js（按需加载），页面进视野才画、离远了就释放，几百页的也不会把 WebView 撑爆。
  // ── git 面板：改动 / 历史 / 逐行对比 / 提交 / 撤销 ──────────────────────
  // 从文件面板（当前目录所在的仓库）或编辑器（这个文件）打开。只是 git 命令的界面，网关见 handleGit
  const gitEl = $("git");
  const GIT = { dir: "", root: "", tab: "changes", status: null, sel: new Set(), file: "", view: null, wrap: true };
  const gapi = (act, params) => api(`/api/git/${act}?` + new URLSearchParams({ dir: GIT.dir, ...(params || {}) }));
  const gpost = (act, body) => api(`/api/git/${act}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: GIT.dir, ...body }) });
  const GS = { modified: "M", added: "A", new: "U", deleted: "D", renamed: "R", conflict: "!" };
  const gsTitle = (k) => ({ modified: t("已修改"), added: t("已添加"), new: t("新文件"), deleted: t("已删除"), renamed: t("已改名"), conflict: t("有冲突") })[k] || k;
  const gnum = (f) => (f.add == null && f.del == null) ? (f.binary ? `<span class="gn">${t("二进制")}</span>` : "")
    : `<span class="gn"><span class="a">+${f.add ?? 0}</span> <span class="d">−${f.del ?? 0}</span></span>`;
  const gbdi = (s) => `<bdi>${esc(s)}</bdi>`;

  /** 打开：dir 可以是目录或文件；opts.file 指定先看哪个文件的对比，opts.tab = "history" 看历史 */
  async function openGit(dir, opts = {}) {
    Object.assign(GIT, { dir, root: "", tab: opts.tab || "changes", status: null, file: opts.file || "", view: opts.file ? (opts.tab === "history" ? { kind: "log" } : { kind: "diff" }) : null });
    GIT.sel = new Set();
    gitEl.classList.remove("hidden");
    $("git-name").textContent = String(dir).split("/").pop();
    $("git-info").textContent = "";
    await gitLoad();
  }
  function closeGit() { gitEl.classList.add("hidden"); $("git-body").innerHTML = ""; }
  $("git-close").addEventListener("click", closeGit);
  $("git-reload").addEventListener("click", () => gitLoad());
  gitEl.querySelector(".git-tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".git-tab"); if (!b) return;
    GIT.tab = b.dataset.tab; GIT.view = null; GIT.file = ""; gitRender();
  });

  async function gitLoad() {
    $("git-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let s;
    try { s = await gapi("status"); } catch (e) { $("git-body").innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    if (s.notRepo) {
      $("git-info").textContent = "";
      $("git-body").innerHTML = `<div class="vw-empty"><div>${t("这个文件夹还不是 git 仓库。")}</div>
        <div class="tiny">${esc(s.dir || GIT.dir)}</div>
        <div class="tiny">${t("建一个仓库后，每次改动都能看到改了哪几行，还能随时退回之前的版本。")}</div>
        <button class="btn sm" data-a="init">${t("在这里建一个仓库")}</button></div>`;
      $("git-body").querySelector('[data-a="init"]').onclick = async () => {
        try { await gpost("init"); toast(t("已建好仓库")); gitLoad(); } catch (e2) { toast(e2.message, true); }
      };
      return;
    }
    if (s.error) { $("git-body").innerHTML = `<div class="vw-empty">${esc(s.error)}</div>`; return; }
    GIT.status = s; GIT.root = s.root;
    // 默认全选；刷新时保留用户的取舍，新冒出来的文件默认选上
    const known = GIT.known || new Set();
    for (const f of s.files) if (!known.has(f.path)) GIT.sel.add(f.path);
    for (const p of [...GIT.sel]) if (!s.files.some((f) => f.path === p)) GIT.sel.delete(p);
    GIT.known = new Set(s.files.map((f) => f.path));
    $("git-name").textContent = s.root.split("/").pop();
    $("git-info").textContent = (s.branch ? "⎇ " + s.branch : "") +
      (s.ahead ? " · " + t("领先 {n}", { n: s.ahead }) : "") + (s.behind ? " · " + t("落后 {n}", { n: s.behind }) : "") +
      " · " + (s.files.length ? t("{n} 个文件有改动", { n: s.files.length }) : t("没有改动"));
    gitRender();
  }

  function gitRender() {
    gitEl.querySelectorAll(".git-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === GIT.tab));
    if (GIT.view && GIT.view.kind === "diff") return gitShowDiff(GIT.file, GIT.view.commit);
    if (GIT.view && GIT.view.kind === "commit") return gitShowCommit(GIT.view.commit);
    if (GIT.tab === "history") return gitShowLog(GIT.file);
    gitShowChanges();
  }

  function gitShowChanges() {
    const s = GIT.status; if (!s) return;
    const box = $("git-body");
    if (!s.files.length) { box.innerHTML = `<div class="vw-empty">${t("工作区是干净的：上次提交之后没有改动。")}</div>`; return; }
    const n = GIT.sel.size;
    box.innerHTML = `<div class="git-row tiny"><label><input type="checkbox" id="git-all" ${n === s.files.length ? "checked" : ""}> ${t("全选")}</label>
        <span style="flex:1"></span><span>${t("点文件看改了哪几行")}</span></div>
      ${s.files.map((f, i) => `<div class="git-row" data-i="${i}">
        <input type="checkbox" data-ck="${i}" ${GIT.sel.has(f.path) ? "checked" : ""}>
        <span class="gs gs-${f.kind}" title="${esc(gsTitle(f.kind))}">${GS[f.kind] || "?"}</span>
        <span class="gp" data-open="${i}">${gbdi(f.orig ? f.orig + " → " + f.path : f.path)}</span>
        ${gnum(f)}
        <button class="btn ghost sm" data-undo="${i}" title="${esc(t("把这个文件改回上次提交时的样子"))}">${t("撤销")}</button>
      </div>`).join("")}
      <div class="git-commit">
        <textarea id="git-msg" placeholder="${esc(t("提交说明：这次改了什么（必填）"))}"></textarea>
        <div id="git-id" class="hidden"></div>
        <div class="row-actions"><button class="btn sm" id="git-do" ${n ? "" : "disabled"}>${t("提交选中的 {n} 个文件", { n })}</button>
          <button class="btn ghost sm" id="git-ask">${t("让 Claude 写说明并提交")}</button></div>
      </div>`;
    box.querySelector("#git-all").onchange = (e) => { GIT.sel = e.target.checked ? new Set(s.files.map((f) => f.path)) : new Set(); gitShowChanges(); };
    box.onclick = async (e) => {
      const ck = e.target.dataset.ck, op = e.target.closest("[data-open]"), un = e.target.dataset.undo;
      if (ck != null) {
        const f = s.files[+ck]; e.target.checked ? GIT.sel.add(f.path) : GIT.sel.delete(f.path);
        const b = $("git-do"); b.disabled = !GIT.sel.size; b.textContent = t("提交选中的 {n} 个文件", { n: GIT.sel.size });
        return;
      }
      if (op) { GIT.file = s.files[+op.dataset.open].path; GIT.view = { kind: "diff" }; return gitRender(); }
      if (un != null) {
        const f = s.files[+un];
        const q = f.kind === "new" ? t("{f} 是新文件，撤销就是删掉它。确定？", { f: f.path }) : t("把 {f} 改回上次提交时的样子？这个文件没提交的改动会丢掉。", { f: f.path });
        if (!confirm(q)) return;
        try { const r = await gpost("discard", { file: f.path }); toast(r.message || t("已撤销")); gitLoad(); } catch (e2) { toast(e2.message, true); }
      }
    };
    $("git-do").onclick = () => gitCommit();
    $("git-ask").onclick = () => {
      const files = [...GIT.sel];
      closeGit();
      send(t("请看一下 {root} 里这些文件的改动，写一句简洁的提交说明，然后只提交它们：{files}", { root: GIT.root, files: files.join("、") || t("（全部改动）") }));
    };
  }

  async function gitCommit(again) {
    const msg = ($("git-msg")?.value || "").trim();
    if (!msg) { toast(t("写一句提交说明"), true); $("git-msg")?.focus(); return; }
    const all = GIT.sel.size === GIT.status.files.length;
    try {
      const r = await gpost("commit", { message: msg, files: all ? null : [...GIT.sel] });
      toast(r.message || t("已提交"));
      GIT.sel = new Set(); GIT.known = null;
      gitLoad();
    } catch (e) {
      if (e.status === 409 && !again) return gitAskIdentity();
      toast(e.message, true);
    }
  }
  /** 第一次提交：git 要知道署名。填一次，存进全局配置 */
  function gitAskIdentity() {
    const box = $("git-id"); box.classList.remove("hidden");
    box.innerHTML = `<div class="tiny">${t("第一次提交要先告诉 git 你的名字和邮箱（写进提交记录，存在本机）。")}</div>
      <input id="git-id-name" placeholder="${esc(t("名字"))}" autocomplete="off"><input id="git-id-mail" placeholder="${esc(t("邮箱"))}" autocomplete="off" inputmode="email">
      <button class="btn sm" id="git-id-ok">${t("保存并提交")}</button>`;
    $("git-id-ok").onclick = async () => {
      try { await gpost("identity", { name: $("git-id-name").value, email: $("git-id-mail").value }); }
      catch (e) { return toast(e.message, true); }
      box.classList.add("hidden");
      gitCommit(true);
    };
  }

  /** 统一 diff → 带行号的红绿行 */
  function diffHtml(text) {
    if (!text.trim()) return `<div class="tiny">${t("没有差异")}</div>`;
    const out = []; let o = 0, n = 0, open = false;
    const close = () => { if (open) out.push("</div>"); open = false; };
    for (const line of text.split("\n")) {
      if (line.startsWith("diff --git ")) {
        close();
        const m = line.match(/ b\/(.+)$/);
        out.push(`<div class="gdiff${GIT.wrap ? "" : " nowrap"}"><div class="fh">${esc(m ? m[1] : line)}</div>`); open = true; continue;
      }
      if (!open) { out.push(`<div class="gdiff${GIT.wrap ? "" : " nowrap"}">`); open = true; }
      if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) {
        if (/^(new file|deleted file|rename )/.test(line)) out.push(`<div class="ln meta"><span class="no"></span><span class="tx">${esc(line)}</span></div>`);
        continue;
      }
      if (line.startsWith("Binary files")) { out.push(`<div class="ln meta"><span class="no"></span><span class="tx">${t("二进制文件，无法逐行对比")}</span></div>`); continue; }
      const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (h) { o = +h[1]; n = +h[2]; out.push(`<div class="ln hunk"><span class="no">⋯</span><span class="tx">${esc(h[3].trim() || "")}</span></div>`); continue; }
      if (line.startsWith("\\")) continue;      // \ No newline at end of file
      const c = line[0];
      if (c === "+") out.push(`<div class="ln add"><span class="no">${n++}</span><span class="tx">${esc(line.slice(1)) || " "}</span></div>`);
      else if (c === "-") out.push(`<div class="ln del"><span class="no">${o++}</span><span class="tx">${esc(line.slice(1)) || " "}</span></div>`);
      else if (c === " ") { out.push(`<div class="ln"><span class="no">${n}</span><span class="tx">${esc(line.slice(1)) || " "}</span></div>`); o++; n++; }
    }
    close();
    return out.join("");
  }

  async function gitShowDiff(file, commit) {
    const box = $("git-body");
    const back = commit ? t("← 返回这次提交") : t("← 返回改动列表");
    box.innerHTML = `<div class="row-actions git-back"><button class="btn ghost sm" data-a="back">${back}</button>
      <button class="btn ghost sm" data-a="wrap">${t("换行")}</button>
      ${!commit && file ? `<button class="btn ghost sm" data-a="hist">${t("这个文件的历史")}</button>` : ""}
      ${!commit && file && GIT.status?.files.some((f) => f.path === file) ? `<button class="btn ghost sm" data-a="undo">${t("撤销")}</button>` : ""}</div>
      <div id="git-diff"><div class="tiny">${t("读取中…")}</div></div>`;
    box.querySelector(".git-back").onclick = async (e) => {
      const a = e.target.dataset.a; if (!a) return;
      if (a === "back") { GIT.view = commit ? { kind: "commit", commit } : null; if (!commit) GIT.file = ""; return gitRender(); }
      if (a === "wrap") { GIT.wrap = !GIT.wrap; box.querySelectorAll(".gdiff").forEach((d) => d.classList.toggle("nowrap", !GIT.wrap)); return; }
      if (a === "hist") { GIT.tab = "history"; GIT.view = null; return gitRender(); }
      if (a === "undo") {
        const f = GIT.status.files.find((x) => x.path === file);
        if (!confirm(f && f.kind === "new" ? t("{f} 是新文件，撤销就是删掉它。确定？", { f: file }) : t("把 {f} 改回上次提交时的样子？这个文件没提交的改动会丢掉。", { f: file }))) return;
        try { await gpost("discard", { file }); toast(t("已撤销")); GIT.view = null; GIT.file = ""; gitLoad(); } catch (e2) { toast(e2.message, true); }
      }
    };
    try {
      const r = await gapi("diff", { file: file || "", commit: commit || "" });
      $("git-diff").innerHTML = diffHtml(r.diff) + (r.truncated ? `<div class="tiny">${t("改动太多，只显示了前一部分")}</div>` : "");
    } catch (e) { $("git-diff").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; }
  }

  async function gitShowLog(file, append) {
    const box = $("git-body");
    if (!append) { GIT.log = []; box.innerHTML = `<div class="tiny">${t("读取中…")}</div>`; }
    let r;
    try { r = await gapi("log", { n: 50, skip: GIT.log.length, file: file || "" }); } catch (e) { box.innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    GIT.log = GIT.log.concat(r.commits || []);
    if (!GIT.log.length) { box.innerHTML = `<div class="vw-empty">${t("还没有提交记录。")}</div>`; return; }
    box.innerHTML = (file ? `<div class="row-actions git-back"><span class="tiny">${esc(t("只看 {f} 的历史", { f: file }))}</span>
        <button class="btn ghost sm" data-a="all">${t("看全部")}</button></div>` : "") +
      `<div class="git-log">${GIT.log.map((c, i) => `<div class="git-row" data-c="${i}">
        <span class="subj">${(c.refs ? c.refs.split(", ").map((x) => `<span class="git-ref">${esc(x.replace(/^HEAD -> /, ""))}</span>`).join("") : "")}${esc(c.subject)}</span>
        <span class="meta mono">${esc(c.short)} · ${esc(c.author)} · ${esc(relTime(c.at))}</span></div>`).join("")}</div>` +
      (r.more ? `<div class="row-actions"><button class="btn ghost sm" data-a="more">${t("加载更多")}</button></div>` : "");
    box.onclick = (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === "all") { GIT.file = ""; return gitShowLog(""); }
      if (a === "more") return gitShowLog(file, true);
      const row = e.target.closest("[data-c]");
      if (row) { GIT.view = { kind: "commit", commit: GIT.log[+row.dataset.c].hash }; gitRender(); }
    };
  }

  async function gitShowCommit(hash) {
    const box = $("git-body");
    box.onclick = null;
    box.innerHTML = `<div class="tiny">${t("读取中…")}</div>`;
    let c;
    try { c = await gapi("show", { commit: hash }); } catch (e) { box.innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    box.innerHTML = `<div class="row-actions git-back"><button class="btn ghost sm" data-a="back">${t("← 返回历史")}</button>
        <button class="btn ghost sm" data-a="all">${t("看整次提交的对比")}</button></div>
      <div class="prov-state"><b>${esc(c.message.split("\n")[0])}</b>${c.message.includes("\n") ? `<pre class="tiny" style="white-space:pre-wrap;margin:4px 0 0">${esc(c.message.split("\n").slice(1).join("\n").trim())}</pre>` : ""}
        <div class="tiny mono">${esc(c.hash.slice(0, 12))} · ${esc(c.author)} · ${esc(new Date(c.at).toLocaleString())}</div></div>
      ${c.files.map((f, i) => `<div class="git-row" data-f="${i}" style="cursor:pointer">
        <span class="gs gs-${{ M: "modified", A: "added", D: "deleted", R: "renamed" }[f.status] || "modified"}">${esc(f.status)}</span>
        <span class="gp">${gbdi(f.orig ? f.orig + " → " + f.path : f.path)}</span>${gnum(f)}</div>`).join("")}`;
    box.onclick = (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === "back") { GIT.view = null; return gitRender(); }
      if (a === "all") { GIT.file = ""; GIT.view = { kind: "diff", commit: hash }; return gitRender(); }
      const row = e.target.closest("[data-f]");
      if (row) { GIT.file = c.files[+row.dataset.f].path; GIT.view = { kind: "diff", commit: hash }; gitRender(); }
    };
  }

  /** 文件面板：给改过的文件标个色点（不是仓库就什么都不做） */
  let fsDots = null, fsDotsAt = 0;
  async function fsGitDots() {
    const dir = state.fs.path;
    let s;
    // 选中、过滤都会重画列表：同一目录 5 秒内复用上次的结果，别每点一下就跑一次 git status
    if (fsDots && fsDots.dir === dir && Date.now() - fsDotsAt < 5000) s = fsDots.s;
    else {
      try { s = await api(`/api/git/status?dir=${encodeURIComponent(dir)}`); } catch { return; }
      fsDots = { dir, s }; fsDotsAt = Date.now();
    }
    if (!s || s.notRepo || s.error || dir !== state.fs.path) return;
    const rel = dir.replace(/\/$/, "").replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0");
    const here = path => { const full = s.root + "/" + path; return full.startsWith(rel + "/") ? full.slice(rel.length + 1) : null; };
    const mark = new Map();
    for (const f of s.files) {
      const r = here(f.path); if (r == null) continue;
      const top = r.split("/")[0];
      if (!mark.has(top)) mark.set(top, r.includes("/") ? "modified" : f.kind);
    }
    $("fs-list").querySelectorAll(".fs-item").forEach((el) => {
      const e = fsVisible()[Number(el.dataset.i)];
      const k = e && mark.get(e.name);
      if (k && !el.querySelector(".fs-git-dot")) el.querySelector(".it-title").insertAdjacentHTML("afterend", `<span class="fs-git-dot ${k}" title="${esc(gsTitle(k))}"></span>`);
    });
  }

  const viewerEl = $("viewer");
  const VW = {
    path: "", kind: "", size: 0, mode: "", text: "", mtime: 0, dirty: false,
    pdf: null, pdfObs: null, zoom: 1, wrap: localStorage.getItem("cc.vw.wrap") !== "0",
  };
  const VW_EDIT_MAX = 2 * 1024 * 1024;
  const isMd = (p) => /\.(md|markdown|mdx)$/i.test(p);

  async function openViewer(path, kind, size) {
    if (VW.dirty && !confirm(t("有未保存的修改，丢弃？"))) return;
    closeViewerPdf();
    Object.assign(VW, { path, kind: kind || "other", size: size || 0, text: "", mtime: 0, dirty: false, zoom: 1, git: null });
    $("vw-name").textContent = path.split("/").pop();
    $("vw-name").title = path;
    $("vw-info").textContent = fmtSize(VW.size);
    viewerEl.classList.remove("hidden");
    if (VW.kind === "text") return vwLoadText(isMd(path) ? "md" : "edit");
    if (VW.kind === "image") return vwImage();
    if (VW.kind === "pdf") return vwPdf();
    if (VW.kind === "video" || VW.kind === "audio") {
      vwActs([]);
      const tag = VW.kind === "video" ? "video" : "audio";
      $("vw-body").innerHTML = `<div class="vw-media"><${tag} src="${fileUrl(path)}" controls autoplay></${tag}></div>`;
      return;
    }
    vwActs([]);
    $("vw-body").innerHTML = `<div class="vw-empty">
      <div>${t("这种文件没有内置预览。")}</div>
      ${VW.size <= VW_EDIT_MAX ? `<button class="btn ghost sm" data-a="astext">${t("当作文本打开")}</button>` : ""}
      <a class="btn ghost sm" href="${fileUrl(path, true)}" download>${t("下载")}</a></div>`;
    $("vw-body").querySelector('[data-a="astext"]')?.addEventListener("click", () => { VW.kind = "text"; vwLoadText("edit"); });
  }

  /** 顶栏右侧的按钮：[文字, 动作, 是否高亮] */
  function vwActs(list) {
    const base = [[t("插入 @路径"), "insert"], ["⤓", "download"]];
    $("vw-acts").innerHTML = list.concat(base).map(([l, a, on]) =>
      `<button class="btn ${on ? "" : "ghost"} sm" data-a="${a}">${esc(l)}</button>`).join("");
  }

  $("vw-acts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    if (a === "insert") {
      insertAtCursor("@" + VW.path);
      toast(t("已插入文件路径"));
      return closeViewer();
    }
    if (a === "download") { location.href = fileUrl(VW.path, true); return; }
    if (a === "save") return vwSave(false);
    if (a === "md") { VW.text = vwText(); return vwRenderText("md"); }
    if (a === "edit") return vwRenderText("edit");
    if (a === "gitdiff") return vwShowDiff();
    if (a === "githist") return openGit(VW.path, { file: VW.git.rel, tab: "history" });
    if (a === "wrap") {
      VW.wrap = !VW.wrap;
      localStorage.setItem("cc.vw.wrap", VW.wrap ? "1" : "0");
      $("vw-text")?.classList.toggle("nowrap", !VW.wrap);
      return vwRenderActs();
    }
    if (a === "zoom-" || a === "zoom+") {
      VW.zoom = Math.max(0.5, Math.min(4, VW.zoom * (a === "zoom+" ? 1.25 : 0.8)));
      return vwPdfRelayout();
    }
  });

  function vwText() { const ta = $("vw-text"); return ta ? ta.value : VW.text; }

  async function vwLoadText(mode) {
    if (VW.size > VW_EDIT_MAX) {
      vwActs([]);
      $("vw-body").innerHTML = `<div class="vw-empty"><div>${t("文件太大（{size}），只能下载查看。", { size: fmtSize(VW.size) })}</div></div>`;
      return;
    }
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    try {
      const r = await fetch(fileUrl(VW.path));
      if (!r.ok) throw new Error("HTTP " + r.status);
      VW.mtime = Number(r.headers.get("x-mtime")) || 0;
      VW.text = await r.text();
    } catch (e) {
      $("vw-body").innerHTML = `<div class="vw-empty">${t("读取失败")}: ${esc(e.message)}</div>`;
      return;
    }
    VW.dirty = false;
    vwRenderText(mode);
    vwGitCheck();
  }

  function vwRenderActs() {
    const acts = [];
    if (isMd(VW.path)) acts.push(VW.mode === "md" ? [t("编辑"), "edit"] : [t("预览"), "md"]);
    if (VW.mode === "edit") {
      acts.push([t("换行"), "wrap", VW.wrap]);
      acts.push([VW.dirty ? t("保存") + " •" : t("保存"), "save", VW.dirty]);
    }
    // 在 git 仓库里：改过就给「对比」（和上次提交比，红删绿增），随时可看这个文件的历史
    if (VW.git && VW.git.root) {
      if (VW.mode === "diff") acts.unshift([t("编辑"), "edit"]);
      else if (VW.git.kind) acts.push([t("对比"), "gitdiff"]);
      acts.push([t("历史"), "githist"]);
    }
    vwActs(acts);
  }

  /** 这个文件在不在 git 仓库里、改没改（编辑器顶栏显示「已修改 +3 −1」） */
  async function vwGitCheck() {
    const p = VW.path;
    VW.git = null;
    let s;
    try { s = await api("/api/git/status?dir=" + encodeURIComponent(p)); } catch { return; }
    if (p !== VW.path || !s || s.notRepo || s.error) return;
    const real = p.replace(/^\/sdcard(?=\/)/, "/storage/emulated/0");
    const rel = real.startsWith(s.root + "/") ? real.slice(s.root.length + 1) : null;
    if (rel == null) return;
    const f = s.files.find((x) => x.path === rel);
    VW.git = { root: s.root, rel, kind: f ? f.kind : "", add: f ? f.add : 0, del: f ? f.del : 0 };
    $("vw-info").textContent = fmtSize(VW.size) + (f ? " · " + gsTitle(f.kind) + (f.add != null ? ` +${f.add} −${f.del ?? 0}` : "") : " · " + t("和上次提交一样"));
    vwRenderActs();
  }

  async function vwShowDiff() {
    VW.text = vwText();
    VW.mode = "diff";
    vwRenderActs();
    $("vw-body").innerHTML = `<div class="vw-diff">${VW.dirty ? `<div class="tiny">${t("还有没保存的修改；这里对比的是磁盘上的版本和上次提交。")}</div>` : ""}<div class="tiny">${t("读取中…")}</div></div>`;
    try {
      const r = await api("/api/git/diff?" + new URLSearchParams({ dir: VW.path, file: VW.path }));
      if (VW.mode !== "diff") return;
      $("vw-body").querySelector(".vw-diff").innerHTML = (VW.dirty ? `<div class="tiny">${t("还有没保存的修改；这里对比的是磁盘上的版本和上次提交。")}</div>` : "") + diffHtml(r.diff);
    } catch (e) { $("vw-body").querySelector(".vw-diff").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; }
  }

  function vwRenderText(mode) {
    VW.mode = mode;
    if (mode === "md") {
      $("vw-body").innerHTML = `<div class="vw-md bubble">${renderMd(VW.text)}</div>`;
    } else {
      $("vw-body").innerHTML = `<textarea id="vw-text" class="mono ${VW.wrap ? "" : "nowrap"}" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>`;
      const ta = $("vw-text");
      ta.value = VW.text;
      ta.addEventListener("input", () => { if (!VW.dirty) { VW.dirty = true; vwRenderActs(); } });
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); vwSave(false); }
        else if (e.key === "Tab" && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand("insertText", false, "\t"); }
      });
    }
    vwRenderActs();
  }

  async function vwSave(force) {
    const text = vwText();
    let r;
    try {
      r = await fetch(`/api/file/save?path=${encodeURIComponent(VW.path)}&mtime=${VW.mtime}${force ? "&force=1" : ""}`, {
        method: "POST", body: text,
      });
    } catch (e) { return toast(t("保存失败：{msg}", { msg: e.message }), true); }
    if (r.status === 409) {
      if (confirm(t("文件在你打开之后被改过了（可能是 Claude 改的）。\n确定：用你的版本覆盖\n取消：放弃你的修改，重新载入"))) return vwSave(true);
      VW.dirty = false;
      return vwLoadText("edit");
    }
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) return toast(t("保存失败：{msg}", { msg: j.error || r.status }), true);
    VW.text = text; VW.mtime = j.mtime; VW.size = j.size; VW.dirty = false;
    $("vw-info").textContent = fmtSize(VW.size);
    vwRenderActs();
    toast(t("已保存"));
    vwGitCheck();                     // 存完改动行数变了
  }

  function vwImage() {
    vwActs([]);
    $("vw-body").innerHTML = `<div class="vw-img"><img src="${fileUrl(VW.path)}" alt=""></div>`;
    const box = $("vw-body").querySelector(".vw-img");
    const img = box.querySelector("img");
    img.addEventListener("load", () => { $("vw-info").textContent = `${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(VW.size)}`; });
    img.addEventListener("click", (e) => {
      // 放大时以点到的位置为中心
      const r = img.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      box.classList.toggle("zoom");
      if (box.classList.contains("zoom")) {
        box.scrollLeft = fx * img.naturalWidth - box.clientWidth / 2;
        box.scrollTop = fy * img.naturalHeight - box.clientHeight / 2;
      }
    });
  }

  let pdfjsP = null;
  function loadPdfjs() {
    if (!pdfjsP) {
      pdfjsP = import("/pdfjs/pdf.min.mjs").then((m) => {
        m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        return m;
      }).catch((e) => { pdfjsP = null; throw e; });
    }
    return pdfjsP;
  }

  async function vwPdf() {
    vwActs([["−", "zoom-"], ["+", "zoom+"]]);
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let lib, doc;
    try {
      lib = await loadPdfjs();
      const task = lib.getDocument({
        url: fileUrl(VW.path), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, wasmUrl: "/pdfjs/wasm/",
        isEvalSupported: false,
      });
      task.onPassword = (cb, reason) => {
        const pw = prompt(reason === 2 ? t("密码不对，再输一次：") : t("这个 PDF 有密码："));
        if (pw == null) task.destroy(); else cb(pw);
      };
      doc = await task.promise;
    } catch (e) {
      $("vw-body").innerHTML = `<div class="vw-empty">${t("PDF 打不开：{msg}", { msg: esc(e.message || String(e)) })}</div>`;
      return;
    }
    if (VW.kind !== "pdf" || viewerEl.classList.contains("hidden")) { doc.destroy(); return; }
    VW.pdf = doc;
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    VW.pdfRatio = vp.height / vp.width;
    $("vw-body").innerHTML = `<div class="vw-pdf"><div class="vw-pages"></div></div><div class="vw-pageno tiny"></div>`;
    const pages = $("vw-body").querySelector(".vw-pages");
    for (let i = 1; i <= doc.numPages; i++) {
      const h = document.createElement("div");
      h.className = "vw-page";
      h.dataset.n = i;
      pages.appendChild(h);
    }
    const scroller = $("vw-body").querySelector(".vw-pdf");
    VW.pdfObs = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (en.isIntersecting) vwPdfRender(en.target);
        else vwPdfRelease(en.target);
      }
    }, { root: scroller, rootMargin: "1200px 0px" });
    vwPdfRelayout();
    scroller.addEventListener("scroll", vwPdfPageNo, { passive: true });
    vwPdfPageNo();
  }

  function vwPdfRelayout() {
    const scroller = $("vw-body").querySelector(".vw-pdf");
    if (!scroller || !VW.pdf) return;
    const w = Math.floor((scroller.clientWidth - 16) * VW.zoom);
    scroller.classList.toggle("wide", VW.zoom > 1);
    const keep = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    for (const h of scroller.querySelectorAll(".vw-page")) {
      const ratio = Number(h.dataset.ratio) || VW.pdfRatio;
      h.style.width = w + "px";
      h.style.height = Math.round(w * ratio) + "px";
      vwPdfRelease(h);
      VW.pdfObs.unobserve(h);
      VW.pdfObs.observe(h);
    }
    scroller.scrollTop = keep * scroller.scrollHeight;
  }

  async function vwPdfRender(h) {
    if (h.dataset.state) return;
    h.dataset.state = "busy";
    const doc = VW.pdf;
    try {
      const page = await doc.getPage(Number(h.dataset.n));
      const v1 = page.getViewport({ scale: 1 });
      const ratio = v1.height / v1.width;
      if (Math.abs(ratio - (Number(h.dataset.ratio) || VW.pdfRatio)) > 0.001) {
        h.dataset.ratio = ratio;
        h.style.height = Math.round(h.clientWidth * ratio) + "px";
      }
      // 画布像素封顶：放大很多倍时别分配几百 MB 的画布
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let scale = (h.clientWidth / v1.width) * dpr;
      const maxPx = 16e6;
      if (v1.width * v1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (v1.width * v1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      h.replaceChildren(c);
      h._task = page.render({ canvasContext: c.getContext("2d"), viewport: vp });
      await h._task.promise;
      if (VW.pdf !== doc) return;
      h.dataset.state = "done";
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") h.dataset.state = "";
    }
  }

  function vwPdfRelease(h) {
    try { h._task?.cancel(); } catch {}
    h._task = null;
    const c = h.querySelector("canvas");
    if (c) { c.width = c.height = 0; c.remove(); }
    h.dataset.state = "";
  }

  function vwPdfPageNo() {
    const sc = $("vw-body").querySelector(".vw-pdf"), el = $("vw-body").querySelector(".vw-pageno");
    if (!sc || !el || !VW.pdf) return;
    const mid = sc.scrollTop + sc.clientHeight / 3;
    let n = 1;
    for (const h of sc.querySelectorAll(".vw-page")) { if (h.offsetTop <= mid) n = Number(h.dataset.n); else break; }
    el.textContent = `${n} / ${VW.pdf.numPages}`;
  }

  function closeViewerPdf() {
    VW.pdfObs?.disconnect(); VW.pdfObs = null;
    if (VW.pdf) { try { VW.pdf.destroy(); } catch {} VW.pdf = null; }
  }

  function closeViewer() {
    if (VW.dirty && !confirm(t("有未保存的修改，丢弃？"))) return;
    VW.dirty = false;
    closeViewerPdf();
    $("vw-body").innerHTML = "";
    viewerEl.classList.add("hidden");
    // 文件面板开着就刷新一下：大小 / 修改时间可能变了
    if (!filesEl.classList.contains("hidden") && state.fs.path) fsLoad(state.fs.path, { keepSel: true });
  }
  $("vw-close").addEventListener("click", closeViewer);
  window.addEventListener("resize", () => { if (VW.pdf) { clearTimeout(VW.rt); VW.rt = setTimeout(vwPdfRelayout, 200); } });

  // ── 应用内终端 ────────────────────────────────────────────────────
  // xterm.js 按需加载（近 500 KB，不开终端就不付这个钱）；每个终端一个 xterm 实例，
  // 输出走 /api/term/<id>/stream（SSE，先回放缓冲），按键攒一小撮再按顺序 POST。
  // 手机键盘没有 Esc / Ctrl / 方向键：底下一排补上，Ctrl / Alt 是「粘住」的，作用于下一个键。
  const termEl = $("term");
  const TERM = {
    list: [], cur: null, inst: new Map(), loaded: null, ctrl: false, alt: false,
    font: Number(localStorage.getItem("cc.term.font")) || 13,
  };

  function loadXterm() {
    if (TERM.loaded) return TERM.loaded;
    const add = (tag, attrs) => new Promise((ok, bad) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.onload = ok;
      el.onerror = () => bad(new Error(attrs.src || attrs.href));
      document.head.appendChild(el);
    });
    TERM.loaded = add("link", { rel: "stylesheet", href: "/xterm.css" })
      .then(() => add("script", { src: "/xterm.js" }))
      .then(() => add("script", { src: "/xterm-addon-fit.js" }))
      .catch((e) => { TERM.loaded = null; throw e; });
    return TERM.loaded;
  }

  function termTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k) => cs.getPropertyValue(k).trim();
    const light = document.documentElement.dataset.theme === "light";
    const base = {
      background: v("--code-bg") || (light ? "#fff" : "#000"), foreground: v("--fg"),
      cursor: v("--accent"), cursorAccent: v("--code-bg"),
      selectionBackground: light ? "rgba(201,100,66,.25)" : "rgba(217,119,87,.35)",
    };
    // 浅色底上 xterm 默认的黄 / 亮白几乎看不见，换一套深一点的
    return light ? Object.assign(base, {
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00", blue: "#0550ae",
      magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
      brightBlue: "#0969da", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    }) : base;
  }

  async function openTerm() {
    termEl.classList.remove("hidden");
    try { await loadXterm(); } catch (e) { toast(t("终端组件加载失败：{msg}", { msg: e.message }), true); return; }
    let r;
    try { r = await api("/api/term/list"); } catch (e) { toast(t("终端打不开：{msg}", { msg: e.message }), true); return; }
    if (!r.available) { toast(t("找不到伪终端程序（ptyhost / python3）"), true); return; }
    const srv = r.terms || [];
    // 本界面开着、网关却不认识了（网关重启过）：标成已退出，留着看最后的输出
    for (const x of TERM.list) if (TERM.inst.has(x.id) && !srv.some((y) => y.id === x.id)) srv.push(Object.assign(x, { alive: false }));
    // 已退出的：本界面开过的留着，别处留下的不显示
    TERM.list = srv.filter((x) => x.alive || TERM.inst.has(x.id));
    const live = TERM.list.filter((x) => x.alive);
    if (!live.length) return newTerm();
    if (!TERM.list.some((x) => x.id === TERM.cur)) TERM.cur = live[live.length - 1].id;
    renderTermTabs();
    showTerm(TERM.cur);
  }

  function closeTerm() {
    termEl.classList.add("hidden");
    TERM.inst.get(TERM.cur)?.xt.blur();
  }

  /** 手动登录：开一个新终端，网关替你敲好 claude auth login；授权码贴给 claude 自己的提示 */
  async function openLoginTerm(method) {
    termEl.classList.remove("hidden");
    try { await loadXterm(); } catch (e) { toast(t("终端组件加载失败：{msg}", { msg: e.message }), true); return; }
    try { const r = await api("/api/term/list"); TERM.list = (r.terms || []).filter((x) => x.alive || TERM.inst.has(x.id)); } catch {}
    await newTerm({ login: method === "console" ? "console" : true });
  }

  async function newTerm(opts = {}) {
    const box = $("term-screens");
    // 先用一个探针算出这块地方能放几行几列，开出来就是对的大小，免得 shell 先按 80x24 画一遍
    let cols = 80, rows = 24;
    if (TERM.inst.size) { const a = TERM.inst.get(TERM.cur); if (a) { cols = a.xt.cols; rows = a.xt.rows; } }
    else if (box.clientWidth) {
      cols = Math.max(20, Math.floor((box.clientWidth - 8) / (TERM.font * 0.6)));
      rows = Math.max(5, Math.floor((box.clientHeight - 4) / (TERM.font * 1.2)));
    }
    let r;
    try { r = await api("/api/term/new", { method: "POST", body: JSON.stringify({ cols, rows, ...(opts.login ? { login: opts.login } : {}) }) }); }
    catch (e) { toast(t("新建终端失败：{msg}", { msg: e.message }), true); return; }
    TERM.list.push(r.term);
    TERM.cur = r.term.id;
    renderTermTabs();
    showTerm(r.term.id);
  }

  function renderTermTabs() {
    $("term-tabs").innerHTML = TERM.list.map((x) => `
      <span class="term-tab ${x.id === TERM.cur ? "cur" : ""} ${x.alive === false ? "dead" : ""}" data-id="${x.id}">
        <span class="tt-name">${esc(x.title)}</span><span class="tt-x" data-x="1" aria-label="${esc(t("关闭"))}">×</span>
      </span>`).join("");
    $("term-tabs").querySelectorAll(".term-tab").forEach((el) => el.addEventListener("click", (e) => {
      const id = el.dataset.id;
      if (e.target.dataset.x) return killTerm(id);
      TERM.cur = id; renderTermTabs(); showTerm(id);
    }));
  }

  async function killTerm(id) {
    const x = TERM.list.find((y) => y.id === id);
    if (x && x.alive !== false && !confirm(t("关闭这个终端？里面正在跑的程序会被结束。"))) return;
    try { await api(`/api/term/${id}/kill`, { method: "POST", body: "{}" }); } catch {}
    const a = TERM.inst.get(id);
    if (a) { try { a.es?.close(); } catch {} a.ro?.disconnect(); a.xt.dispose(); a.el.remove(); TERM.inst.delete(id); }
    TERM.list = TERM.list.filter((y) => y.id !== id);
    if (TERM.cur === id) TERM.cur = TERM.list.length ? TERM.list[TERM.list.length - 1].id : null;
    renderTermTabs();
    if (TERM.cur) showTerm(TERM.cur); else closeTerm();
  }

  function showTerm(id) {
    for (const [k, a] of TERM.inst) a.el.classList.toggle("hidden", k !== id);
    let a = TERM.inst.get(id);
    if (!a) a = mountTerm(id);
    requestAnimationFrame(() => { termFit(a); a.xt.focus(); });
  }

  function mountTerm(id) {
    const el = document.createElement("div");
    el.className = "term-screen";
    $("term-screens").appendChild(el);
    const xt = new window.Terminal({
      fontSize: TERM.font, fontFamily: "'CC Mono', ui-monospace, 'Droid Sans Mono', 'Noto Sans Mono CJK SC', monospace",
      theme: termTheme(), scrollback: 5000, cursorBlink: true, allowProposedApi: false,
      macOptionIsMeta: true, convertEol: false,
      // claude 打的 OSC 8 超链接（登录授权页等）：交给系统浏览器，别在 WebView 里开
      linkHandler: { activate: (e, uri) => openExternal(uri), allowNonHttpProtocols: false },
    });
    const fit = new window.FitAddon.FitAddon();
    xt.loadAddon(fit);
    xt.open(el);
    const a = { id, el, xt, fit, es: null, ro: null, q: "", sending: Promise.resolve(), timer: 0, cols: 0, rows: 0 };
    TERM.inst.set(id, a);

    xt.onData((d) => termSend(a, termMods(d)));
    // 终端里的网址点一下就用系统浏览器打开（登录授权页那种长地址会折成好几行，按折行拼回来再找）
    xt.registerLinkProvider({
      provideLinks(y, cb) {
        const buf = xt.buffer.active;
        let top = y - 1;
        while (top > 0 && buf.getLine(top)?.isWrapped) top--;
        let text = "", rows = [];
        for (let i = top; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (!ln || (i > top && !ln.isWrapped)) break;
          const s = ln.translateToString(false).padEnd(xt.cols).slice(0, xt.cols);
          rows.push(i); text += s;
        }
        const out = [];
        for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
          const at = (k) => ({ x: (k % xt.cols) + 1, y: rows[Math.floor(k / xt.cols)] + 1 });
          const st = at(m.index), en = at(m.index + m[0].length - 1);
          if (y < st.y || y > en.y) continue;
          const url = m[0];
          out.push({ range: { start: st, end: en }, text: url, activate: () => openExternal(url) });
        }
        cb(out.length ? out : undefined);
      },
    });
    xt.onTitleChange((s) => {
      const x = TERM.list.find((y) => y.id === id);
      if (x && s) { x.title = s.slice(0, 40); renderTermTabs(); }
    });
    a.ro = new ResizeObserver(() => termFit(a));
    a.ro.observe(el);

    const es = new EventSource(`/api/term/${id}/stream`);
    a.es = es;
    es.addEventListener("replay", (m) => { xt.reset(); try { xt.write(JSON.parse(m.data)); } catch {} });
    es.addEventListener("o", (m) => { try { xt.write(JSON.parse(m.data)); } catch {} });
    es.addEventListener("exit", (m) => {
      let code = null; try { code = JSON.parse(m.data).code; } catch {}
      es.close();
      xt.write("\r\n\x1b[2m" + t("[进程已退出，代码 {code}]", { code }) + "\x1b[0m\r\n");
      const x = TERM.list.find((y) => y.id === id);
      if (x) { x.alive = false; x.code = code; renderTermTabs(); }
    });
    // 网关重启后这个终端就没了：别让 EventSource 无限重连
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      xt.write("\r\n\x1b[2m" + t("[与网关的连接已断开]") + "\x1b[0m\r\n");
    };
    return a;
  }

  /** 粘住的 Ctrl / Alt 作用到下一次输入（软键盘打出来的字、底排的键都算） */
  function termMods(d) {
    if (!TERM.ctrl && !TERM.alt) return d;
    if (TERM.ctrl && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
      else if (d === " ") d = "\x00";
      else if (d === "?") d = "\x7f";
    }
    if (TERM.alt) d = "\x1b" + d;
    TERM.ctrl = TERM.alt = false;
    renderTermKeys();
    return d;
  }

  function termSend(a, d) {
    a.q += d;
    if (a.timer) return;
    a.timer = setTimeout(() => {
      const body = a.q;
      a.q = ""; a.timer = 0;
      // 串起来发，保证顺序（并发的 fetch 不保证先到先处理）
      a.sending = a.sending.then(() => fetch(`/api/term/${a.id}/in`, { method: "POST", body }).catch(() => {}));
    }, 6);
  }

  function termFit(a) {
    if (!a || a.el.classList.contains("hidden") || !a.el.clientWidth) return;
    try { a.fit.fit(); } catch { return; }
    if (a.xt.cols === a.cols && a.xt.rows === a.rows) return;
    a.cols = a.xt.cols; a.rows = a.xt.rows;
    clearTimeout(a.rt);
    a.rt = setTimeout(() => api(`/api/term/${a.id}/resize`, {
      method: "POST", body: JSON.stringify({ cols: a.cols, rows: a.rows }),
    }).catch(() => {}), 120);
  }

  const TERM_KEYS = [
    ["Esc", "\x1b"], ["Tab", "\t"], ["⌫", "\x7f"], ["Del", "\x1b[3~"], ["Ctrl", "ctrl"], ["Alt", "alt"],
    ["←", "\x1b[D"], ["↓", "\x1b[B"], ["↑", "\x1b[A"], ["→", "\x1b[C"],
    ["Home", "\x1b[H"], ["End", "\x1b[F"], ["PgUp", "\x1b[5~"], ["PgDn", "\x1b[6~"],
    ["|", "|"], ["~", "~"], ["/", "/"], ["-", "-"],
    ["📋", "paste"], ["A−", "font-"], ["A+", "font+"],
  ];

  function renderTermKeys() {
    $("term-keys").innerHTML = TERM_KEYS.map(([l, k], i) =>
      `<button class="tk ${(k === "ctrl" && TERM.ctrl) || (k === "alt" && TERM.alt) ? "on" : ""}" data-i="${i}">${esc(l)}</button>`).join("");
  }

  // 长按连发：退格、删除、方向键按住不放就一直发（先等 400ms，之后每 60ms 一下）
  const TK_REPEAT = new Set(["\x7f", "\x1b[3~", "\x1b[D", "\x1b[B", "\x1b[A", "\x1b[C"]);
  let tkHold = null;
  const tkStop = () => { if (tkHold) { clearTimeout(tkHold.t); clearInterval(tkHold.iv); } };
  $("term-keys").addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".tk");
    if (!b) return;
    e.preventDefault();   // 别抢走焦点，否则软键盘会收起
    tkStop();
    if (!TK_REPEAT.has(TERM_KEYS[Number(b.dataset.i)][1])) { tkHold = null; return; }
    const h = tkHold = { fired: false, iv: 0 };
    h.t = setTimeout(() => { h.fired = true; h.iv = setInterval(() => b.click(), 60); b.click(); }, 400);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) $("term-keys").addEventListener(ev, tkStop);
  // 按住不放约半秒，WebView 会当成长按弹菜单，随即 pointercancel 把连发掐断：补键行上不要长按菜单
  $("term-keys").addEventListener("contextmenu", (e) => e.preventDefault());
  // 有的输入法（实测联想平板自带的）在键盘上沿往上还占着一窄条看不见的触摸区（约 22px），
  // 盖住补键行中间几个键的下半截，点了没反应。键盘弹起时给补键行底下垫一点，把按钮整个抬过去。
  // 判断键盘：同一宽度下窗口高度比见过的最大高度矮了两成以上
  let tkW = 0, tkH = 0;
  const tkKb = () => {
    if (innerWidth !== tkW) { tkW = innerWidth; tkH = 0; }
    tkH = Math.max(tkH, innerHeight);
    $("term-keys").classList.toggle("kb-open", innerHeight < tkH * 0.8);
  };
  addEventListener("resize", tkKb);
  tkKb();
  $("term-keys").addEventListener("click", async (e) => {
    const b = e.target.closest(".tk");
    if (!b) return;
    // 连发过的那次松手，系统还会补一个 click，吞掉它
    if (e.isTrusted && tkHold && tkHold.fired) { tkHold = null; return; }
    const k = TERM_KEYS[Number(b.dataset.i)][1];
    const a = TERM.inst.get(TERM.cur);
    if (k === "ctrl") { TERM.ctrl = !TERM.ctrl; return renderTermKeys(); }
    if (k === "alt") { TERM.alt = !TERM.alt; return renderTermKeys(); }
    if (k === "font-" || k === "font+") {
      TERM.font = Math.max(8, Math.min(28, TERM.font + (k === "font+" ? 1 : -1)));
      localStorage.setItem("cc.term.font", TERM.font);
      for (const x of TERM.inst.values()) { x.xt.options.fontSize = TERM.font; termFit(x); }
      return;
    }
    if (!a) return;
    if (k === "paste") {
      let s = "";
      try { s = await navigator.clipboard.readText(); } catch {}
      if (!s) s = prompt(t("粘贴到终端：")) || "";
      if (s) a.xt.paste(s);
      return a.xt.focus();
    }
    // 方向键在应用光标模式（vim、less…）下要换成 ESC O x
    let d = k;
    if (a.xt.modes.applicationCursorKeysMode && /^\x1b\[[ABCDHF]$/.test(d)) d = "\x1bO" + d[2];
    termSend(a, termMods(d));
  });

  // 文本视图：xterm 在触屏上选不了字，把缓冲区摊成普通文本，用系统的长按选择
  $("term-text").addEventListener("click", () => {
    const a = TERM.inst.get(TERM.cur);
    if (!a) return;
    const b = a.xt.buffer.active, lines = [];
    for (let i = Math.max(0, b.length - 3000); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    $("term-text-pre").textContent = lines.join("\n");
    $("term-textview").classList.remove("hidden");
    const pre = $("term-text-pre");
    pre.scrollTop = pre.scrollHeight;
  });
  $("term-text-copy").addEventListener("click", () => {
    const sel = String(getSelection() || "");
    navigator.clipboard?.writeText(sel || $("term-text-pre").textContent);
    toast(sel ? t("已复制选中内容") : t("已复制全部"));
  });
  $("term-text-close").addEventListener("click", () => $("term-textview").classList.add("hidden"));

  $("term-close").addEventListener("click", closeTerm);
  $("term-new").addEventListener("click", newTerm);
  $("btn-term").addEventListener("click", openTerm);
  renderTermKeys();
  // 换主题时跟着换
  new MutationObserver(() => { for (const a of TERM.inst.values()) a.xt.options.theme = termTheme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ── 回到最新：往上翻得远了，右下角出一个 ↓ 圆钮；翻着的时候有新内容进来，钮上亮个点 ──
  const toBottomEl = document.createElement("button");
  toBottomEl.id = "btn-bottom";
  toBottomEl.className = "hidden";
  toBottomEl.setAttribute("aria-label", t("回到最新"));
  toBottomEl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  $("composer").appendChild(toBottomEl);
  let bottomH = 0, bottomRaf = 0;
  function syncBottomBtn() {
    bottomRaf = 0;
    const away = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight > 320;
    toBottomEl.classList.toggle("hidden", !away);
    if (!away) toBottomEl.classList.remove("new");
    else if (chatEl.scrollHeight > bottomH + 4 && bottomH) toBottomEl.classList.add("new");
    bottomH = chatEl.scrollHeight;
  }
  const queueBottomSync = () => { if (!bottomRaf) bottomRaf = requestAnimationFrame(syncBottomBtn); };
  chatScrollHooks.push(syncBottomBtn);
  // 内容长高才需要重算（以前盯整棵子树的每个字符变化，计时器每秒跳一下也触发）
  const bottomRO = new ResizeObserver(queueBottomSync);
  bottomRO.observe(histEl); bottomRO.observe(liveEl);
  toBottomEl.addEventListener("click", () => {
    toBottomEl.classList.remove("new");
    chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: "smooth" });
  });

  $("btn-files").addEventListener("click", () => openFiles());
  $("btn-palette").addEventListener("click", () => { openCmdPalette(""); inputEl.focus(); });
  $("btn-close-drawer").addEventListener("click", () => { if (window.CCLayout && CCLayout.docked()) CCLayout.collapse(); closeDrawer(true); });
  drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) closeDrawer(); });
  $("btn-refresh-sessions").addEventListener("click", () => { loadSessions(); toast(t("已刷新")); });
  $("btn-close-session").addEventListener("click", () => {
    closeDrawer();
    newConversation(t("已断开，下一条消息开新会话"));
  });

  $("btn-new").addEventListener("click", () => {
    newConversation();
    toast(t("已开始新会话"));
  });

  // ＋ 快捷面板
  const sheetEl = $("sheet");
  $("btn-plus").addEventListener("click", () => sheetEl.classList.remove("hidden"));
  sheetEl.addEventListener("click", (e) => {
    if (e.target === sheetEl) { sheetEl.classList.add("hidden"); return; }
    const it = e.target.closest(".sheet-item");
    if (!it) return;
    sheetEl.classList.add("hidden");
    const a = it.dataset.act;
    if (a === "new") return $("btn-new").click();
    if (a === "caps") return openDrawer("caps");
    if (a === "attach") return pickFiles();
    if (a === "browse") return openFiles();
    send("/" + a);
  });

  // ── 状态 ──────────────────────────────────────────────────────────
  let uiTag = null;              // 网关报的前端版本戳，变了就说明有新界面
  async function refreshStatus() {
    try {
      const s = await api("/api/status");
      if (uiTag != null && s.uiTag && s.uiTag !== uiTag) {
        // v3 起生成不归页面管，随时刷新都安全
        setStatus(t("界面已更新，正在刷新…"), "warn");
        location.reload();
        return;
      }
      if (s.uiTag) uiTag = s.uiTag;
      if (s.product) { const t = document.getElementById("app-title"); if (t && t.textContent !== s.product) { t.textContent = s.product; document.title = s.product; } }
      state.serverStatus = s;
      paintSafeMode(s.safeMode);
      // 日志分享靠安卓壳（cccodroid）打包、弹分享面板；旧版应用没有
      $("btn-share-logs").classList.toggle("hidden", s.product !== "cccodroid");
      $("share-logs-hint").classList.toggle("hidden", s.product !== "cccodroid");
      $("btn-ledger").classList.toggle("hidden", !s.hasLedger);
      modelEl.textContent = s.model || "—";
      state.model = s.model;
      $("status-box").textContent =
                `${t("网关")}     ${s.version} (pid ${s.pid})\n` +
        `${t("运行时")}   ${s.ready ? t("就绪") : t("缺失")}\n` +
        `${t("厂商")}     ${s.providerLabel || s.provider}\n` +
        `${t("上游")}     ${s.upstream}\n` +
        `${t("凭据")}     ${s.keyMode === "login" ? t("官方登录态") : (s.hasKey ? t("已配置密钥") : t("未配置"))}\n` +
        `${t("DNS 桥")}   ${s.bridge ? t("已连接") : t("未启动")}\n` +
        `${t("模型")}     ${s.model || t("(由 claude 决定)")}\n` +
        `${t("生成")}     ${s.busy ? t("进行中") : t("空闲")}${s.queued ? t(" · 排队 {n} 条", { n: s.queued }) : ""}\n` +
        `${t("工作区")}   ${s.workspace}`;
      if (!s.busy) {
        setStatus(s.ready && s.hasKey ? (srv.connected ? t("就绪") : t("已连接网关")) : s.hasKey ? t("运行时缺失") : t("需要配置密钥"),
          s.ready && s.hasKey ? "ok" : "warn");
      }
    } catch (e) {
      $("status-box").textContent = t("无法连接网关：{msg}", { msg: e.message });
      setStatus(t("网关离线"), "err");
    }
  }

  // 调试口：外部测试壳用它读状态，不参与任何逻辑
  // 触摸诊断（常驻、只读）：最近 100 条触摸 / 指针取消 / 滚动事件，排查"偶发上下滑不动、按钮照常能点"用。
  // 冻住时经 WebView 调试读 window.__touchLog —— 这个 bug 没法预约复现，临时埋点等不到现场。
  (() => {
    const L = (window.__touchLog = []), T0 = performance.now();
    const who = (t) => (t && (t.id || (typeof t.className === "string" && t.className.split(" ")[0]) || t.tagName)) || "?";
    const add = (s) => { L.push(Math.round(performance.now() - T0) + " " + s); if (L.length > 100) L.shift(); };
    for (const ty of ["touchstart", "touchend", "touchcancel", "pointercancel"])
      document.addEventListener(ty, (e) => add(ty + " " + who(e.target) + (e.touches ? " n=" + e.touches.length : "")), { capture: true, passive: true });
    let last = 0;
    document.addEventListener("scroll", (e) => { const n = performance.now(); if (n - last > 300) { last = n; add("scroll " + who(e.target)); } }, { capture: true, passive: true });
    document.addEventListener("visibilitychange", () => add("visibility " + document.visibilityState));

    // 2026-10-16：以前这里有个"拖了不滚就接管"的兜底（还会把 overflow 关了再开去「踢」滚动容器），已去掉，滚动完全交给系统。
    // 去掉后触摸滚动仍会整个冻住：页面照常收到 touchmove，WebView 就是不出滚动；同站重载不好，跨站跳一次再回来才好，
    // 说明卡在 WebView 给这个文档的手势状态上，不在页面代码里。上面的 __touchLog 只被动记录，留着抓触发现场。
  })();

  // ── 滚动冻结脱困（自动 + 顶栏雪花按钮）──────────────────────────────
  //  冻住时页面救不了自己：跨站跳转会被壳当外链拦掉，只能请壳（CCApp.unfreeze）跳一次 127.0.0.2:9 再回来。
  //  会话 id 本来就在 localStorage；输入框草稿先放 sessionStorage，回来再填上。
  //  每次脱困都在 localStorage["cc.freezeLog"] 留最近 5 次现场（含触摸日志尾巴），以后找触发条件用。
  (() => {
    const FZ_LOG = "cc.freezeLog", FZ_AT = "cc.unfrozeAt", FZ_DRAFT = "cc.draft";
    try {
      const d = sessionStorage.getItem(FZ_DRAFT);
      sessionStorage.removeItem(FZ_DRAFT);
      if (d && !inputEl.value) { inputEl.value = d; inputEl.dispatchEvent(new Event("input")); }
    } catch {}
    function unfreeze(why) {
      try {
        const log = JSON.parse(localStorage.getItem(FZ_LOG) || "[]");
        log.push({ at: new Date().toISOString(), why, touch: (window.__touchLog || []).slice(-40) });
        localStorage.setItem(FZ_LOG, JSON.stringify(log.slice(-5)));
        if (inputEl.value) sessionStorage.setItem(FZ_DRAFT, inputEl.value);
        sessionStorage.setItem(FZ_AT, String(Date.now()));
      } catch {}
      if (window.CCApp && window.CCApp.unfreeze) { toast(t("正在重新挂载界面…")); window.CCApp.unfreeze(); }
      else toast(t("这个版本的应用还不能脱困，请更新应用；临时办法是重启网关"), true);
    }
    $("btn-unfreeze").addEventListener("click", () => unfreeze("manual"));
    window.__ccUnfreeze = unfreeze;

    // 自动判定：单指竖向拖了 60px 以上、手指下的滚动容器明明还能往那个方向滚，
    // 松手 350ms 后 scrollTop 却没往那个方向动过 —— 连续两次（20 秒内）就算冻住。
    // 只看「朝手指方向的位移」：生成时贴底的程序滚动是往下的，不会把一次往上翻的失败盖掉。
    const scroller = (el) => {
      for (; el && el !== document.body; el = el.parentElement)
        if (el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
      return null;
    };
    let g = null, sus = 0, susAt = 0;
    document.addEventListener("touchstart", (e) => {
      g = null;
      if (e.touches.length !== 1 || e.target.closest("textarea,input,.xterm")) return;
      const el = scroller(e.target);
      if (el) g = { el, x: e.touches[0].clientX, y: e.touches[0].clientY, top: el.scrollTop, lo: el.scrollTop, hi: el.scrollTop, t: performance.now(), prevented: false };
    }, { capture: true, passive: true });
    document.addEventListener("touchmove", (e) => { if (g && e.defaultPrevented) g.prevented = true; }, { passive: true });
    document.addEventListener("touchcancel", () => { g = null; }, { capture: true, passive: true });
    document.addEventListener("scroll", (e) => {
      if (g && e.target === g.el) { const v = g.el.scrollTop; if (v < g.lo) g.lo = v; if (v > g.hi) g.hi = v; }
    }, { capture: true, passive: true });
    document.addEventListener("touchend", (e) => {
      const s = g; g = null;
      if (!s || e.touches.length || s.prevented) return;
      const p = e.changedTouches[0], dx = p.clientX - s.x, dy = p.clientY - s.y;
      if (Math.abs(dy) < 60 || Math.abs(dy) < 2 * Math.abs(dx) || performance.now() - s.t > 2000) return;
      const max = s.el.scrollHeight - s.el.clientHeight;
      if (dy > 0 ? s.top < 4 : s.top > max - 4) return;          // 已经到头了，本来就滚不动
      if (String(getSelection() || "").length) return;            // 在拖选文字
      setTimeout(() => {
        if (!s.el.isConnected) return;
        const v = s.el.scrollTop, moved = dy > 0 ? Math.min(s.lo, v) < s.top - 8 : Math.max(s.hi, v) > s.top + 8;
        if (moved) { sus = 0; return; }
        const now = Date.now();
        sus = now - susAt < 20000 ? sus + 1 : 1; susAt = now;
        (window.__touchLog || []).push("freeze? " + sus);
        if (sus < 2) return;
        sus = 0;
        const last = Number(sessionStorage.getItem(FZ_AT)) || 0;
        if (now - last < 60000) toast(t("滚动好像卡住了，可以点顶栏的雪花按钮脱困"), true);   // 刚自动救过一次，别来回跳
        else unfreeze("auto");
      }, 350);
    }, { capture: true, passive: true });
  })();

  // 返回键 / 侧滑返回：壳先问这里，从最上层往下关一层浮层，关了就返回 true；什么都没开才由壳把界面退到后台。
  // 顺序按 z-index 从高到低（灯箱 90 > 终端文本 73 > 终端 72 > 查看器 71 > 文件 70 > 补全弹窗 60 > 底部菜单 55 > 侧栏 50）
  window.__ccBack = () => {
    const open = (id) => !$(id).classList.contains("hidden");
    const steps = [
      ["lightbox", () => $("lightbox").classList.add("hidden")],
      ["term-textview", () => $("term-textview").classList.add("hidden")],
      ["browser", closeBrowser],
      ["term", closeTerm],
      ["git", closeGit],
      ["viewer", closeViewer],          // 有未保存修改会先问；选了不丢弃也算处理过，别把界面退到后台
      ["files", closeFiles],
      ["popup", hidePopup],
      ["sheet", () => $("sheet").classList.add("hidden")],
      ["drawer", closeDrawer],
    ];
    // 宽屏：文件 / 查看器 / 终端并排停在右边，先关最近打开的那个，而不是按 z-index；常驻的侧栏不算浮层
    const L = window.CCLayout;
    const recent = L ? L.openPanes() : [];
    if (recent.length) {
      const order = recent.slice().reverse();
      const panes = steps.filter(([id]) => order.includes(id)).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
      const at = steps.findIndex(([id]) => order.includes(id));
      steps.splice(0, steps.length, ...steps.slice(0, at).filter(([id]) => !order.includes(id)), ...panes, ...steps.slice(at).filter(([id]) => !order.includes(id)));
    }
    for (const [id, close] of steps) {
      if (id === "drawer" && L && L.docked()) continue;
      if (open(id)) { close(); return true; }
    }
    return false;
  };
  if (window.CCLayout) CCLayout.init({ openDrawer: () => openDrawer(), closeDrawer });
  window.__cc = { view, srv, state, send, abort, openSession, newConversation,
    openGit, openViewer, openFiles, openDrawer, provCard: (id) => { state.provView = id; renderProvCard(); } };

  // ── 启动 ──────────────────────────────────────────────────────────
  (async function boot() {
    view.sessionId = loadUiState();      // 上次的会话号与用量，先捞回来
    updateCtx(state.ctxUsed, state.ctxTotal);
    setStatus(t("正在连接网关…"));

    await refreshStatus();
    // 本地不知道用哪条，就问网关「最近真正跑过哪条会话」—— 总比默默开个新会话强
    if (!view.sessionId && state.serverStatus?.lastSessionId) {
      view.sessionId = state.serverStatus.lastSessionId;
      saveUiState();
    }
    connectBus(false);                   // hello 到了就会去取历史 / 接上正在跑的那一轮

    await Promise.all([loadSettings(), loadCaps(), loadSessions()]);
    updateCtx(state.ctxUsed, state.ctxTotal);   // 别把恢复回来的用量抹成 0
    setInterval(refreshStatus, 45000);
  })();
})();
