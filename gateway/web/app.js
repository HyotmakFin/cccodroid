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
  const isZh = () => /^zh/.test((window.I18N && I18N.lang) || "zh");
  const I18N = window.I18N || { lang: "zh", t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s) };
  const t = I18N.t;
  const tk = (s) => s;   // 词条键：表格里先登记（扫描器认它），显示时再 t(变量)

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
  // 项目 / 定时任务的状态（模块在 openPage 前；这两个要在启动早期就可用）
  var PJ = { list: [], colors: [], ws: "", cur: null, detail: null, loaded: false, effLevels: [] };
  var SC = { data: null, cur: null, detail: null, flt: "all", rflt: "all" };
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
  // 带一个按钮的提示条（撤销之类），多停几秒
  function toastAct(msg, label, fn) {
    toastEl.textContent = msg + " ";
    const b = document.createElement("button");
    b.className = "toast-act"; b.textContent = label;
    b.onclick = () => { toastEl.classList.add("hidden"); fn(); };
    toastEl.appendChild(b);
    toastEl.className = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 7000);
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

  function setStatus(text, cls) { chatStatus = [text, cls || ""]; if (!curPage) { subEl.textContent = text; subEl.className = cls || ""; } }

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
      let j = null;
      try { j = await r.json(); msg = j.message || j.error || msg; } catch {}
      const e = new Error(msg); e.status = r.status; e.body = j; throw e;
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
      // 图片：只有调用方给了解析函数（查看器预览按文件所在目录解析相对路径）才渲染；聊天里不认
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, u) =>
        mdImg ? hold(`<img class="md-img" src="${esc(mdImg(u.replace(/&amp;/g, "&")))}" alt="${alt}" loading="lazy">`) : all)
      .replace(/`([^`\n]+)`/g, (_, c) => {
        const m = c.match(/^((?:\/storage|\/sdcard|\/data|\/mnt)(?:\/[^\s:]+)+\/?)(:\d+(?::\d+)?)?$/);
        return hold(m ? `<code>${pathLink(m[1], m[2], c)}</code>` : `<code>${c}</code>`);
      })
      .replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (_, l, p) => hold(pathLink(p.replace(/:\d+(?::\d+)?$/, ""), "", l)))
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, l, u) => hold(`<a class="weblink" href="${u}" target="_blank" rel="noopener">${l}</a>`))
      // 裸网址也能点（本机开发服务 http://127.0.0.1:端口 最常见）；句末标点不算
      .replace(/https?:\/\/[^\s<>"'`）)】」，。；、\u0000]+/g, (u) => {
        // 结尾的 * 也不算：**http://…** 这种加粗包着的网址，不然 ** 会进链接、点开 404
        const tail = (u.match(/[.,;:!?*]+$/) || [""])[0];
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

  /** 支持标题/列表/表格/代码块/引用/分隔线；img(url) → 图片地址，给了才渲染 ![](…) */
  let mdImg = null;
  function renderMd(text, img) {
    const prev = mdImg; mdImg = img || null;
    try { return renderMdLines(text); } finally { mdImg = prev; }
  }
  function renderMdLines(text) {
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
    goal: null,          // 本会话的 /goal 状态（网关从会话记录里推出来的，见 goalStateOf）
    goalHide: 0,         // 点 ✕ 收起的那条达成 / 失败记录的时间戳
    tasks: null,         // 本会话的任务清单（TaskCreate / TaskUpdate，网关读 ~/.claude/tasks 推过来）
    tasksHide: "",       // 全部完成后点 ✕ 收起时的清单指纹；清单一变就重新露出来
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
    fork: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-7 4-11.2 8.6"/>',
    rewind: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
    del: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  };
  const UI_I = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    list: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10l2 2 4-4M8 16h8"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
    pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    ring: '<circle cx="12" cy="12" r="6.5"/>',
    half: '<circle cx="12" cy="12" r="6.5"/><path d="M12 5.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    clip: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h4"/>',
  };
  const uiI = (n, cls) => `<svg class="ui-i${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${UI_I[n]}</svg>`;
  const userTextOf = new WeakMap();   // 用户气泡 → 原文（分叉时拿它在 transcript 里认出是哪一轮）
  const actBtn = (a, label) => `<button data-a="${a}" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24">${ICONS[a]}</svg></button>`;
  // 发送时附件以「@路径」接在末尾（claude 靠它读文件）。气泡里不露这串前缀：末尾那段纯 @路径 拆出来，
  // 图片画成缩略图、别的文件画成小卡片；复制 / 重发仍用原文
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i;
  function splitRefs(text) {
    const m = /@\/\S+(?:\s+@\/\S+)*\s*$/.exec(text || "");
    if (!m) return [text, []];
    return [text.slice(0, m.index).trimEnd(), m[0].trim().split(/\s+/).map((r) => r.slice(1))];
  }
  function refsHtml(refs) {
    const FILE = '<svg class="ui-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    return `<div class="u-refs">${refs.map((p) => IMG_RE.test(p)
      ? `<button class="u-ref img" data-p="${esc(p)}"><img src="${fileUrl(p)}" alt="" loading="lazy"></button>`
      : `<button class="u-ref" data-p="${esc(p)}">${FILE}<span>${esc(p.split("/").pop())}</span></button>`).join("")}</div>`;
  }
  function renderUser(text, parent) {
    const b = mkMsg("user", null, parent);
    userTextOf.set(b.parentElement, text);
    const [body, refs] = splitRefs(text);
    setHtml(b, body ? renderMd(body) : "");
    if (refs.length) {
      b.insertAdjacentHTML("beforebegin", refsHtml(refs));
      if (!body) b.classList.add("hidden");
      b.parentElement.querySelector(".u-refs").addEventListener("click", (e) => {
        const r = e.target.closest(".u-ref"); if (!r) return;
        r.classList.contains("img") ? openLightbox(r.dataset.p) : openPath(r.dataset.p);
      });
    }
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = actBtn("copy", t("复制")) + actBtn("resend", t("重发")) + actBtn("rewind", t("回退到这里")) + actBtn("del", t("删除"));
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "copy") { navigator.clipboard?.writeText(text); toast(t("已复制")); }
      if (a === "resend") { inputEl.value = text; autoGrow(); inputEl.focus(); }
      if (a === "rewind") rewindTo(b.parentElement);
      if (a === "del") deleteMsg(b.parentElement, "user");
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
      append(t) { thinking += t; if (!done) el.classList.add("live"); tick(); },
      set(t) { thinking = t; done = true; el.classList.remove("live"); label.textContent = fmtChars(thinking.length); },
      finish() {
        if (timer) { clearTimeout(timer); timer = 0; }
        done = true;
        el.classList.remove("live");
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
    // 子代理（Agent / 旧名 Task）：卡片下面挂一块「子代理过程」，它的每一步是嵌套的工具卡，默认收起
    const isAgent = name === "Agent" || name === "Task";
    let sub = null;
    const subArea = () => {
      if (sub) return sub;
      const box = document.createElement("div");
      box.className = "tool-sub";
      box.innerHTML = `<button class="ts-head" type="button"><span class="chev">▶</span><span class="ts-label"></span><span class="tool-arg ts-now"></span></button><div class="ts-list"></div>`;
      card.insertBefore(box, bodyEl);
      sub = { box, list: box.lastChild, label: box.querySelector(".ts-label"), now: box.querySelector(".ts-now"), n: 0, textEl: null, lazy: null };
      box.firstChild.addEventListener("click", (e) => {
        e.stopPropagation();
        box.classList.toggle("open");
        if (box.classList.contains("open") && sub.lazy) { const f = sub.lazy; sub.lazy = null; f(); }
      });
      subLabel();
      return sub;
    };
    const subLabel = () => { sub.label.textContent = t("子代理过程") + (sub.n ? " · " + t("{n} 个步骤", { n: sub.n }) : ""); };
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
        // 后台子代理：工具结果只是「已启动」，真正跑完靠 sub_done
        if (isAgent && ok && /^Async agent launched/.test(result.text) && !(sub && sub.done)) { st.className = "tool-state run"; st.textContent = t("后台运行"); }
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
      isAgent,
      // 子代理的一步：嵌套工具卡（注册进 TOOL_CARDS，结果和权限卡照常按 id 找到它）
      sub(sid, sname, sinput) {
        const s = subArea();
        s.n++; subLabel();
        const b = ToolBlock(s.list, sid, sname, sinput, live);
        s.now.textContent = sname + (b.summary ? " " + b.summary : "");
        if (s.textEl) s.list.appendChild(s.textEl);       // 汇报总在最后
        return b;
      },
      // 新版 claude 跑得久的普通命令（Bash 等）也会发 task_progress / task_notification，
      // id 是那张工具卡自己的：只有子代理卡才有「过程」可放，别的卡只更新状态，不挂空的「子代理过程」
      subText(text) {
        if (!isAgent) return;
        const s = subArea();
        if (!s.textEl) { s.textEl = document.createElement("div"); s.textEl.className = "ts-text md"; }
        s.list.appendChild(s.textEl);
        setHtml(s.textEl, renderMd(String(text || "")));
      },
      subProgress(desc) { if (desc && isAgent) subArea().now.textContent = desc; },
      subDone(status) {
        const ok = status === "completed";
        if (!isAgent) {
          if (result && result.ok === ok) return;          // 工具结果已经说清楚了
          if (!result && ok) return;                        // 结果马上就到，交给 result()
        } else {
          const s = subArea();
          s.done = true; s.now.textContent = "";
        }
        st.className = "tool-state " + (ok ? "ok" : "err");
        st.textContent = ok ? t("完成") : status === "failed" ? t("失败") : t("已停止");
      },
      // 历史里的子代理：点开「过程」时才去取
      subLazy(load) {
        const s = subArea();
        s.lazy = async () => {
          s.now.textContent = t("加载中…");
          try {
            const items = await load();
            for (const m of items) {
              if (m.role === "tool_use") api.sub(m.id, m.name, m.input);
              else if (m.role === "tool_result") toolResult(m.id, m.ok, m.text);
              else if (m.role === "assistant") api.subText(m.text);
            }
            s.now.textContent = items.length ? "" : t("没有记录");
          } catch (e) { s.now.textContent = e.message; s.lazy = null; }
        };
      },
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
    permEl.innerHTML = (m === "bypassPermissions" ? '<svg class="ei" viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/></svg>' : "") + esc(modeLabel(m));
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
      <div class="perm-head"><span class="perm-kind">${uiI("pause")}${kind}</span><span class="perm-tool">${esc(p.tool)}</span>${p.agentId ? `<span class="perm-sub">${t("子代理")}</span>` : ""}</div>
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
  // ── 输入框上方的状态带：/goal 目标进度 + 后台任务 ──
  const runStrip = $("run-strip");
  let goalTick = null;
  const BG_KIND = (k) => /agent/i.test(k) ? t("子代理") : /workflow/i.test(k) ? t("工作流") : /monitor/i.test(k) ? t("监视") : /bash|shell/i.test(k) ? t("命令") : k || "?";
  // 任务清单：折叠时一行（进度 + 正在做的那项），点开看全部；全部完成可 ✕ 收起
  let tasksOpen = localStorage.getItem("cc.tasksOpen") === "1";
  const tasksSig = (l) => l.map((x) => x.id + ":" + x.status).join(",");
  const taskLabel = (x) => esc(x.status === "in_progress" && x.active ? x.active : x.subject);
  function tasksHtml() {
    const l = view.tasks;
    if (!l || !l.length) return "";
    const done = l.filter((x) => x.status === "completed").length, all = done === l.length;
    if (all && view.tasksHide === tasksSig(l)) return "";
    const cur = l.find((x) => x.status === "in_progress") || l.find((x) => x.status !== "completed");
    const pct = Math.round(done / l.length * 100);
    const head = `<div class="rs-row rs-thead" role="button" tabindex="0" aria-expanded="${tasksOpen}">
      <span class="rs-ico">${uiI(all ? "check" : "list")}</span>
      <span class="rs-tcount">${all ? t("清单完成") : t("清单")} ${done}/${l.length}</span>
      <span class="rs-tbar"><i style="width:${pct}%"></i></span>
      <span class="rs-txt">${!tasksOpen && cur ? taskLabel(cur) : ""}</span>
      ${all ? `<button class="rs-tx" aria-label="${t("关闭")}">${uiI("x")}</button>` : `<span class="rs-chev${tasksOpen ? " up" : ""}">${uiI("chevDown")}</span>`}</div>`;
    const rows = !tasksOpen ? "" : `<div class="rs-tlist">${l.map((x) => `<div class="rs-trow ${esc(x.status)}">
      <span class="rs-tico">${uiI(x.status === "completed" ? "check" : x.status === "in_progress" ? "half" : "ring")}</span>
      <span class="rs-ttxt">${taskLabel(x)}</span>
      ${x.blocked && x.status !== "completed" ? `<span class="rs-meta">${t("等 {ids}", { ids: x.blocked.map((b) => "#" + esc(b)).join(" ") })}</span>` : ""}</div>`).join("")}</div>`;
    return `<div class="rs-tasks${all ? " ok" : ""}">${head}${rows}</div>`;
  }
  function renderRunStrip() {
    const g = view.goal && !(view.goal.done && view.goal.at <= view.goalHide) ? view.goal : null;
    const bg = (srv.run && srv.run.bgList) || [];
    let html = tasksHtml();
    if (g && g.active) {
      const el = g.setAt ? fmtDur(Date.now() - g.setAt) : "";
      html += `<div class="rs-goal"><div class="rs-row"><span class="rs-ico">${uiI("target")}</span>
        <span class="rs-txt">${t("目标")} · ${esc(g.condition)}</span>
        <span class="rs-meta">${[g.checks ? t("已检查 {n} 次", { n: g.checks }) : "", el ? t("已用 {d}", { d: el }) : ""].filter(Boolean).join(" · ")}</span>
        <button class="rs-goal-stop">${t("放弃")}</button></div>
        ${g.reason ? `<div class="rs-sub">${t("还差：")}${esc(g.reason)}</div>` : ""}</div>`;
    } else if (g && g.done) {
      const bits = [g.iterations != null ? t("{n} 轮", { n: g.iterations }) : "", g.durationMs != null ? fmtDur(g.durationMs) : "", g.tokens != null ? g.tokens.toLocaleString() + " tokens" : ""].filter(Boolean).join(" · ");
      html += `<div class="rs-goal ${g.met ? "ok" : "bad"}"><div class="rs-row"><span class="rs-ico">${uiI(g.met ? "check" : "x")}</span>
        <span class="rs-txt">${g.met ? t("目标达成") : t("目标无法达成")} · ${esc(g.condition)}</span>
        <span class="rs-meta">${g.met ? bits : ""}</span><button class="rs-x" aria-label="${t("关闭")}">${uiI("x")}</button></div>
        ${!g.met && g.reason ? `<div class="rs-sub">${esc(g.reason)}</div>` : ""}</div>`;
    }
    if (bg.length) {
      const rows = bg.slice(0, 4).map((x) => `<div class="rs-row rs-bg"><span class="rs-kind">${esc(BG_KIND(x.type))}</span>
        <span class="rs-txt">${esc(x.desc || x.id)}</span><button class="rs-stop" data-task="${esc(x.id)}">${t("停止")}</button></div>`).join("");
      html += `<div class="rs-bgs"><div class="rs-head">${uiI("hourglass")}${t("后台在跑 {n} 个", { n: bg.length })}${bg.length > 4 ? " · " + t("还有 {n} 个", { n: bg.length - 4 }) : ""}</div>${rows}</div>`;
    }
    runStrip.innerHTML = html;
    runStrip.classList.toggle("hidden", !html);
    // 目标进行中：每秒刷新「已用」；别的情况停掉
    if (g && g.active && g.setAt) { if (!goalTick) goalTick = setInterval(renderRunStrip, 1000); }
    else if (goalTick) { clearInterval(goalTick); goalTick = null; }
  }
  // 点 ✕ 收起的清单 / 目标记录按会话记在 localStorage，重开 App 不再冒出来（只留最近 50 个会话）
  function stripHidden() { try { return JSON.parse(localStorage.getItem("cc.stripHide") || "{}"); } catch { return {}; } }
  function saveStripHidden() {
    if (!view.sessionId) return;
    const m = stripHidden();
    delete m[view.sessionId];
    m[view.sessionId] = { t: view.tasksHide, g: view.goalHide };
    const ks = Object.keys(m);
    for (const k of ks.slice(0, Math.max(0, ks.length - 50))) delete m[k];
    try { localStorage.setItem("cc.stripHide", JSON.stringify(m)); } catch {}
  }
  runStrip.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && b.classList.contains("rs-tx")) { view.tasksHide = tasksSig(view.tasks || []); saveStripHidden(); renderRunStrip(); return; }
    if (!b && e.target.closest(".rs-thead")) { tasksOpen = !tasksOpen; localStorage.setItem("cc.tasksOpen", tasksOpen ? "1" : "0"); renderRunStrip(); return; }
    if (!b) return;
    if (b.classList.contains("rs-x")) { view.goalHide = view.goal?.at || Date.now(); saveStripHidden(); renderRunStrip(); return; }
    if (b.classList.contains("rs-goal-stop")) {
      // 目标进行中那一轮会一直跑下去，排队的 /goal clear 轮不到：先停这一轮，收尾后再发（见 onRunEnd）
      if (srv.run && !srv.run.idle && isBusy()) {
        view.goalClearAfter = srv.run.id;
        b.disabled = true;
        api("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: srv.run.id }) }).catch(() => {});
      } else send("/goal clear");
      return;
    }
    if (b.classList.contains("rs-stop") && srv.run) {
      b.disabled = true;
      api("/api/task/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: srv.run.id, taskId: b.dataset.task }) })
        .catch((err) => { b.disabled = false; toast(err.message, true); });
    }
  });

  function renderPermBar() {
    const list = pendingPerms();
    permBar.classList.toggle("hidden", !list.length && !state.settings.permNotice);
    if (!list.length) {
      permBar.innerHTML = state.settings.permNotice ? `
        <div class="pb-note"><span>${t("权限模式已改为「逐项确认」，与官方一致：改文件、跑命令前会先问你。想恢复全部放行，点下方的权限标签。")}</span>
        <button class="pb-x" aria-label="${t("关闭")}">${uiI("x")}</button></div>` : "";
      if (permWaiting && isBusy()) setStatus(t("生成中…"), "live");
      permWaiting = false;
      return;
    }
    const f = list[0].p, simple = (it) => it.p.tool !== "ExitPlanMode" && it.p.tool !== "AskUserQuestion";
    const what = f.tool === "Bash" ? f.input.command : (f.input.file_path || f.input.url || f.input.query || "");
    permBar.innerHTML = `
      <div class="pb-main">
        ${list.length > 1 ? `<span class="pb-n">${t("第 {i}/{n} 个", { i: 1, n: list.length })}</span>` : ""}
        <span class="pb-txt">${uiI("pause")}${f.tool === "ExitPlanMode" ? t("计划待批准") : f.tool === "AskUserQuestion" ? t("Claude 想问你") : t("Claude 在等你确认") + " · "}${simple(list[0]) ? `<b>${esc(f.tool)}</b> <span class="mono">${esc(String(what || "").slice(0, 80))}</span>` : ""}</span>
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
  // 转发走外壳的系统分享面板（CCApp.shareText）；外壳没有这个接口时退回 Web Share，都没有就复制并说明。
  // 提问和回复底下一律四个键（提问：复制 / 重发 / 回退 / 删除；回复：复制 / 转发 / 分叉 / 删除），别因为环境不同少一个
  function replyActs(msgEl, getText) {
    if (!getText() || msgEl.querySelector(":scope > .msg-acts")) return;
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = actBtn("copy", t("复制")) + actBtn("share", t("转发")) +
      (msgEl.classList.contains("sys") ? "" : actBtn("fork", t("从这里分叉")) + actBtn("del", t("删除")));
    acts.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a, text = getText();
      if (a === "copy") { navigator.clipboard?.writeText(text); toast(t("已复制")); }
      if (a === "share") {
        if (window.CCApp && CCApp.shareText) CCApp.shareText(text);
        else if (navigator.share) navigator.share({ text }).catch(() => {});
        else { navigator.clipboard?.writeText(text); toast(t("这里没有系统分享，已复制到剪贴板")); }
      }
      if (a === "fork") forkFrom(msgEl);
      if (a === "del") deleteMsg(msgEl, "bot");
    });
    msgEl.appendChild(acts);
  }

  // 删一条消息：提问只删这一条；回复删整条（连同它的工具调用和结果）。改的是会话记录本身，Claude 下一轮就看不到了。
  // 删完直接从界面上拿掉（不重载，滚动位置不跳）；提示条上能撤销最近一次
  async function deleteMsg(msgEl, which) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再删"), true);
    if (isBusy()) return toast(t("正在生成，等它答完再删"), true);
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    let turn = which === "user" ? msgEl : null;
    if (!turn) for (const u of users) if (u.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) turn = u;
    const after = users.length - 1 - users.indexOf(turn);
    if (!turn) return toast(t("这条回复前面没有你的消息，没法单独删"), true);
    if (!confirm(which === "user" ? t("删掉这条提问？Claude 之后就看不到它了（它的回复保留）。") : t("删掉这条回复？连同它的工具调用和结果一起删，Claude 之后就看不到了。"))) return;
    try {
      const r = await api("/api/session/" + encodeURIComponent(sid) + "/delmsg", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: userTextOf.get(turn), after, which }),
      });
      if (which === "user") { userTextOf.delete(msgEl); msgEl.remove(); } else msgEl.remove();
      toastAct(t("已删除"), t("撤销"), async () => {
        try {
          await api("/api/session/" + encodeURIComponent(sid) + "/undodel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ undo: r.undo }) });
          if (view.sessionId === sid) openSession(sid);
          toast(t("已恢复"));
        } catch (e) { toast(e.message, true); }
      });
    } catch (e) { toast(e.message, true); }
  }

  // 分叉：保留到这条回复为止的对话，另起一个会话接着聊；原会话不动。
  // 告诉网关这一轮的用户消息原文、以及它后面还有几条用户消息，网关据此在 transcript 里定位（见 server.mjs forkSession）
  async function forkFrom(msgEl) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再分叉"), true);
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    let prev = null, after = 0;
    for (const u of users) {
      if (u.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) prev = u; else after++;
    }
    if (!prev) return toast(t("这条回复前面没有你的消息，没法从这里分叉"), true);
    try {
      const r = await api("/api/session/" + encodeURIComponent(sid) + "/fork", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: userTextOf.get(prev), after }),
      });
      openSession(r.id);
      loadSessions();
      toast(t("已分叉：保留了前 {n} 轮，接着聊就行", { n: r.kept }));
    } catch (e) { toast(e.message, true); }
  }

  // 回退到某条用户消息之前：先试算会撤销哪些文件，再选「只撤代码」或「代码 + 对话」。
  // 对话那半边和分叉一样另起一个会话（截到这条之前，原文放回输入框），原会话不动
  async function rewindTo(msgEl) {
    const sid = view.sessionId;
    if (!sid) return toast(t("这个会话还没存下来，答完一轮再回退"), true);
    if (isBusy()) return toast(t("正在生成，等它答完再回退"), true);
    const users = [...chatEl.querySelectorAll(".msg.user")].filter((u) => userTextOf.has(u));
    const idx = users.indexOf(msgEl);
    if (idx < 0) return;
    const userText = userTextOf.get(msgEl), after = users.length - 1 - idx;
    const post = (extra) => api("/api/session/" + encodeURIComponent(sid) + "/rewind", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userText, after, ...extra }),
    });
    toast(t("正在查这之后改过哪些文件…"));
    let d;
    try { d = await post({ dryRun: true }); } catch (e) { return toast(e.message, true); }
    const choice = await rewindDialog(d);
    if (!choice) return;
    try {
      const r = await post({ conversation: choice === "both" });
      const n = r.files && r.files.canRewind && r.files.files ? r.files.files.length : 0;
      if (choice === "both") {
        if (r.fork && r.fork.fresh) newConversation(); else { openSession(r.fork.id); loadSessions(); }
        setTimeout(() => { inputEl.value = userText; autoGrow(); inputEl.focus(); }, 300);
        toast(n ? t("已撤销 {n} 个文件的修改，对话回到了这条消息之前", { n }) : t("对话回到了这条消息之前，原会话还在"));
      } else toast(t("已撤销 {n} 个文件的修改", { n }));
    } catch (e) { toast(e.message, true); }
  }
  function rewindDialog(d) {
    return new Promise((resolve) => {
      const files = d.canRewind && d.files ? d.files : [];
      const ov = document.createElement("div");
      ov.className = "rw-ov";
      const list = files.slice(0, 8).map((f) => `<li title="${esc(f)}"><span class="mono">${esc(f.split("/").pop())}</span> <span class="rw-dir">${esc(f.replace(/\/[^/]*$/, ""))}</span></li>`).join("") +
        (files.length > 8 ? `<li>${esc(t("还有 {n} 个", { n: files.length - 8 }))}</li>` : "");
      const what = files.length
        ? `<p>${esc(t("会撤销 Claude 在这之后对 {n} 个文件的修改", { n: files.length }))} <span class="rw-stat">+${d.insertions || 0} −${d.deletions || 0}</span></p><ul class="rw-files">${list}</ul>`
        : `<p>${esc(d.canRewind ? t("这之后 Claude 没有用编辑工具改过文件。") : t("这之后的文件改动没有留底（这个版本之前的消息不支持），只能回退对话。"))}</p>`;
      ov.innerHTML = `<div class="rw-dlg" role="dialog" aria-modal="true">
        <h3>${esc(t("回退到这条消息之前"))}</h3>${what}
        <p class="rw-note">${esc(t("只撤销编辑工具（Edit / Write）做的修改；用命令改的文件、装的包不会还原。"))}</p>
        <div class="rw-acts">
          <button data-c="both" class="primary">${esc(files.length ? t("撤销代码，并回到这里重新提问") : t("回到这里重新提问"))}</button>
          ${files.length ? `<button data-c="code">${esc(t("只撤销代码"))}</button>` : ""}
          <button data-c="">${esc(t("取消"))}</button>
        </div>
        <p class="rw-note">${esc(t("回到这里会另开一个会话，原会话保留。"))}</p></div>`;
      const close = (c) => { ov.remove(); resolve(c || null); };
      ov.addEventListener("click", (e) => {
        if (e.target === ov) return close(null);
        const b = e.target.closest("button[data-c]");
        if (b) close(b.dataset.c);
      });
      document.body.appendChild(ov);
    });
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
    // 进行到哪一步：三个点后面（还没出任何内容时）或末尾光标旁边的一行小字。
    // 连接中 / 已连上等待输出 / 重试 / 思考中 / 正在写工具参数；正文开始、工具开跑、答完就收起
    let ph = null, phEv = null, phT0 = 0, phIv = 0;
    const pendTools = new Set();
    const phText = () => {
      const ms = Date.now() - phT0, sec = ms >= 3000 ? " · " + fmtDur(ms) : "";
      switch (phEv.phase) {
        case "connect": return t("连接中") + sec;
        case "wait":    return t("已连上，等待输出") + sec;
        case "retry":   return t("连接出错，第 {a}/{m} 次重试", { a: phEv.attempt || 1, m: phEv.max || "?" });
        case "think":   return t("思考中") + sec;
        case "tool":    return t("正在写 {name} 的参数", { name: phEv.name || "?" }) + (phEv.chars ? " · " + fmtChars(phEv.chars) : "");
      }
      return "";
    };
    const phPaint = () => {
      if (!ph || !phEv) return;
      ph.textContent = phText();
      const slow = (phEv.phase === "connect" || phEv.phase === "wait") && Date.now() - phT0 > 30000;
      ph.classList.toggle("slow", slow);
      ph.classList.toggle("bad", phEv.phase === "retry");
    };
    const phPlace = () => {
      if (!ph) return;
      if (dots) { if (ph.previousSibling !== dots) dots.after(ph); }
      else if (liveTail && ph.parentNode !== liveTail) liveTail.insertBefore(ph, tailTime);
    };
    const phClear = () => { if (phIv) { clearInterval(phIv); phIv = 0; } ph?.remove(); ph = null; phEv = null; };
    const setPhase = (ev) => {
      if (!live || ended) return;
      const k = ev && ev.phase;
      if (!k || k === "text") return phClear();
      if (!phEv || phEv.phase !== k || k === "retry" || (k === "tool" && phEv.name !== ev.name)) phT0 = Date.now();
      phEv = ev;
      if (!ph) { ph = document.createElement("span"); ph.className = "run-phase"; }
      ph.title = k === "retry" ? [ev.status, ev.error].filter(Boolean).join(" · ") : "";
      phPlace(); phPaint();
      if (!phIv) phIv = setInterval(phPaint, 1000);
    };
    const keepTail = () => { if (liveTail && !ended) { bubble.appendChild(liveTail); phPlace(); } };
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
      phase: setPhase,
      /** 工具结果回来：这一批工具都有结果了，下一步就是再请求模型 */
      toolDone(id) { if (pendTools.delete(id) && !pendTools.size) setPhase({ phase: "connect" }); },
      delta(t) { textB().append(t); },
      text(t) { push(TextBlock(bubble, live)).set(t); },
      thinkDelta(t) { thinkB().append(t); },
      thinking(t) { (inGroup() ? groupThink() : push(ThinkBlock(bubble))).set(t); },
      tool(id, name, input) {
        if (live) { pendTools.add(id); phClear(); }     // 工具卡出来了，参数写完，接下来是工具在跑
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
      // 同一个 key 的提示原地更新（加载模型、读提示的进度），不一条条往下堆
      noteK(k, t) {
        const ex = [...bubble.querySelectorAll(".run-note[data-k]")].find((n) => n.dataset.k === k);
        if (ex) { ex.textContent = t; return; }
        undot(); last = null;
        bubble.insertAdjacentHTML("beforeend", `<p class="run-note" data-k="${esc(k)}">${esc(t)}</p>`); keepTail();
      },
      finish(aborted) {
        if (ended) return;
        phClear();
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
      stop(at) {          // at：真正结束的时刻（重放时事件比现在早）
        if (!iv) return;
        clearInterval(iv); iv = 0;
        el.classList.remove("live"); el.hidden = false;
        el.textContent = t("用时 {d}", { d: fmtDur((at || Date.now()) - t0, true) });
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
      else if (m.role === "tool_use") {
        av.tool(m.id, m.name, m.input);
        const c = m.sub && view.sessionId && TOOL_CARDS.get(m.id), sid = view.sessionId;
        if (c && c.isAgent) c.subLazy(async () => (await api(`/api/session/${encodeURIComponent(sid)}/agent?tool=${encodeURIComponent(m.id)}`)).items || []);
      }
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
    view.projectId = null;
    view.title = "";
    paintTitle();
    view.goal = null;
    const hid = stripHidden()[view.sessionId] || {};
    view.goalHide = hid.g || 0;
    view.tasks = null;
    view.tasksHide = hid.t || "";
    renderRunStrip();
    histEl.innerHTML = "";
    liveEl.innerHTML = "";
    for (const rv of runViews.values()) rv.timer?.stop();
    runViews.clear();
    TOOL_CARDS.clear();
    PENDING_RESULTS.clear();
    olderEl.classList.add("hidden");
    statEl.textContent = "";
    pickViewRun();                     // 换了会话：「本会话在不在跑」要重新算
    paintProjChip();
    syncInterject();
    saveUiState();
  }

  /** 打开某个会话（null = 新会话）。重连事件流：网关会把正在跑的那一轮从头重放过来 */
  function openSession(id, jumpQ) {
    closePage();
    resetView(id);
    view.jumpQ = id && jumpQ ? jumpQ : "";   // 从搜索结果点进来：历史加载完后跳到命中的那条
    view.jumpPages = 0;
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
    if (initial && "goal" in r) { view.goal = r.goal || null; renderRunStrip(); }
    if (initial && "tasks" in r) { view.tasks = r.tasks || null; renderRunStrip(); }
    const page = renderItems(r.items || []);
    if (initial) {
      histEl.innerHTML = "";
      histEl.appendChild(page);
      if (r.contextTokens != null) updateCtx(r.contextTokens, state.ctxTotal);
      paintTitle();
      setStatus(t("就绪"), "ok");
      scrollDown(true);
    } else {
      const h0 = chatEl.scrollHeight, t0 = chatEl.scrollTop;
      histEl.insertBefore(page, histEl.firstChild);
      chatEl.scrollTop = t0 + (chatEl.scrollHeight - h0);   // 往上补内容，视线别跳
    }
    olderEl.textContent = t("加载更早的消息");
    olderEl.classList.toggle("hidden", !r.cursor);
    if (view.jumpQ) jumpToHit();
  }

  // 在已渲染的消息里从新往旧找搜索词；没找到就继续往前翻，最多翻 30 页
  function jumpToHit() {
    const q = view.jumpQ.toLowerCase(), norm = (x) => x.replace(/\s+/g, " ").toLowerCase();
    const bubbles = [...histEl.querySelectorAll(".msg .bubble")].reverse();
    const hit = bubbles.find((b) => norm(b.textContent).includes(q));
    if (!hit) {
      if (view.cursor && view.jumpPages++ < 30) { setTimeout(() => loadOlder(false)); return; }
      view.jumpQ = "";
      toast(t("没在加载的消息里找到「{q}」", { q }), true);
      return;
    }
    view.jumpQ = "";
    const tw = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n; (n = tw.nextNode());) if (n.nodeValue.toLowerCase().includes(q)) nodes.push(n);
    for (const n of nodes) {
      const i = n.nodeValue.toLowerCase().indexOf(q);
      const m = document.createElement("mark");
      m.className = "jump-hit";
      const r = n.splitText(i); r.splitText(q.length);
      r.parentNode.replaceChild(m, r); m.appendChild(r);
    }
    const msg = hit.closest(".msg");
    msg.classList.add("hit-flash");
    setTimeout(() => msg.classList.remove("hit-flash"), 2400);
    (hit.querySelector("mark.jump-hit") || msg).scrollIntoView({ block: "center" });
  }
  olderEl.addEventListener("click", () => loadOlder(false));
  chatScrollHooks.push(() => {
    if (chatEl.scrollTop < 240 && view.cursor && !view.loading && histEl.childElementCount) loadOlder(false);
  });

  // ── 新会话首屏（照网页版的布局）：问候语居中，输入框紧跟在下面，示例和使用提示在输入框下方；
  //    输入框下面那行左边是项目、右边是型号与权限。发出第一条（或会话里出现任何别的东西）就退回平常的布局。
  //    html.wel 只看 #hist / #live 的直接子节点，流式输出不会触发
  // 标识：应用图标抠出来的线稿（mark.png 只当遮罩用），颜色跟主题走
  const WL_MARK = '<span class="wl-mark" aria-hidden="true"></span>';
  // 问候语看此刻的处境说话：几点、星期几、电量；同一时段有几句，每次随手挑一句
  let wlBat = null;
  try { navigator.getBattery && navigator.getBattery().then((b) => { wlBat = b; }).catch(() => {}); } catch {}
  function greeting() {
    const d = new Date(), h = d.getHours(), wd = d.getDay(), pool = [];
    if (wlBat && !wlBat.charging && wlBat.level <= 0.2) pool.push(t("电量见底了，挑件快的先做"));
    else if (wlBat && wlBat.charging && (h >= 22 || h < 6)) pool.push(t("插着电呢，大活可以放心跑"));
    if (h >= 0 && h < 5) pool.push(t("夜深了，屏幕还亮着"), t("这个点还在折腾，必有好点子"));
    else if (h < 8) pool.push(t("起得真早，先做点轻松的"));
    else if (h < 11) pool.push(wd === 1 ? t("周一，从一件小事开始") : t("上午好，口袋里的工作台已就绪"), t("趁脑子清楚，啃块硬骨头？"));
    else if (h < 14) pool.push(t("午休也闲不住？"), t("吃过饭了吗？顺手做点什么"));
    else if (h < 18) pool.push(t("下午好，接着上回的思路？"), t("泡杯茶，慢慢来"));
    else if (h < 21) pool.push(wd === 5 ? t("周五傍晚，做点好玩的") : t("傍晚了，收个尾还是开新坑？"));
    else pool.push(t("晚上好，适合慢慢写点东西"), t("夜里安静，想到什么就说"));
    if ((wd === 0 || wd === 6) && h >= 8 && h < 22) pool.push(t("周末，做点自己想做的"));
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function showWelcome() {
    const b = mkMsg("bot", null, histEl);
    b.parentElement.classList.add("welcome");
    b.innerHTML = `<div class="wl-hero">${WL_MARK}<h1 class="wl-greet">${esc(greeting())}</h1></div><div class="setup-guide hidden"></div>`;
    fillSetupGuide(b.querySelector(".setup-guide"));
    paintWelBelow();
  }
  // 输入框下方：三个示例（点一下只填进输入框，不直接发）+ 使用提示（进帮助页）
  const wlBelow = document.createElement("div");
  wlBelow.id = "wl-below";
  $("composer").after(wlBelow);
  function paintWelBelow() {
    const examples = [
      t("看看这台设备上装了哪些开发工具，挑三个各演示一下"),
      t("用 Python 统计工作区里各类文件的数量和总大小，整理成表格"),
      t("写一个单文件的贪吃蛇网页小游戏，做好后在浏览器里打开给我看"),
    ];
    wlBelow.innerHTML = `<div class="wl-ex">${examples.map((x) => `<button class="wl-chip" data-ex><span>${esc(x)}</span></button>`).join("")}
      <button class="wl-chip wl-tips" data-help><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17v.01"/></svg>${esc(t("使用提示"))}</button></div>`;
  }
  wlBelow.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.help != null) return openPage("help");
    inputEl.value = b.textContent.trim();
    autoGrow(); syncInterject(); inputEl.focus();
  });
  function welSync() {
    const w = histEl.childElementCount === 1 && !!histEl.querySelector(":scope > .msg.welcome") && !liveEl.childElementCount;
    if (document.documentElement.classList.contains("wel") === w) return;
    document.documentElement.classList.toggle("wel", w);
    syncPlaceholder(); paintProjChip();
  }
  new MutationObserver(welSync).observe(histEl, { childList: true });
  new MutationObserver(welSync).observe(liveEl, { childList: true });
  // 输入框里的一行提示：首屏问「有什么可以帮你」，会话里提示斜杠命令
  function syncPlaceholder() {
    inputEl.placeholder = document.documentElement.classList.contains("wel") ? t("有什么可以帮你？") : t("输入 / 调用技能和命令");
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

  // ── 维护者通知（经 cccodroid.net，网关验过签；见 gw/notices.mjs）：和更新说明同样的居中卡片 ──
  // 什么时候弹（用户 10-22 定）：正在用的时候不弹；打开应用、或从后台切回来时才看一眼。
  // 这次打开弹了更新说明，通知就顺延到下一次打开 / 切回来，两张卡片不叠在一起。
  // 内容是纯文本；链接只认 https（网关已筛）。点「知道了」= 卡片里这几条都记为看过。
  let noticeHold = false;
  async function loadNotices() {
    if (noticeHold || document.getElementById("whatsnew") || document.getElementById("notice-pop")) return;
    let r;
    try { r = await api("/api/notices?lang=" + encodeURIComponent(I18N.lang || "zh")); } catch { return; }
    const list = r.items || [];
    if (!list.length || noticeHold || document.hidden || document.getElementById("whatsnew") || document.getElementById("notice-pop")) return;
    const el = document.createElement("div");
    el.id = "notice-pop";
    el.innerHTML = `<div class="wn-card" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <div class="wn-head" id="np-title">${esc(t("通知"))}</div>
      <div class="wn-body">${list.map((n, i) => `<section class="np-${n.level === "warn" ? "warn" : "info"}">
        <div class="wn-ver">${esc(n.date)}</div><div class="np-title">${esc(n.title)}</div>
        ${n.body ? `<div class="np-body">${esc(n.body)}</div>` : ""}
        ${n.link ? `<button class="btn sm" data-open="${i}">${esc(n.linkText || t("查看详情"))}</button>` : ""}</section>`).join("")}</div>
      <div class="wn-foot"><button class="btn" data-act="ok">${esc(t("知道了"))}</button></div></div>`;
    el.addEventListener("click", async (e) => {
      const o = e.target.closest("[data-open]");
      if (o) return openExternal(list[+o.dataset.open].link);
      if (!e.target.closest("[data-act=ok]")) return;
      el.remove();
      for (const n of list) {
        try { await api("/api/notices/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }); } catch {}
      }
    });
    document.body.appendChild(el);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { noticeHold = false; loadNotices(); } });

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
      case "tasks":
        if (view.sessionId && ev.sessionId === view.sessionId) { view.tasks = ev.tasks || null; renderRunStrip(); }
        break;
      case "goal":
        if (view.sessionId && ev.sessionId === view.sessionId) { view.goal = ev.goal || null; renderRunStrip(); }
        return;
      case "state": return applyState(ev);
      case "sched": case "sched_note": return onSchedEvent(ev);
      case "sync": return;
      case "run_start": {
        if (!belongs(ev)) return;
        view.runIds.add(ev.runId);
        view.lastRunId = ev.runId;
        if (runViews.has(ev.runId)) return;
        if (ev.auto !== "idle") renderUser(ev.text, liveEl);
        const av = AssistantView(liveEl, true);
        if (ev.text.trim().startsWith("/")) av.msgEl.classList.add("sys");
        if (ev.auto === "idle") av.note(t("会话闲置快一小时，提示缓存快过期了，先自动压缩上下文，下一条消息就不用把整段历史重算一遍。不需要可以在设置里关掉。"), true);
        const timer = RunTimer(ev.startedAt);
        timer.attach(av);
        av.phase({ phase: "connect" });
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
        rv.avDone = false;
        if (rv.idle) { rv.idle = false; rv.timer = RunTimer(Date.now()); }   // 空闲时发来的消息：算新的一轮
        rv.timer?.attach(rv.av);          // 计时算整轮的，跟着最新的气泡走
        rv.av.phase({ phase: "connect" });
        scrollDown(true);
        return;
      }
      case "run_idle": {
        // 这一轮答完了，只是 Claude 起的后台任务（本地服务之类）还在跑
        const rv = runViews.get(ev.runId);
        if (rv && !rv.idle) { rv.idle = true; rv.timer?.stop(ev.at); rv.av.finish(); rv.avDone = true; }
        if (view.runIds.has(ev.runId)) setStatus(t("就绪 · 后台任务在跑（{n} 个）", { n: ev.bg || 0 }), "ok");
        return;
      }
      case "run_busy": {
        // 后台任务回报了，Claude 接着干：另起一个气泡、重新计时
        const rv = runViews.get(ev.runId);
        if (!rv || !rv.idle) return;
        rv.idle = false;
        if (rv.avDone) { rv.av = AssistantView(liveEl, true); rv.avDone = false; }
        rv.timer = RunTimer(ev.startedAt);
        rv.timer.attach(rv.av);
        rv.av.phase({ phase: "connect" });
        scrollDown(true);
        return;
      }
      case "init": {
        if (!view.runIds.has(ev.runId)) return;
        if (!view.sessionId && ev.sessionId) { view.sessionId = ev.sessionId; saveUiState(); }
        if (ev.model) { state.model = ev.model; paintModel(ev.model); }
        if (ev.permissionMode) setPermChip(ev.permissionMode);
        return;
      }
      case "run_end": refreshQuota(); return onRunEnd(ev);
      case "quota": return refreshQuota();
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
      case "tool_use": {
        const pc = ev.parent && TOOL_CARDS.get(ev.parent);
        if (pc && pc.isAgent) { pc.sub(ev.id, ev.name, ev.input); break; }
        av.tool(ev.id, ev.name, ev.input); break;
      }
      case "sub_text":       TOOL_CARDS.get(ev.parent)?.subText?.(ev.text); break;
      case "sub_progress":   TOOL_CARDS.get(ev.parent)?.subProgress?.(ev.desc); break;
      case "sub_done":       TOOL_CARDS.get(ev.parent)?.subDone?.(ev.status); break;
      case "tool_result":    toolResult(ev.id, ev.ok, ev.text); av.toolDone(ev.id); scrollDown(); break;
      case "phase":          av.phase(ev); break;
      case "compacting":     av.phase(null); av.note(t("正在压缩上下文…")); scrollDown(); break;
      case "note":           av.noteK(ev.key, ev.text); scrollDown(); break;
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
    const sid = view.sessionId, keepProj = view.projectId;   // 重连会重置视图：新会话已挑的项目留着
    resetView(sid);
    if (!sid && keepProj) { view.projectId = keepProj; paintProjChip(); }
    view.runIds = keepRuns; view.cids = keepCids;
    pickViewRun();
    renderSessions();
    if (sid) loadOlder(true);
    else if (!(ev.run && keepRuns.has(ev.run.id))) showWelcome();
    renderInterrupted(ev.interrupted);   // resetView 清掉了 liveEl，重挂一次
    setStatus(t("已连接"), "ok");
  }

  function onRunEnd(ev) {
    if (view.goalClearAfter && view.goalClearAfter === ev.runId) { view.goalClearAfter = null; setTimeout(() => send("/goal clear"), 300); }
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
    const busy = isBusy();
    sendEl.classList.toggle("busy", busy && !hasDraft());
    syncPlaceholder();
    syncInterject();
    renderQueue();
    // 别的窗口（或网关那边）已经答掉的，这里也收起来
    const livePerms = new Set((srv.run?.perms || []).map((p) => p.id));
    for (const [id, it] of PERMS) if (!it.done && srv.run && it.runId === srv.run.id && !livePerms.has(id) && it.p.at < Date.now() - 1500) permDone(id, "gone");
    if (busy) setStatus(t("生成中…"), "live");
    else if (srv.run?.idle) setStatus(t("就绪 · 后台任务在跑（{n} 个）", { n: srv.run.bg || 0 }), "ok");
    else if (srv.runs.some((r) => !r.idle)) setStatus(t("另有 {n} 个会话在生成", { n: srv.runs.filter((r) => !r.idle).length }), "ok");
    // 别的会话在等你确认：当前视图看不到它的卡片，状态栏和会话列表里提醒
    const elsewhere = srv.runs.filter((r) => r !== srv.run && r.perms && r.perms.length);
    if (elsewhere.length) setStatus(t("另一个会话在等你确认 · 打开会话列表查看"), "warn");
    const live = srv.runs.map((r) => (r.sessionId || "") + (r.perms && r.perms.length ? "!" : "") + (r.idle ? "~" : "")).join(",");
    if (live !== srv.liveKey) { srv.liveKey = live; renderSessions(); }
    renderPermBar();                 // 放最后：有待确认项时状态栏要显示「等你确认」
    renderInterrupted(s.interrupted);
    renderRunStrip();
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
  const isBusy = () => !!srv.run && !srv.run.idle;
  /** 并行上限真的满了（不算只剩后台任务的空闲轮次） */
  const atCap = () => srv.runs.filter((r) => !r.idle).length >= (srv.max || 3);

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
    const has = hasDraft();
    interjectEl.classList.toggle("hidden", !(isBusy() && has));
    sendEl.classList.toggle("busy", isBusy() && !has);
  }

  function renderQueue() {
    const q = srv.queue;
    queueStrip.classList.toggle("hidden", !q.length);
    const busy = isBusy();
    queueStrip.innerHTML = q.length ? `
      <div class="q-head">
        <span>${q.some((it) => it.held)
          ? q.some((it) => it.intr)
            ? t("上一轮被系统中断，{n} 条排队的消息已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
            : t("点了停止，{n} 条已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
          : busy ? t("待发 {n} 条 · 当前这一轮结束后依次发出", { n: q.length })
          // 真到并行上限才这么说；否则是这个会话上一轮还挂着（等后台任务 / 收尾），别让人以为开了好几个会话
          : atCap() ? t("同时在跑的会话已到上限（{max} 个），有空位就依次发出 · 待发 {n} 条", { max: srv.max, n: q.length })
          : t("待发 {n} 条 · 这个会话的上一轮还没完全结束（后台任务在跑或正在收尾），结束后依次发出", { n: q.length })}</span>
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
    const typed = (fromInput ? inputEl.value : forcedText).trim();
    // 附件只在附件栏里显示，发出时才把 @路径 接到末尾（claude 靠它读文件）；手动写过的不重复
    const refs = fromInput ? state.attachments.map((a) => "@" + a.path).filter((r) => !typed.includes(r)) : [];
    const text = typed && refs.length ? typed + "\n\n" + refs.join(" ") : typed || refs.join(" ");
    if (!text) return;
    if (fromInput) draftLast = "";      // 发出去的不算「误删」：有的输入法清空后还会补一个空的 input 事件
    hidePopup();

    // 纯界面命令：不惊动 claude
    if (typed === "/clear" || typed === "/new") {
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
    const sentAtt = fromInput ? state.attachments : [];
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
          projectId: view.sessionId ? null : view.projectId || null,     // 新会话：在项目目录里跑
          cid,
          mode: mode || "auto",
        }),
      });
      view.runIds.add(r.id);
      view.lastRunId = r.id;
      if (r.injected) toast(t("已插话：当前这一步做完，Claude 就会看到"));
      else if (!r.started) toast(mode === "inject" ? t("这一轮正在收尾，插不进去 —— 已排到最前，马上发出")
        : srv.run && !srv.run.idle ? t("已排队，这一轮结束后发出") : atCap() ? t("同时在跑的会话已到上限，已排队，有空位就发出") : t("已排队：这个会话的上一轮还没完全结束，结束后发出"));
    } catch (e) {
      view.cids.delete(cid);
      if (fromInput && !inputEl.value) { inputEl.value = typed; autoGrow(); }   // 别把用户的话吞了
      if (fromInput && !state.attachments.length && sentAtt.length) { state.attachments = sentAtt; renderAttachments(); }
      toast(e.message || t("发送失败"), true);
      if (e.status === 503) openDrawer("settings");
    }
  }

  /** 插话：不打断，把输入框里的字递进正在跑的这一轮（claude 在当前这一步结束后就会看到） */
  function interjectNow() {
    if (!hasDraft()) return;
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

  // 点浮层和输入框以外的地方就收起（手机上没有 Esc；之前只能删掉那个 / 才关得掉）
  document.addEventListener("pointerdown", (e) => {
    if (!state.popup.mode || popupEl.contains(e.target) || e.target === inputEl) return;
    hidePopup();
  }, true);

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

  // ── 草稿找回（上游 2.1.288：Ctrl+C 清掉的输入，空输入框按 ↑ 找回）──
  // 手机上更常见的是误删、全选后删空：一段 8 个字以上的内容被删空（不是发出去的），输入框下面亮一个「恢复」，20 秒后消失
  const draftChip = $("draft-chip");
  let draftLast = "", draftStash = "", draftT = null;
  function draftOffer(text) {
    draftStash = text;
    draftChip.classList.remove("hidden");
    clearTimeout(draftT);
    draftT = setTimeout(() => draftChip.classList.add("hidden"), 20000);
  }
  function draftRestore() {
    if (!draftStash || inputEl.value) return false;
    inputEl.value = draftStash;
    draftStash = ""; draftLast = inputEl.value;
    draftChip.classList.add("hidden");
    autoGrow(); syncInterject(); inputEl.focus();
    return true;
  }
  draftChip.addEventListener("click", draftRestore);

  inputEl.addEventListener("input", () => {
    autoGrow();
    syncInterject();
    const v = inputEl.value;
    // 逐字退格时保留删之前最长的那版；改成别的内容才换掉
    if (v) { if (v.length >= draftLast.length || !draftLast.startsWith(v)) draftLast = v; if (v.trim()) draftChip.classList.add("hidden"); }
    else if (draftLast.trim().length >= 8) { draftOffer(draftLast); draftLast = ""; }
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
    if (e.key === "ArrowUp" && !inputEl.value && draftStash) { e.preventDefault(); draftRestore(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (enterSends() || e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  // 回车键：默认发送；手机软键盘没有 Shift，想多行输入的可以改成回车换行（Ctrl + 回车或发送键发出）
  const enterSends = () => localStorage.getItem("cc.enterKey") !== "newline";
  function applyEnterKey() { inputEl.enterKeyHint = enterSends() ? "send" : "enter"; $("set-enter").value = enterSends() ? "send" : "newline"; }
  $("set-enter").addEventListener("change", (e) => {
    localStorage.setItem("cc.enterKey", e.target.value);
    applyEnterKey();
    toast(enterSends() ? t("回车直接发送") : t("回车换行，Ctrl + 回车或点发送键发出"));
  });
  applyEnterKey();

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
  sendEl.addEventListener("click", () => (hasDraft() || !isBusy() ? send() : abort()));
  interjectEl.addEventListener("click", interjectNow);

  // ── 递东西进来：上传 ──────────────────────────────────────────────
  /// 新建附件条（点回形针/粘贴/拖放都汇到这里）
  const attachStrip = document.createElement("div");
  attachStrip.id = "attach-strip";
  attachStrip.className = "hidden";
  $("composer").insertBefore(attachStrip, $("composer-inner"));
  setTimeout(() => { if (state.attachments.length) renderAttachments(); });

  // 附件栏记在 sessionStorage：冻结脱困 / 重新载入后照原样恢复（文件已经在设备上，只记路径）
  const ATT_KEY = "cc.att";
  try { const a = JSON.parse(sessionStorage.getItem(ATT_KEY) || "[]"); if (Array.isArray(a) && a.length) state.attachments = a.filter((x) => x && x.path); } catch {}
  function renderAttachments() {
    const list = state.attachments;
    try { list.length ? sessionStorage.setItem(ATT_KEY, JSON.stringify(list)) : sessionStorage.removeItem(ATT_KEY); } catch {}
    attachStrip.classList.toggle("hidden", !list.length);
    attachStrip.innerHTML = list.map((a, i) => `
      <div class="att" data-i="${i}">
        ${a.kind === "image"
          ? `<img src="${fileUrl(a.path)}" alt="">`
          : `<span class="att-ico">${esc((a.name.split(".").pop() || "?").slice(0, 4))}</span>`}
        <span class="att-name">${esc(a.name)}</span>
        <button class="att-x" aria-label="${t("移除")}">${uiI("x")}</button>
      </div>`).join("");
    syncInterject();
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
  function removeAttachment(a) {
    state.attachments = state.attachments.filter((x) => x.path !== a.path);
    renderAttachments();
  }
  /** 输入框有字或附件栏里有东西，就算有话要发 */
  function hasDraft() { return !!inputEl.value.trim() || state.attachments.length > 0; }

  /** 上传一批文件，成功后放进附件栏（发出时才把路径接进消息） */
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
  const DOC = '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>';
  const KIND_SVG = {
    dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17"/>',
    video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
    audio: '<path d="M9 17V5l10-2v12"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
    pdf: DOC + '<path d="M9 13h6M9 17h4"/>',
    text: DOC + '<path d="M9 12h6M9 15h6M9 18h4"/>',
    docx: DOC + '<path d="M9 12l1 5 2-3.5 2 3.5 1-5"/>',
    sheet: DOC + '<path d="M9 12h6v6H9zM9 15h6M12 12v6"/>',
    office: DOC + '<path d="M9 13h6v4H9z"/>',
    other: '<path d="M4 8l8-4.5L20 8v8l-8 4.5L4 16z"/><path d="M4 8l8 4.5L20 8M12 12.5V20"/>',
  };
  const kindIcon = (k) => `<svg class="ui-i k-${KIND_SVG[k] ? k : "other"}" viewBox="0 0 24 24" aria-hidden="true">${KIND_SVG[k] || KIND_SVG.other}</svg>`;

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
          <span class="fs-ico">${kindIcon(e.kind)}</span>
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
      if (sess.q.trim()) resessSearch(); else renderSessions();
    } catch {}
  }

  // 会话页三种视图：普通列表 / 多选（导出、批量删除）/ 回收站
  // q：搜索词；hits：网关返回的内容命中（null = 还没回来）；fold：各分组折叠状态（pin / today / week / month / m:年-月）
  const sess = { mode: "list", sel: new Set(), trash: [], keepDays: 30, q: "", hits: null, fold: loadSessFold(), flt: "all" };
  function loadSessFold() {
    let f = {};
    try { f = JSON.parse(localStorage.getItem("cc.sessFold") || "{}") || {}; } catch {}
    if (!("pin" in f) && localStorage.getItem("cc.pinFold") === "1") f.pin = true;   // 旧版只记了置顶组
    return f;
  }
  // 没手动动过的：一个月以前的按月分组默认收起，其余展开
  const sessFolded = (k) => k in sess.fold ? !!sess.fold[k] : k.startsWith("m:");

  // 精确到分钟；今年的省掉年份
  function fmtStamp(ms) {
    if (!ms) return "—";
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    const md = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + "-" + md;
  }
  // 按最后变动分组：今天 / 7 天内（不含今天）/ 30 天内 / 某年某月。key 不随界面语言变，用来记折叠状态
  function sessGroup(ms) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const day = 86400000, t0 = d0.getTime();
    if (ms >= t0) return { key: "today", label: t("今天") };
    if (ms >= t0 - 7 * day) return { key: "week", label: t("7 天内") };
    if (ms >= t0 - 30 * day) return { key: "month", label: t("30 天内") };
    const d = new Date(ms), key = "m:" + d.getFullYear() + "-" + (d.getMonth() + 1);
    try { return { key, label: d.toLocaleDateString(document.documentElement.lang || undefined, { year: "numeric", month: "long" }) }; }
    catch { return { key, label: key.slice(2) }; }
  }
  // 先转义再标出命中（不区分大小写）
  function markHit(text, q) {
    if (!q) return esc(text);
    const lo = text.toLowerCase(), n = q.toLowerCase();
    let out = "", i = 0;
    for (let j = lo.indexOf(n); j >= 0; j = lo.indexOf(n, i)) { out += esc(text.slice(i, j)) + "<mark>" + esc(text.slice(j, j + n.length)) + "</mark>"; i = j + n.length; }
    return out + esc(text.slice(i));
  }

  function renderSessions() {
    renderSideRecent();
    renderSideNav();
    const box = $("session-list");
    renderSessBar();
    $("sess-qbox").classList.toggle("hidden", sess.mode === "trash");
    $("sess-h").textContent = sess.mode === "trash" ? t("回收站") : t("对话");
    if (sess.mode === "trash") $("sess-flt-wrap").classList.add("hidden");
    if (sess.mode === "trash") return renderTrash(box);
    const q = sess.q.trim();
    if (!q && !state.sessions.length) {
      box.innerHTML = '<div class="tiny">' + t("还没有历史会话。") + '</div>';
      return;
    }
    // 空闲（答完了、只剩后台任务在跑）的不算「生成中」，单独标出来
    const liveSids = new Set(srv.runs.filter((r) => !r.idle).map((r) => r.sessionId).filter(Boolean));
    const idleSids = new Set(srv.runs.filter((r) => r.idle).map((r) => r.sessionId).filter(Boolean));
    const askSids = new Set(srv.runs.filter((r) => r.perms && r.perms.length).map((r) => r.sessionId).filter(Boolean));
    const picking = sess.mode === "select";
    // 筛选条（照设计稿）：全部 / 在跑 / 置顶 / 当前项目；项目功能上线后换成按项目分
    const isLive = (s) => liveSids.has(s.id) || idleSids.has(s.id) || askSids.has(s.id);
    const sids = schedSids();
    const FLT = { all: [t("全部"), () => true], live: [t("在跑"), isLive], pin: [t("置顶"), (s) => s.pinned] };
    if (PJ.list.length) { FLT.none = [t("不在项目里"), (s) => !pjOfCwd(s.cwd)]; for (const p of PJ.list) FLT["p:" + p.id] = [p.name, (s) => { const q = pjOfCwd(s.cwd); return !!q && q.id === p.id; }]; }
    FLT.sched = [t("定时任务"), (s) => sids.has(s.id)];
    if (!FLT[sess.flt]) sess.flt = "all";
    if (sess.flt !== "all" && !state.sessions.some(FLT[sess.flt][1])) sess.flt = "all";
    $("sess-flt").innerHTML = Object.entries(FLT).filter(([k, f]) => k === "all" || state.sessions.some(f[1]))
      .map(([k, f]) => `<button data-f="${k}" class="${sess.flt === k ? "on" : ""}">${esc(f[0])}</button>`).join("");
    $("sess-flt-wrap").classList.toggle("hidden", $("sess-flt").children.length < 2);
    const keep = FLT[sess.flt][1];
    const nLive = state.sessions.filter(isLive).length;
    setPageSub("sessions", t("{n} 个", { n: state.sessions.length }) + (nLive ? " · " + t("{n} 个在跑", { n: nLive }) : ""));
    // 一行一个：标题 + 等宽的时间/大小；点整行打开，「⋯」里是置顶、改名、导出、删除（和侧栏长按同一份菜单）
    const item = (s) => {
      const st = askSids.has(s.id) ? `<span class="badge warn">${t("等你确认")}</span>` : liveSids.has(s.id) ? `<span class="badge cur">${t("生成中")}</span>` : idleSids.has(s.id) ? `<span class="badge">${t("后台任务在跑")}</span>` : "";
      return `
      <div class="item srow-sess ${s.id === view.sessionId ? "active" : ""} ${picking && sess.sel.has(s.id) ? "picked" : ""}" data-id="${esc(s.id)}">
        ${picking ? `<input type="checkbox" class="sess-ck" ${sess.sel.has(s.id) ? "checked" : ""}>` : ""}
        <div class="ss-main">
          <div class="it-title">${s.pinned ? `<svg class="pin-ic" viewBox="0 0 24 24">${SM.pin}</svg>` : ""}${sids.has(s.id) ? pi("clock", "pj-ic") : ""}${markHit(s.title, q)}</div>
          ${s.snippet ? `<div class="it-snip">${markHit(s.snippet, q)}${s.count > 1 ? ` <span class="badge">${t("{n} 处", { n: s.count >= 99 ? "99+" : s.count })}</span>` : ""}</div>` : ""}
          <div class="it-meta">
            <span title="${esc(t("更新 {time}", { time: new Date(s.mtime).toLocaleString() }) + (s.created ? " · " + t("创建 {time}", { time: new Date(s.created).toLocaleString() }) : ""))}">${fmtStamp(s.mtime)}</span>
            <span>${fmtSize(s.sizeKb * 1024)}</span>
            ${st}
            ${pjOfCwd(s.cwd) ? pjMark(pjOfCwd(s.cwd)) : ""}
            ${s.renamed ? `<span class="badge">${t("已命名")}</span>` : ""}
          </div>
        </div>
        ${picking ? "" : `<button class="ss-more" data-a="more" aria-label="${esc(t("更多"))}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg></button>`}
      </div>`;
    };
    if (q) {
      // 标题先在本地筛，内容命中等网关回来再补上
      const list = (sess.hits || state.sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase()))).filter((h) => { const s = state.sessions.find((x) => x.id === h.id); return !s || keep(s); });
      box.innerHTML = (sess.hits ? "" : `<div class="tiny">${t("正在搜索对话内容…")}</div>`)
        + (list.length ? list.map(item).join("") : sess.hits ? `<div class="tiny">${t("没有找到包含「{q}」的会话。", { q: esc(q) })}</div>` : "");
      return;
    }
    // 分组：置顶在最前，其余按时间；每组标题可点击折叠，收起时仍露出当前会话
    const groups = [];
    const shown = state.sessions.filter(keep);
    const pins = shown.filter((s) => s.pinned);
    if (pins.length) groups.push({ key: "pin", label: t("置顶"), list: pins });
    for (const s of shown) {
      if (s.pinned) continue;
      const g = sessGroup(s.mtime), top = groups[groups.length - 1];
      if (top && top.key === g.key) top.list.push(s); else groups.push({ ...g, list: [s] });
    }
    let html = "";
    for (const g of groups) {
      const folded = sessFolded(g.key);
      html += `<div class="sess-grp ${g.key === "pin" ? "pin" : ""} ${folded ? "folded" : ""}" data-g="${esc(g.key)}"><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>${esc(g.label)} · ${g.list.length}</div>`;
      html += (folded ? g.list.filter((s) => s.id === view.sessionId) : g.list).map(item).join("");
    }
    box.innerHTML = html;
  }

  // 搜索：输完停 300ms 再问网关；过时的回复丢掉
  let sessQT = 0, sessQN = 0;
  $("sess-q").addEventListener("input", (e) => {
    sess.q = e.target.value; sess.hits = null;
    clearTimeout(sessQT);
    renderSessions();
    const q = sess.q.trim();
    if (!q) return;
    const n = ++sessQN;
    sessQT = setTimeout(async () => {
      try {
        const r = await api("/api/sessions/search?q=" + encodeURIComponent(q));
        if (n === sessQN && sess.q.trim() === q) { sess.hits = r.results || []; renderSessions(); }
      } catch (err) { if (n === sessQN) { sess.hits = []; renderSessions(); toast(err.message, true); } }
    }, 300);
  });
  // 刷新列表时搜索结果也跟着重查
  function resessSearch() { if (sess.q.trim()) $("sess-q").dispatchEvent(new Event("input")); }

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
        <button class="btn ghost sm danger" data-b="trash" ${n ? "" : "disabled"}>${t("删除所选")}</button>
        <button class="btn ghost sm" data-b="cancel">${t("取消选择")}</button>`;
    } else if (sess.mode === "exported") {
      const r = sess.exported;
      bar.innerHTML = `<span class="tiny">${t("已导出 {n} 个会话", { n: r.count })}</span>
        ${canSaveAs() ? `<button class="btn sm" data-b="save">${t("保存到…")}</button>` : ""}
        ${canShare() ? `<button class="btn sm" data-b="share">${t("分享…")}</button>` : ""}
        <button class="btn ghost sm" data-b="done">${t("完成")}</button>
        ${canSaveAs() || canShare() ? "" : `<div class="tiny">${esc(r.file)}</div>`}`;
    } else if (sess.mode === "trash") {
      bar.innerHTML = `<span class="tiny">${t("删除的会话在这里保留 {n} 天，之后自动清除。", { n: sess.keepDays })}</span>
        ${sess.trash.length ? `<button class="btn ghost sm danger" data-b="empty">${t("清空回收站")}</button>` : ""}
        <button class="btn ghost sm" data-b="back">${t("返回会话")}</button>`;
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
  $("sess-flt").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; sess.flt = b.dataset.f; renderSessions(); });
  // 页面标题旁的 ⋯：原来那排按钮的活
  $("sess-kebab").addEventListener("click", (e) => {
    const cl = (id) => () => $(id).click();
    popMenu(e.currentTarget, [
      { label: sess.mode === "select" ? t("取消选择") : t("选择多个"), icon: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>', fn: cl("btn-sess-select") },
      { label: t("导入对话（.zip）"), icon: '<path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>', fn: cl("btn-sess-import") },
      { label: sess.mode === "trash" ? t("返回会话") : t("回收站"), icon: SM.trash, fn: cl("btn-sess-trash") },
      { label: t("刷新列表"), icon: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', fn: cl("btn-refresh-sessions") },
      "hr",
      { label: t("断开当前会话"), icon: '<path d="M9 7 4 12l5 5M4 12h11M15 4h4v16h-4"/>', fn: cl("btn-close-session") },
    ]);
  });
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
    if (act === "cancel") return $("btn-sess-select").click();
    if (act === "back") return $("btn-sess-trash").click();
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
    const grp = e.target.closest(".sess-grp[data-g]");
    if (grp) {
      const k = grp.dataset.g;
      sess.fold[k] = !sessFolded(k);
      localStorage.setItem("cc.sessFold", JSON.stringify(sess.fold));
      return renderSessions();
    }
    const el = e.target.closest(".item");
    if (!el) return;
    const id = el.dataset.id;
    if (sess.mode === "select") {
      if (sess.sel.has(id)) sess.sel.delete(id); else sess.sel.add(id);
      return renderSessions();
    }
    const b = e.target.closest("button");
    if (!b && sess.mode !== "trash") {
      const h = sess.q.trim() && (sess.hits || []).find((s) => s.id === id);
      closeDrawer(); openSession(id, h && h.count ? sess.q.trim() : ""); return;
    }
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.a;
    if (a === "more") return sessMenu(id, b);
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
    if (a === "open") {
      const h = sess.q.trim() && (sess.hits || []).find((s) => s.id === id);
      closeDrawer(); openSession(id, h && h.count ? sess.q.trim() : ""); return;
    }
    if (a === "pin") {
      const cur = state.sessions.find((s) => s.id === id) || (sess.hits || []).find((s) => s.id === id);
      try { await post(`/api/session/${encodeURIComponent(id)}/pin`, { pin: !(cur && cur.pinned) }); }
      catch (err) { return toast(err.message, true); }
      loadSessions();
      return;
    }
    if (a === "rename") {
      const cur = state.sessions.find((s) => s.id === id) || (sess.hits || []).find((s) => s.id === id);
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
  // 设计稿的行：左名称 + 一行等宽小字，右边大小 / 状态 / 按钮；说明、依赖这些点一下行才展开（.it-more），进度条一直在
  const EI = {
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-7"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H12z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    tool: '<path d="M4 20l7-7M14 4l6 6-3 3-6-6zM10 8l6 6"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z"/>',
  };
  const ei = (n) => `<svg class="ei" viewBox="0 0 24 24">${EI[n]}</svg>`;
  const sdot = (st, label) => `<span class="sdot ${st}"><i></i>${esc(label)}</span>`;
  const rowItem = (title, sub, right, o = {}) => `<div class="item xrow${o.cls ? " " + o.cls : ""}"${o.tags ? ` data-tags="${esc(o.tags.join(" "))}"` : ""}>
      <div class="xr-l"><div class="it-title">${title}</div>${sub ? `<div class="xr-sub">${sub}</div>` : ""}</div>
      <div class="xr-r">${right || ""}</div>${o.extra || ""}${o.more ? `<div class="it-more">${o.more}</div>` : ""}</div>`;
  // 点行（不是点按钮、链接、输入框）展开 / 收起说明
  $("tab-ext").addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select, textarea, label, summary, details, .gh-auth, .llm-dl")) return;
    const r = e.target.closest(".xrow, .ccard"); if (r && r.querySelector(".it-more")) r.classList.toggle("open");
  });
  const extItem = (title, meta, acts, desc, tags) => `<div class="item"${tags ? ` data-tags="${esc(tags.join(" "))}"` : ""}>
      <div class="it-title">${title}</div>
      ${meta ? `<div class="it-meta">${meta}</div>` : ""}
      ${desc || ""}
      ${acts ? `<div class="it-acts">${acts}</div>` : ""}</div>`;

  // ── 工具包模块（0.3.9 起）：基础 + 随装随卸的模块；用途、命令、包、大小、依赖、谁在用都摆出来 ──
  let modTimer = 0;
  const MOD_USES = () => ({
    claude: t("Claude Code 本身"), git: t("git 面板"), terminal: t("终端"), shizuku: t("Shizuku 一键启动（无线调试）"), search: t("Claude 搜代码、看差异"),
    "native-build": t("编译原生程序"), apk: t("打 APK"), "usb-adb": t("USB 调试"), "gpu-components": t("GPU 组件（Blender、浏览器等）"),
    media: t("音视频处理"), docs: t("排版、表格分析、图片处理"),
  });
  async function loadModules() {
    clearTimeout(modTimer);
    const r = await api("/api/devkit/modules").catch(() => null);
    const on = !!(r && r.supported && r.modular);
    $("mod-field").classList.toggle("hidden", !on);
    if (!on) return;
    const items = r.items || [], byId = Object.fromEntries(items.map((m) => [m.id, m]));
    const nameOf = (id) => esc(pickLang((byId[id] || {}).name) || id);
    const inst = items.filter((m) => m.state === "ok");
    $("mod-count").textContent = inst.length + "/" + items.length;
    ext.nMod = items.length; extSub();
    ext.modBytes = inst.reduce((s, m) => s + m.installed, 0); ext.free = r.free; paintStorage();
    const btn = (c, id, label, extra = "") => `<button data-c="${c}" data-id="${esc(id)}"${extra}>${label}</button>`;
    let moving = false;
    $("mod-list").innerHTML = items.map((m) => {
      const pr = m.progress;
      moving ||= !!pr;
      const st = { absent: t("未安装"), downloading: t("下载中"), verifying: t("校验中"), installing: t("正在装进工具包…"), ok: t("已安装"), error: t("安装失败") }[m.state] || m.state;
      const kind = m.required ? t("必装") : m.kind === "shared" ? t("共享运行库") : "";
      const meta = "<span>" + esc(st) + "</span>" + (kind ? "<span>" + kind + "</span>" : "") +
        "<span>" + (m.state === "ok" ? t("占用 {b}", { b: MB(m.installed) }) : t("下载约 {a}，装好后约 {b}", { a: MB(m.download), b: MB(m.installed) })) + "</span>";
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(m.desc)) + "</div>";
      const uses = (m.uses || []).map((u) => MOD_USES()[u] || u);
      if (uses.length) desc += '<div class="tiny">' + t("App 里用到它的：{list}", { list: esc(listOf(uses)) }) + "</div>";
      const deps = (m.deps || []).filter((d) => byId[d] && !byId[d].required);
      if (deps.length) desc += '<div class="tiny">' + t("依赖：{list}", { list: listOf(deps.map(nameOf)) }) + "</div>";
      if (m.kind === "shared" && (m.users || []).length) desc += '<div class="tiny">' + t("给这些模块用：{list}", { list: listOf(m.users.map(nameOf)) }) + "</div>";
      const used = [...(m.usedBy.modules || []).map(nameOf), ...(m.usedBy.components || []).map((c) => esc(c))];
      if (used.length) desc += '<div class="tiny">' + t("正在用它的：{list}", { list: listOf(used) }) + "</div>";
      if (m.error) desc += '<div class="tiny err">' + esc(m.error) + "</div>";
      // 命令与包：点开看全部
      const cmds = m.commands || [];
      if ((m.key || []).length) desc += '<div class="tiny">' + t("主要命令：") + " " + m.key.map((x) => "<code>" + esc(x) + "</code>").join(" ") + "</div>";
      desc += '<details class="tiny"><summary>' + t("{n} 个命令、{p} 个包", { n: cmds.length, p: (m.packages || []).length }) + "</summary>" +
        (cmds.length ? "<div>" + cmds.map((c) => "<code>" + esc(c) + "</code>").join(" ") + "</div>" : "") +
        '<div class="mono" style="margin-top:4px;color:var(--fg3)">' + (m.packages || []).map(esc).join("<br>") + "</div>" +
        '<div style="margin-top:4px;color:var(--fg3)">' + t("来源：Termux 官方仓库 · 快照 {s}", { s: esc(r.snapshot || "") }) + (m.sha256 ? "<br>sha256 " + esc(m.sha256) : "") + "</div></details>";
      let bar = "";
      if (pr && pr.total) {
        const pct = Math.min(100, (pr.done / pr.total) * 100).toFixed(1);
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + (pr.current && pr.current !== m.id ? nameOf(pr.current) + " · " : "") + MB(pr.done) + " / " + MB(pr.total) + (pr.via ? " · " + t("来自 {src}", { src: esc(pr.via) }) : "") + "</div>";
      }
      let acts = "", size = MB(m.state === "ok" ? m.installed : m.download);
      if (m.required || m.kind === "shared") acts = m.state === "ok" ? sdot("ok", t("已装")) : sdot("", st);
      else if (m.state === "absent" || m.state === "error") {
        // 连同还没装的依赖一起算下载量
        const chain = [...deps.filter((d) => byId[d].state !== "ok"), m.id];
        size = MB(chain.reduce((s, id) => s + byId[id].download, 0));
        acts = (m.state === "error" ? sdot("err", st) : "") + btn("install", m.id, ei("download") + (m.state === "error" ? t("重试") : t("安装")), ' class="btn sm"' + (chain.length > 1 ? ` data-chain="${esc(listOf(chain.map(nameOf)))}"` : ""));
      } else if (m.state === "downloading" || m.state === "verifying" || m.state === "installing") acts = sdot("warn", st) + (m.state === "installing" ? "" : btn("cancel", m.id, t("取消"), ' class="btn sm ghost"'));
      else if (m.state === "ok") acts = btn("remove", m.id, t("卸载"), ' class="btn sm ghost"' + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
      const tag = m.required ? `<span class="tag">${ei("lock")}${t("必装")}</span>` : m.kind === "shared" ? `<span class="tag">${t("共享运行库")}</span>` : "";
      return rowItem(esc(pickLang(m.name) || m.id) + tag, '<span class="mono">' + (m.key || []).map(esc).join(" ") + "</span>",
        '<span class="num">' + size + "</span>" + acts, { more: desc, extra: bar });
    }).join("");
    if (moving && pageOn("ext")) modTimer = setTimeout(loadModules, 1500);
  }
  $("mod-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-c]");
    if (!b) return;
    const c = b.dataset.c, id = b.dataset.id;
    if (c === "remove") {
      if (b.dataset.usedby) return toast(t("{names} 要用它，先卸载那些", { names: b.dataset.usedby }), true);
      if (!confirm(t("卸载这个模块？它的命令会从工具包里删掉，别的模块和组件还在用的文件会留下。以后可以随时再装。"))) return;
    }
    if (c === "install" && b.dataset.chain && !confirm(t("会一起装上：{list}。继续？", { list: b.dataset.chain }))) return;
    b.disabled = true;
    const r = await post("/api/devkit/modules/" + c, { id }).catch((e2) => ({ ok: false, message: e2.message }));
    if (!r.ok) toast(r.message || t("失败"), true);
    setTimeout(loadModules, 300);
  });

  function loadExt() { loadModules(); loadComponents(60); loadCustom(); loadExtPlugins(); loadExtSkills(); loadExtMcp(); loadExtMarkets(); loadExtHooks(); }

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
      .map(([g, l, n]) => `<button class="idx-chip${g === cur ? " on" : ""}" data-sec="${sec}" data-idx="${esc(g)}">${esc(l)}${g ? `<span>${n}</span>` : ""}</button>`).join("");
    for (const it of items) it.classList.toggle("hidden", !!cur && !it.dataset.tags.split(" ").includes(cur));
  }
  $("tab-ext").addEventListener("click", (e) => {
    const c = e.target.closest(".idx-chip"); if (!c) return;
    extPick[c.dataset.sec] = c.dataset.idx; renderIdx(c.dataset.sec);
  });
  // 节头照设计稿：图标块 + 标题，下面一句说明（原来是节里第一行小字，挪进标题里）；节不再折叠，靠顶上的分区导航跳
  for (const d of document.querySelectorAll("#tab-ext details.ext-sec")) {
    d.open = true;
    const sum = d.querySelector(":scope > summary"), tip = sum.nextElementSibling;
    if (tip && tip.classList.contains("tiny")) { tip.classList.add("sec-desc"); sum.appendChild(tip); }
    sum.addEventListener("click", (e) => e.preventDefault());
  }

  // ── 可选组件（浏览器组件 = 无头 Chromium）：下载 → 校验 → 换进工具包，进度靠轮询 ──
  let compTimer = 0;
  // 只有 zh / en 两份：中文界面（简繁都算）用 zh，其它语言一律用 en
  const pickLang = (o) => (o && typeof o === "object" ? (isZh() ? o.zh || o.en : o.en || o.zh) || "" : o || "");
  const MB = (n) => Math.max(1, Math.round((n || 0) / 1048576)) + " MB";
  // 「A、B 和 C」这种并列按当前语言的习惯拼
  const listOf = (a) => { try { return new Intl.ListFormat((window.I18N && I18N.lang) || "zh", { type: "conjunction" }).format(a); } catch { return a.join(", "); } };
  // 顶栏副标题：几个模块 · 几个组件
  function extSub() { setPageSub("ext", [ext.nMod ? t("{n} 个模块", { n: ext.nMod }) : "", ext.nComp ? t("{n} 个组件", { n: ext.nComp }) : ""].filter(Boolean).join(" · ")); }
  // 分类的颜色和图标（卡片左上角）
  const CAT_LOOK = { gpu: ["#c96442", "cube"], cad: ["#c96442", "cube"], media: ["#b5532f", "play"], office: ["#2f6aa8", "book"], science: ["#7650c0", "gauge"],
    eda: ["#9a6a00", "bolt"], ai: ["#3d7a2a", "spark"], dev: ["#5d594f", "tool"], net: ["#2f6aa8", "globe"], other: ["#5d594f", "puzzle"] };
  // 存储条：工具包模块 + 组件占多少，盘里还剩多少
  function paintStorage() {
    const el = $("ext-storage"); if (!el) return;
    const a = ext.modBytes || 0, b = ext.compBytes || 0, all = a + b + (ext.free || 0);
    el.classList.toggle("hidden", !a && !b);
    if (!all) return;
    const GB = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(n >= 107374182400 ? 0 : 1) + " GB" : MB(n);
    el.innerHTML = `<div class="st-bar"><i style="width:${(a / all * 100).toFixed(2)}%;background:#c96442"></i><i style="width:${(b / all * 100).toFixed(2)}%;background:#2f6aa8"></i></div>
      <div class="st-leg"><span><b class="sw" style="background:#c96442"></b>${t("工具包")} <span class="num">${GB(a)}</span></span><span><b class="sw" style="background:#2f6aa8"></b>${t("组件")} <span class="num">${GB(b)}</span></span>${ext.free != null ? `<span class="muted">${t("剩余")} <span class="num">${GB(ext.free)}</span></span>` : ""}</div>`;
  }
  // 组件节头的「检查更新」：强制重拉组件索引
  $("comp-check").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); loadComponents(true).then(() => toast(t("已检查组件更新"))); });
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
      const gpuOnly = c.needs && (c.needs.gpu === "adreno" || c.needs.gpu === "mali") ? c.needs.gpu : "";
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
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + MB(pr.done) + " / " + MB(pr.total) + (pr.via ? " · " + t("来自 {src}", { src: esc(pr.via) }) : "") + "</div>";
      }
      const ver = c.installedVersion || c.version;
      const meta = "<span>" + esc(st) + "</span>" + (ver ? "<span>" + esc(ver) + "</span>" : "") +
        (size && c.state !== "ok" ? "<span>" + esc(size) + "</span>" : "") +
        // 社区组件标出来；没有真机验证记录的再加一个提醒
        (c.source === "community" ? "<span>" + t("社区") + "</span>" : "") +
        (!c.verified ? '<span class="warn">' + t("未经真机验证") + "</span>" : "") +
        (c.license && c.state !== "ok" ? "<span>" + esc(c.license) + "</span>" : "") +
        (gpuOnly && c.state !== "ok" ? (c.unsupported ? '<span class="warn">' + (gpuOnly === "mali" ? t("只限 ARM Mali GPU（天玑、Exynos 等）设备，本机用不了") : t("只限高通骁龙（Adreno GPU）设备，本机用不了")) + "</span>"
          : "<span>" + (gpuOnly === "mali" ? t("Mali 专用") : t("骁龙专用")) + "</span>") : "");
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(c.desc)) + "</div>";
      if (c.error) desc += '<div class="tiny err">' + esc(c.error) + "</div>";
      if (miss.length && c.state !== "ok") desc += '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>";
      if (c.homepage && c.state !== "ok") desc += '<div class="tiny"><a class="weblink" href="' + esc(c.homepage) + '">' + esc(c.homepage) + "</a></div>";
      if (c.state === "ok" && c.bin.length) desc += '<div class="tiny">' + t("命令：") + " " + c.bin.map((b) => "<code>" + esc(b) + "</code>").join(" ") + "</div>";
      if (c.id === "gh" && c.state === "ok") desc += '<div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div>";
      if (c.id === "llama-cpp" && c.state === "ok") desc += '<details class="llm-dl" id="llm-dl"' + (llmDl.open ? " open" : "") + "><summary>" + t("下载模型") + '</summary><div id="llm-dl-body">' + llmDl.html + "</div></details>";
      const used = (c.usedBy || []).map((d) => esc(pickLang(d.name) || d.id));
      const cat = c.category && CAT()[c.category] ? c.category : "other";
      const tags = ["cat:" + cat];
      if (c.state === "ok") tags.push("inst");
      if (["update", "outdated", "damaged", "error"].includes(c.state)) tags.push("upd");
      // 设计稿的卡片：分类色图标 + 名称 + 「版本 · 大小」，验证过的带盾牌；底下一条虚线隔开状态和按钮
      const [cc, ci] = CAT_LOOK[cat] || CAT_LOOK.other;
      const dotSt = { ok: "ok", update: "warn", downloading: "warn", verifying: "warn", installing: "warn", outdated: "err", damaged: "err", error: "err" }[c.state] || "";
      const dotL = c.unsupported ? (gpuOnly === "mali" ? t("需要 Mali GPU") : t("需要骁龙")) : { ok: t("已装"), update: t("可更新"), absent: c.available ? t("未装") : t("暂无适配版本") }[c.state] || st;
      let cbtn = "";
      if (c.unsupported && c.state !== "ok") cbtn = '<span class="muted">' + t("本机用不了") + "</span>";
      else if (c.state === "absent" && c.available) cbtn = btn("install", c.id, ei("download") + MB(c.bytes)).replace("<button ", '<button class="btn sm ghost" ');
      else if (c.state === "downloading" || c.state === "verifying") cbtn = btn("cancel", c.id, t("取消")).replace("<button ", '<button class="btn sm ghost" ');
      else if (c.state === "ok") cbtn = btn("remove", c.id, t("卸载")).replace("<button ", '<button class="btn sm ghost" ');
      else if (["update", "outdated", "damaged", "error"].includes(c.state)) {
        if (c.available) cbtn += btn("install", c.id, ei("download") + (c.state === "update" ? t("更新") : t("重新安装"))).replace("<button ", '<button class="btn sm" ');
        if (c.installedVersion) cbtn += btn("remove", c.id, t("卸载")).replace("<button ", '<button class="btn sm ghost" ');
      }
      const live = (c.id === "gh" && c.state === "ok") || (c.id === "llama-cpp" && c.state === "ok") ? desc.slice(desc.indexOf(c.id === "gh" ? '<div class="gh-auth"' : '<details class="llm-dl"')) : "";
      const more = (live ? desc.slice(0, desc.length - live.length) : desc) + '<div class="it-meta">' + meta + "</div>";
      const warn = (c.error ? '<div class="tiny err">' + esc(c.error) + "</div>" : "") + (miss.length && c.state !== "ok" ? '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>" : "");
      return (`<div class="item ccard${c.unsupported && c.state !== "ok" ? " dim" : ""}" data-tags="${esc(tags.join(" "))}">
        <div class="cc-top"><span class="icobox" style="--c:${cc}">${ei(ci)}</span><div class="grow"><b>${name}</b><div class="mono muted">${esc(ver || "")}${ver ? " · " : ""}${MB(c.state === "ok" ? c.installed : c.bytes)}</div></div>${c.verified ? `<span class="vmark" title="${esc(t("真机验证过"))}">${ei("shield")}</span>` : ""}</div>
        ${warn}${bar}${live}<div class="it-more">${more}</div>
        <div class="cc-foot">${sdot(dotSt, dotL)}<span class="cc-btns">${cbtn}</span></div></div>`)
        .replace(" data-c=\"install\"", " data-c=\"install\"" + (c.verified ? "" : " data-unverified=\"1\"") + (miss.length ? " disabled" : ""))
        .replace(" data-c=\"remove\"", " data-c=\"remove\"" + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
    }).join("");
    box.innerHTML = (html || '<div class="tiny">' + (r.indexError ? t("组件清单取不到：{msg}", { msg: esc(r.indexError) }) : t("暂时没有可装的组件。")) + "</div>") +
      (html && r.indexError ? '<div class="tiny err">' + t("部分组件清单取不到：{msg}", { msg: esc(r.indexError) }) + "</div>" : "") +
      (r.indexError ? '<div class="it-acts"><button class="btn ghost sm" data-c="reindex">' + t("重试") + "</button></div>" : "");
    $("comp-count").textContent = (r.items || []).length || "";
    ext.nComp = (r.items || []).length; extSub();
    ext.compBytes = (r.items || []).filter((c) => c.installedVersion || c.state === "ok").reduce((s, c) => s + (c.installed || 0), 0); paintStorage();
    renderIdx("comp", [["inst", t("已装")], ["upd", t("要更新")], ...Object.entries(CAT()).map(([k, v]) => ["cat:" + k, v])]);
    if ($("gh-auth")) loadGhAuth(refresh);
    if ($("llm-dl")) {
      $("llm-dl").addEventListener("toggle", () => { llmDl.open = $("llm-dl").open; if (llmDl.open) loadLlmDl(); });
      if (llmDl.open) loadLlmDl();
    }
    // 有在跑的就一秒刷一次；抽屉关了 / 换了页签就停
    if ((r.items || []).some((c) => c.progress) && pageOn("ext"))
      compTimer = setTimeout(loadComponents, 1000);
  }

  // ── 自定义组件：用户自己导入 Linux arm64 程序。选文件 → 网关分析（ELF 类型、缺的库）→ 勾要用的命令 → 安装（补库、写入口和技能）──
  const cust = { rep: null, busy: false };
  const cpost = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const KIND = () => ({ glibc: t("Linux 程序（glibc）"), bionic: t("安卓原生程序"), static: t("静态程序"), script: t("脚本"),
    musl: "musl", unsupported: t("跑不了") });
  async function loadCustom() {
    const r = await api("/api/custom").catch(() => ({ supported: false }));
    $("custom-field").classList.toggle("hidden", !r.supported);
    if (!r.supported) return;
    $("custom-count").textContent = (r.items || []).length || "";
    $("custom-list").innerHTML = (r.items || []).map((c) => {
      const cmds = c.entries.map((e) => "<code>" + esc(e.cmd) + "</code>" + (e.ok ? "" : ' <span class="warn">' + t("入口丢了") + "</span>") +
        ' <button class="btn ghost sm" data-cu="try" data-id="' + esc(c.id) + '" data-cmd="' + esc(e.cmd) + '">' + t("试运行") + "</button>").join(" ");
      const meta = "<span>" + esc(c.source) + "</span><span>" + MB(c.bytes) + "</span>" +
        (c.deps ? "<span>" + t("补了 {n} 个库", { n: c.deps }) + "</span>" : "") +
        [...new Set(c.entries.map((e) => KIND()[e.kind] || e.kind))].map((k) => "<span>" + esc(k) + "</span>").join("");
      let desc = (c.desc ? '<div class="tiny ext-desc">' + esc(c.desc) + "</div>" : "") + '<div class="tiny cu-cmds">' + t("命令：") + " " + cmds + "</div>";
      if (c.unresolved.length) desc += '<div class="tiny warn">' + t("还缺这些库，可能跑不起来：{libs}", { libs: esc(c.unresolved.join(", ")) }) + "</div>";
      desc += '<pre class="cu-out hidden" id="cu-out-' + esc(c.id) + '"></pre>';
      return extItem(esc(c.name), meta, '<button data-cu="remove" data-id="' + esc(c.id) + '">' + t("卸载") + "</button>", desc);
    }).join("");
  }
  async function customAnalyze(file, pathStr) {
    if (cust.busy) return;
    cust.busy = true;
    const wiz = $("custom-wiz");
    wiz.innerHTML = '<div class="tiny">' + (file ? t("正在上传并分析 {name}…", { name: esc(file.name) }) : t("正在分析…")) + "</div>";
    try {
      const r = file
        ? await fetch("/api/custom/upload?name=" + encodeURIComponent(file.name || "program"), { method: "POST", body: file }).then((x) => x.json())
        : await cpost("/api/custom/analyze", { path: pathStr });
      if (!r.ok) { wiz.innerHTML = '<div class="tiny err">' + esc(r.message || "") + "</div>"; return; }
      cust.rep = r; renderCustomWiz();
    } catch (e) { wiz.innerHTML = '<div class="tiny err">' + esc(e.message) + "</div>"; }
    finally { cust.busy = false; }
  }
  function renderCustomWiz() {
    const r = cust.rep, wiz = $("custom-wiz");
    if (!r) { wiz.innerHTML = ""; return; }
    const ok = new Set(["glibc", "bionic", "static", "script"]);
    const rows = r.programs.map((p, i) => {
      const can = ok.has(p.kind);
      const clash = p.clash === "toolkit" ? t("工具包里已有同名命令，换个名字") : p.clash === "custom" ? t("别的自定义组件占了这个名字") : p.clash === "bad" ? t("改个名字（只能用字母、数字和 ._+-）") : "";
      return '<div class="cu-prog' + (can ? "" : " dim") + '" data-i="' + i + '">' +
        '<label class="cu-row"><input type="checkbox" class="cu-on"' + (can ? "" : " disabled") + (can && p.suggest && !p.clash ? " checked" : "") + "> <code>" + esc(p.rel) + "</code>" +
        ' <span class="tiny">' + esc(KIND()[p.kind] || p.kind) + "</span></label>" +
        (can ? '<div class="cu-row tiny">' + t("命令名") + ' <input class="cu-cmd" value="' + esc(p.cmd) + '" spellcheck="false" autocapitalize="off">' +
          (p.kind === "glibc" && r.gpu ? ' <label><input type="checkbox" class="cu-gpu"> ' + t("用 GPU") + "</label>" : "") +
          (p.kind === "glibc" ? ' <label title="' + esc(t("直接改程序的解释器，不经加载器启动。程序按自身位置找数据文件时用")) + '"><input type="checkbox" class="cu-pe"> patchelf</label>' : "") + "</div>" : "") +
        (clash && can ? '<div class="tiny warn">' + clash + "</div>" : "") +
        (p.why ? '<div class="tiny warn">' + esc(p.why) + "</div>" : "") +
        (p.missing.length ? '<div class="tiny dim">' + t("缺：{libs}", { libs: esc(p.missing.join(", ")) }) + "</div>" : "") + "</div>";
    }).join("");
    const fix = r.fixable.length ? '<div class="tiny">' + t("会从 Termux glibc 仓库补这些库（约 {size}）：{libs}", { size: MB(r.fixable.reduce((a, f) => a + f.size, 0)), libs: esc([...new Set(r.fixable.map((f) => f.soname))].join(", ")) }) + "</div>" : "";
    const unres = r.unresolved.length ? '<div class="tiny warn">' + t("这些库找不到来源，用到它们的程序可能跑不起来：{libs}", { libs: esc(r.unresolved.join(", ")) }) + "</div>" : "";
    wiz.innerHTML = '<div class="cu-wiz">' +
      '<div class="tiny">' + t("{src}：{n} 个文件，{size}", { src: esc(r.source), n: r.files, size: MB(r.bytes) }) + "</div>" +
      '<div class="cu-row"><span class="tiny">' + t("名称") + '</span> <input id="cu-name" value="' + esc(r.name) + '"></div>' +
      '<div class="cu-row"><span class="tiny">ID</span> <input id="cu-id" value="' + esc(r.id) + '" spellcheck="false" autocapitalize="off"></div>' +
      '<div class="cu-row"><span class="tiny">' + t("说明") + '</span> <input id="cu-desc" placeholder="' + esc(t("可选：它是干什么的，Claude 会看到")) + '"></div>' +
      '<div class="tiny">' + t("要用哪些命令") + "</div>" + rows + fix + unres +
      r.warnings.map((w) => '<div class="tiny warn">' + esc(w) + "</div>").join("") +
      '<div class="tiny dim">' + t("程序来源由你负责：它能读写本应用里的所有文件。") + "</div>" +
      '<div class="it-acts"><button class="btn sm" data-cu="install">' + t("安装") + '</button><button class="btn ghost sm" data-cu="discard">' + t("取消") + "</button></div></div>";
  }
  $("custom-pick").addEventListener("click", () => $("custom-file").click());
  $("custom-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) customAnalyze(f); });
  $("custom-path-go").addEventListener("click", () => { const p = $("custom-path").value.trim(); if (p) customAnalyze(null, p); });
  $("custom-field").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-cu]"); if (!b || b.disabled) return;
    const a = b.dataset.cu;
    if (a === "discard") { if (cust.rep) cpost("/api/custom/discard", { stage: cust.rep.stage }).catch(() => {}); cust.rep = null; return renderCustomWiz(); }
    if (a === "install") {
      const r = cust.rep, entries = [];
      for (const d of document.querySelectorAll("#custom-wiz .cu-prog")) {
        if (!d.querySelector(".cu-on")?.checked) continue;
        const p = r.programs[+d.dataset.i];
        entries.push({ rel: p.rel, cmd: d.querySelector(".cu-cmd").value.trim(), gpu: !!d.querySelector(".cu-gpu")?.checked, patchelf: !!d.querySelector(".cu-pe")?.checked });
      }
      if (!entries.length) return toast(t("至少选一个要用的命令"), true);
      b.disabled = true; b.textContent = r.fixable.length ? t("正在补库并安装…") : t("正在安装…");
      const x = await cpost("/api/custom/install", { stage: r.stage, id: $("cu-id").value.trim(), name: $("cu-name").value.trim(), desc: $("cu-desc").value.trim(), entries })
        .catch((err) => ({ ok: false, message: err.message }));
      if (!x.ok) { b.disabled = false; b.textContent = t("安装"); return toast(t("失败：{msg}", { msg: x.message || "" }), true); }
      cust.rep = null; renderCustomWiz();
      toast(x.unresolved && x.unresolved.length ? t("已安装，但还缺 {n} 个库", { n: x.unresolved.length }) : t("已安装，Claude 和终端里都能用了"), !!(x.unresolved && x.unresolved.length));
      return loadCustom();
    }
    if (a === "remove") {
      const nm = (b.closest(".item")?.querySelector(".it-title")?.textContent || b.dataset.id).trim();
      if (!confirm(t("卸载自定义组件 {name}？会删掉导入的程序、补进来的库和它的命令。", { name: nm }))) return;
      b.disabled = true;
      const x = await cpost("/api/custom/remove", { id: b.dataset.id }).catch((err) => ({ ok: false, message: err.message }));
      toast(x.ok ? t("已卸载") : t("失败：{msg}", { msg: x.message || "" }), !x.ok);
      return loadCustom();
    }
    if (a === "try") {
      const out = $("cu-out-" + b.dataset.id); b.disabled = true;
      out.classList.remove("hidden"); out.textContent = "$ " + b.dataset.cmd + " --version\n…";
      const x = await cpost("/api/custom/try", { id: b.dataset.id, cmd: b.dataset.cmd }).catch((err) => ({ ok: false, output: err.message }));
      out.textContent = "$ " + b.dataset.cmd + "\n" + (x.output || t("（没有输出，退出码 {c}）", { c: x.code }));
      out.classList.toggle("err", !x.ok);
      b.disabled = false;
    }
  });

  // ── llama-cpp 组件下的「下载模型」子卡：内置目录按家族折叠（网关里固定 sha256），一键下载 / 取消 / 删除；也能贴 .gguf 直链 ──
  const llmDl = { open: false, html: "", timer: 0, fam: new Set(), items: new Map(), big: 6, url: "" };
  async function loadLlmDl() {
    clearTimeout(llmDl.timer);
    const r = await api("/api/local/catalog").catch((e) => ({ items: [], err: e.message }));
    const GB = (n) => (n / 1073741824).toFixed(1) + " GB";
    const TAG = { think: t("会先思考"), code: t("偏写代码") };
    llmDl.big = r.big || 6;
    llmDl.items = new Map((r.items || []).map((m) => [m.id, m]));
    const row = (m) => {
      const j = m.job;
      let st = "", act = "";
      if (j && (j.phase === "downloading" || j.phase === "verifying")) {
        const pct = j.total ? Math.min(100, (j.done / j.total) * 100).toFixed(1) : 0;
        st = (j.total ? '<div class="comp-bar"><i style="width:' + pct + '%"></i></div>' : "") +
          '<div class="tiny">' + (j.phase === "verifying" ? t("校验中") : t("下载中")) + " " + GB(j.done) + (j.total ? " / " + GB(j.total) : "") + "</div>";
        act = '<button class="btn sm ghost" data-lm="cancel" data-id="' + esc(m.id) + '">' + t("取消") + "</button>";
      } else if (m.have) {
        st = '<span class="tiny">' + t("已下载") + (m.inUse ? " · " + t("正在使用") : "") + "</span>";
        act = '<button class="btn sm ghost" data-lm="remove" data-id="' + esc(m.id) + '">' + t("删除") + "</button>";
      } else {
        if (j && j.phase === "error") st = '<div class="tiny err">' + t("下载失败：{msg}", { msg: esc(j.err) }) + "</div>";
        act = '<button class="btn sm' + (m.params > llmDl.big ? " ghost" : "") + '" data-lm="download" data-id="' + esc(m.id) + '">' + (j ? t("重试") : t("下载")) + "</button>" +
          (m.custom ? '<button class="btn sm ghost" data-lm="cancel" data-id="' + esc(m.id) + '">' + t("移除") + "</button>" : "");
      }
      const info = m.custom ? '<span class="tiny dim">' + esc(m.repo) + "</span>"
        : '<span class="tiny">' + m.params + "B · " + GB(m.bytes) + "</span>" + (m.tag ? ' <span class="tiny dim">' + TAG[m.tag] + "</span>" : "") +
          (m.params > llmDl.big ? ' <span class="tiny warn">' + t("偏大") + "</span>" : "");
      return '<div class="llm-item"><div class="llm-row"><code>' + esc(m.id) + "</code> " + info + '<span class="llm-act">' + act + "</span></div>" + st + "</div>";
    };
    const fams = [];
    for (const m of r.items || []) if (!m.custom && !fams.includes(m.fam)) fams.push(m.fam);
    const custom = (r.items || []).filter((m) => m.custom);
    llmDl.html = '<div class="tiny dim">' + t("模型放在 /sdcard/cccodroid/models，下好后到 设置 → 模型服务 → 端侧小模型 使用。本机内存 {ram} GB。都是 Q4_K_M 量化；手机上 1–4B 比较实用，超过 6B 会很慢。", { ram: r.ram || "?" }) + "</div>" +
      (r.err ? '<div class="tiny err">' + esc(r.err) + "</div>" : "") +
      fams.map((f) => {
        const list = r.items.filter((m) => !m.custom && m.fam === f);
        const n = list.filter((m) => m.have).length, busy = list.some((m) => m.job && m.job.phase !== "error");
        return '<details class="llm-fam" data-fam="' + esc(f) + '"' + (llmDl.fam.has(f) || busy ? " open" : "") + "><summary>" + esc(f) +
          ' <span class="tiny dim">' + list.length + (n ? " · " + t("已下载 {n}", { n }) : "") + "</span></summary>" + list.map(row).join("") + "</details>";
      }).join("") +
      custom.map(row).join("") +
      '<div class="llm-url"><div class="tiny dim">' + t("目录里没有的：贴一个 .gguf 文件的下载链接（HuggingFace / 魔搭等）。不校验哈希，只核对文件头。") + "</div>" +
      '<div class="llm-url-row"><input type="url" id="llm-url" placeholder="https://huggingface.co/…/resolve/main/xxx.gguf" value="' + esc(llmDl.url) + '">' +
      '<button class="btn sm" data-lm="url">' + t("下载") + "</button></div></div>";
    // 输入框里正打着字就别整块重绘（会丢光标）：只更新上面的列表
    const body = $("llm-dl-body");
    if (body) {
      const typing = document.activeElement && document.activeElement.id === "llm-url";
      if (typing) { const box = document.createElement("div"); box.innerHTML = llmDl.html; box.querySelector(".llm-url").replaceWith(body.querySelector(".llm-url")); body.replaceChildren(...box.childNodes); }
      else body.innerHTML = llmDl.html;
      body.querySelectorAll(".llm-fam").forEach((d) => d.addEventListener("toggle", () => { d.open ? llmDl.fam.add(d.dataset.fam) : llmDl.fam.delete(d.dataset.fam); }));
      const inp = $("llm-url"); if (inp) inp.addEventListener("input", () => { llmDl.url = inp.value; });
    }
    const busy = (r.items || []).some((m) => m.job && m.job.phase !== "error");
    if (busy && llmDl.open && $("llm-dl") && pageOn("ext"))
      llmDl.timer = setTimeout(loadLlmDl, 1000);
  }
  $("tab-ext").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-lm]");
    if (!b || b.disabled) return;
    const op = b.dataset.lm, id = b.dataset.id, m = llmDl.items.get(id);
    if (op === "remove" && !confirm(t("删除模型 {name}？", { name: id }))) return;
    if (op === "download" && m && m.params > llmDl.big && !confirm(t("{name} 约 {p}B 参数、{size}。手机上会很慢，内存也可能不够。仍然下载？", { name: id, p: m.params, size: (m.bytes / 1073741824).toFixed(1) + " GB" }))) return;
    const body = { op, id };
    if (op === "url") {
      body.url = ($("llm-url") && $("llm-url").value.trim()) || "";
      if (!body.url) return toast(t("先贴链接"), true);
    }
    b.disabled = true;
    const r = await post("/api/local/model", body).catch((er) => ({ ok: false, message: er.message }));
    if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
    else if (op === "url") llmDl.url = "";
    if (op === "url" && $("llm-url")) $("llm-url").blur();
    loadLlmDl();
  });

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
    if (ghAuth.polling && box && pageOn("ext"))
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
      `<div class="tiny ext-desc">${esc(!isZh() && s.descEn ? s.descEn : s.description)}</div>`, [s.component ? "comp" : s.official ? "official" : "user"])).join("")
      || `<div class="tiny">${t("~/.claude/skills 里还没有技能。插件也可能自带技能。")}</div>`;
    renderIdx("skill", [["official", t("官方")], ["comp", t("组件自带")], ["user", t("自己装的")]]);
    if ($("ext-s-catbox").open) loadSkillCat();
  }

  // ── Hooks（自动规则）：到某个时刻自动跑一条命令。常用规则点一下就加，也能自己写；每条都能先试运行看效果 ──
  const HK = { data: null, scope: localStorage.getItem("cc.hookScope") || "user", edit: null, recipe: null };
  const HK_EV = {
    PreToolUse: [tk("用工具之前"), tk("Claude 每次调用工具（改文件、跑命令、联网……）之前。退出码 2 会拦下这次调用，stderr 里写的原因会转告 Claude。")],
    PostToolUse: [tk("用完工具之后"), tk("工具执行成功之后。适合格式化、记录、检查；动作已经做了，退出码 2 只会把 stderr 反馈给 Claude。")],
    UserPromptSubmit: [tk("你发出消息时"), tk("你每发一条消息。命令打印的内容会作为补充说明一起交给 Claude；退出码 2 会拦下这条消息。")],
    Stop: [tk("Claude 答完一轮时"), tk("Claude 这一轮回答结束。适合自动存档、提醒；退出码 2 会让它接着干（小心死循环）。")],
    SessionStart: [tk("会话开始时"), tk("新开、继续、清空或压缩后的会话开始时。命令打印的内容会作为背景交给 Claude。")],
    SessionEnd: [tk("会话结束时"), tk("会话结束时，适合收尾清理。")],
    Notification: [tk("Claude 发提醒时"), tk("Claude 要你确认权限、或者闲着等你回复时。")],
    PermissionRequest: [tk("要你确认权限时"), tk("弹出权限确认之前。进阶用法：输出 JSON 可以替你自动允许或拒绝。")],
    PostToolUseFailure: [tk("工具出错之后"), tk("工具执行失败之后。")],
    SubagentStart: [tk("子代理开始时"), ""],
    SubagentStop: [tk("子代理结束时"), tk("子代理干完活时；退出码 2 会让它接着干。")],
    PreCompact: [tk("压缩上下文之前"), ""],
    PostCompact: [tk("压缩上下文之后"), ""],
  };
  const hkEvName = (ev) => (HK_EV[ev] ? t(HK_EV[ev][0]) : ev);
  const HK_TOOL_EV = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
  const HK_MATCH_CHIPS = {
    tool: ["Bash", "Edit|Write|MultiEdit", "Read", "WebFetch|WebSearch", "mcp__.*"],
    SessionStart: ["startup", "resume", "clear", "compact"],
    PreCompact: ["manual", "auto"], PostCompact: ["manual", "auto"],
    Notification: ["permission_prompt", "idle_prompt"],
  };
  const hkChips = (ev) => (HK_TOOL_EV.includes(ev) ? HK_MATCH_CHIPS.tool : HK_MATCH_CHIPS[ev]);
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  /** 把命令拆成参数（认单引号、双引号、反斜杠），用来从常用规则的命令里取回参数 */
  function shArgs(cmd) {
    const out = []; let cur = null, q = "";
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (q === "'") { if (c === "'") q = ""; else cur += c; continue; }
      if (q === '"') { if (c === '"') q = ""; else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i]; else cur += c; continue; }
      if (/\s/.test(c)) { if (cur != null) out.push(cur); cur = null; continue; }
      if (cur == null) cur = "";
      if (c === "'" || c === '"') q = c; else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i]; else cur += c;
    }
    if (cur != null) out.push(cur);
    return out;
  }
  const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const hkScript = (name) => `node "$HOME/.claude/hooks/${name}"`;
  const HK_RECIPES = [
    { id: "guard-files", title: tk("保护重要文件"), desc: tk("Claude 想改 .env、密钥、签名文件时直接拦下，并告诉它原因。"),
      event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", script: "cc-guard-files.mjs",
      label: tk("受保护的文件（一行一个；* 是通配符，带 / 就按路径比）"), param: ".env\n.env.*\n*.pem\n*.key\n*.keystore\n*.jks\nid_rsa*\nid_ed25519*",
      cmd: (p) => hkScript("cc-guard-files.mjs") + " " + lines(p).map(shq).join(" "), back: (a) => a.slice(2).join("\n") },
    { id: "guard-bash", title: tk("拦下危险命令"), desc: tk("命令里出现强推、硬重置、删根目录这类内容就不让跑，并告诉 Claude 换个做法。"),
      event: "PreToolUse", matcher: "Bash", script: "cc-guard-bash.mjs",
      label: tk("禁止的内容（一行一个；写成 /…/ 就是正则）"),
      param: "git push --force\ngit push -f\n/git\\s+reset\\s+--hard/\n/\\brm\\s+-\\w*[rR]\\w*\\s+(\\/|~\\/?|\\$HOME\\/?)(\\s|$)/\nmkfs\n/\\bdd\\s+if=/",
      cmd: (p) => hkScript("cc-guard-bash.mjs") + " " + lines(p).map(shq).join(" "), back: (a) => a.slice(2).join("\n") },
    { id: "autosave", title: tk("每轮自动存档（git）"), desc: tk("Claude 每答完一轮，项目里有改动就自动提交一次，随时能退回任意一步。只提交不推送；不是 git 仓库的项目什么也不做。"),
      event: "Stop", matcher: "", script: "cc-autosave.mjs", single: true, label: tk("提交说明的开头"), param: tk("自动存档"),
      cmd: (p) => hkScript("cc-autosave.mjs") + " " + shq(String(p).trim() || t("自动存档")), back: (a) => a[2] || "" },
    { id: "prompt-note", title: tk("每条消息附上固定要求"), desc: tk("你每发一条消息，自动把这段话一起交给 Claude，比如「回答用中文」「改之前先说思路」。"),
      event: "UserPromptSubmit", matcher: "", label: tk("要附上的话"), param: tk("回答用中文；动手改之前先简单说一下打算怎么做。"),
      cmd: (p) => "printf '%s\\n' " + shq(String(p).trim()), test: (c) => /^printf '%s\\n' /.test(c), back: (a) => a[2] || "" },
    { id: "session-file", title: tk("开会话时读入进度文件"), desc: tk("每次开新会话（或压缩上下文后），把项目里的一个文件读给 Claude，比如进度、大纲、人物表。文件不存在就跳过。"),
      event: "SessionStart", matcher: "", single: true, label: tk("文件（相对项目目录）"), param: tk("进度.md"),
      cmd: (p) => "cat " + shq(String(p).trim()) + " 2>/dev/null || true", test: (c) => /^cat '.*' 2>\/dev\/null \|\| true$/.test(c), back: (a) => a[1] || "" },
    { id: "bash-log", title: tk("记下 Claude 跑过的命令"), desc: tk("每条命令连同时间、目录追加到 ~/.claude/bash-history.log，方便事后翻看。"),
      event: "PostToolUse", matcher: "Bash", script: "cc-bash-log.mjs", cmd: () => hkScript("cc-bash-log.mjs") },
    { id: "format", title: tk("改完代码自动格式化"), desc: tk("Claude 改完代码文件，用本机已装的工具（ruff / black、prettier、gofmt、clang-format……）整理格式；没装就不动。Markdown 和纯文本不碰。"),
      event: "PostToolUse", matcher: "Edit|Write|MultiEdit", script: "cc-format.mjs", cmd: () => hkScript("cc-format.mjs") },
  ];
  const hkRecipeOf = (ev, h) => h && h.type === "command" && HK_RECIPES.find((r) => r.event === ev &&
    (r.script ? String(h.command).includes(r.script) : r.test(String(h.command))));
  const hkScopeData = () => HK.data && HK.data.scopes.find((s) => s.scope === HK.scope);
  const hkFlat = (sc) => {
    const out = [];
    for (const [ev, groups] of Object.entries((sc && sc.hooks) || {}))
      (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => out.push({ ev, gi, hi, matcher: g.matcher || "", h })));
    return out;
  };

  async function loadExtHooks() {
    let d;
    try { d = await api("/api/ext/hooks"); } catch (e) { $("ext-hooks").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    HK.data = d;
    if (!d.scopes.some((s) => s.scope === HK.scope)) HK.scope = "user";
    renderHooks();
  }

  function renderHooks() {
    const d = HK.data; if (!d) return;
    const total = d.scopes.reduce((a, s) => a + hkFlat(s).length, 0);
    $("ext-h-count").textContent = total;
    const proj = String(d.dir || "").split("/").pop() || d.dir;
    const SC = { user: t("所有项目"), project: t("本项目（{name}）", { name: proj }), local: t("本项目·只在本机") };
    $("hook-scope").innerHTML = d.scopes.map((s) =>
      `<button class="idx-chip${s.scope === HK.scope ? " on" : ""}" data-hscope="${s.scope}">${esc(SC[s.scope])}<span>${hkFlat(s).length}</span></button>`).join("");
    const sc = hkScopeData();
    const user = d.scopes.find((s) => s.scope === "user");
    const SCD = {
      user: t("写在 ~/.claude/settings.json，所有项目都生效。"),
      project: t("写在项目的 .claude/settings.json，只在这个项目生效；项目进了 git 的话会跟着仓库走。"),
      local: t("写在项目的 .claude/settings.local.json，只在这个项目、这台设备上生效。"),
    };
    $("hook-bar").innerHTML = `<div class="tiny">${esc(SCD[HK.scope])}
        ${sc && sc.file ? `<a href="#" data-hk="open-file">${t("打开配置文件")}</a>` : ""}</div>
      <label class="tiny hk-pause"><input type="checkbox" data-hk="pause"${user && user.disableAll ? " checked" : ""}> ${t("暂停全部 hooks（规则留着，先不跑）")}</label>`;
    if (!sc || sc.error && !sc.badJson) { $("ext-hooks").innerHTML = `<div class="tiny warn">${esc((sc && sc.error) || "")}</div>`; return; }
    if (sc.badJson) {
      $("ext-hooks").innerHTML = `<div class="tiny warn">${esc(t("这个配置文件不是合法的 JSON（{msg}），先打开修好，这里才能改。", { msg: sc.error }))}</div>`;
      return;
    }
    const items = hkFlat(sc);
    $("ext-hooks").innerHTML = items.map((it, i) => {
      const r = hkRecipeOf(it.ev, it.h);
      const title = r ? t(r.title) : hkEvName(it.ev);
      const meta = [r ? hkEvName(it.ev) : it.ev, it.matcher ? t("匹配：{m}", { m: it.matcher }) : "", it.h.timeout ? t("超时 {n} 秒", { n: it.h.timeout }) : ""].filter(Boolean);
      const body = it.h.type === "command" ? it.h.command : JSON.stringify(it.h);
      return `<div class="item hk-item${user && user.disableAll ? " off" : ""}" data-i="${i}">
        <div class="it-title">${esc(title)}</div>
        <div class="it-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
        <div class="hk-cmd mono">${esc(body)}</div>
        <div class="it-acts">${it.h.type === "command" ? `<button data-hk="test">${t("试运行")}</button><button data-hk="edit">${t("修改")}</button>` : ""}
          <button data-hk="del">${t("删除")}</button></div>
        <div class="hk-out"></div></div>`;
    }).join("") || `<div class="tiny">${t("这里还没有规则。下面「常用规则」点一下就能加。")}</div>`;
    $("hook-recipes").innerHTML = HK_RECIPES.map((r) => extItem(esc(t(r.title)), `<span>${esc(hkEvName(r.event))}</span>`,
      `<button data-hk="recipe" data-id="${r.id}">${t("添加…")}</button>`, `<div class="tiny ext-desc">${esc(t(r.desc))}</div>`)).join("");
    if (!items.length && !HK.edit && !HK.recipe) $("hook-recipes-box").open = true;
  }

  /** 表单：新建 / 修改 / 从常用规则添加。常用规则只填参数，命令自动拼好（也能直接改命令） */
  function hkForm(init) {
    const box = $("hook-form-box"), f = $("hook-form");
    box.open = true;
    const r = HK.recipe;
    const evs = HK.data.events;
    const main = Object.keys(HK_EV).filter((e) => evs.includes(e));
    const more = evs.filter((e) => !main.includes(e));
    if (init.event && !evs.includes(init.event)) more.push(init.event);
    f.innerHTML = `
      ${r ? `<div class="hk-rtitle">${esc(t(r.title))}</div><div class="tiny">${esc(t(r.desc))}</div>` : ""}
      <label class="tiny">${t("什么时候跑")}</label>
      <select data-f="event">${main.map((e) => `<option value="${e}">${esc(hkEvName(e))} · ${e}</option>`).join("")}
        ${more.length ? `<optgroup label="${esc(t("其他（进阶）"))}">${more.map((e) => `<option value="${e}">${e}</option>`).join("")}</optgroup>` : ""}</select>
      <div class="tiny hk-evdesc"></div>
      <div class="hk-match"><label class="tiny hk-mlabel"></label>
        <input data-f="matcher" autocomplete="off" spellcheck="false" placeholder="${esc(t("留空 = 全部"))}">
        <div class="hk-chips"></div></div>
      ${r && r.label ? `<label class="tiny">${esc(t(r.label))}</label>
        ${r.single ? `<input data-f="param" autocomplete="off" spellcheck="false">` : `<textarea data-f="param" rows="5" class="mono" spellcheck="false"></textarea>`}` : ""}
      <label class="tiny">${t("运行的命令")}${r ? ` <span class="hk-auto">${t("（按上面自动生成，也可以直接改）")}</span>` : ""}</label>
      <textarea data-f="command" rows="3" class="mono" spellcheck="false" autocapitalize="off" placeholder="${esc(t("例如：echo 你好 >> ~/log.txt"))}"></textarea>
      <div class="hk-row"><label class="tiny">${t("超时（秒，留空用默认 60）")}</label><input data-f="timeout" type="number" min="1" max="600" inputmode="numeric"></div>
      <div class="row-actions"><button class="btn sm ghost" data-hk="f-test">${t("试运行")}</button>
        <button class="btn sm" data-hk="f-save">${HK.edit ? t("保存修改") : t("添加")}</button>
        <button class="btn sm ghost" data-hk="f-cancel">${t("取消")}</button></div>
      <div class="hk-out"></div>`;
    const q = (k) => f.querySelector(`[data-f="${k}"]`);
    q("event").value = init.event || "PreToolUse";
    q("matcher").value = init.matcher || "";
    q("command").value = init.command || "";
    q("timeout").value = init.timeout || "";
    if (q("param")) q("param").value = init.param != null ? init.param : t(r.param);
    const sync = () => {
      const ev = q("event").value, chips = hkChips(ev);
      f.querySelector(".hk-evdesc").textContent = HK_EV[ev] ? t(HK_EV[ev][1]) : "";
      f.querySelector(".hk-match").classList.toggle("hidden", !chips && !q("matcher").value);
      f.querySelector(".hk-mlabel").textContent = HK_TOOL_EV.includes(ev) ? t("管哪些工具（工具名，可用 | 分隔或写正则；留空 = 全部）") : t("只在这几种情况跑（留空 = 全部）");
      f.querySelector(".hk-chips").innerHTML = (chips || []).map((c) => `<button type="button" class="idx-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("");
    };
    q("event").addEventListener("change", sync);
    if (q("param")) q("param").addEventListener("input", () => { q("command").value = r.cmd(q("param").value); });
    if (r && !init.command) q("command").value = r.cmd(q("param") ? q("param").value : "");
    sync();
    box.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  const hkFormVal = () => {
    const f = $("hook-form"), q = (k) => f.querySelector(`[data-f="${k}"]`);
    const to = parseInt(q("timeout").value, 10);
    return { event: q("event").value, matcher: q("matcher").value.trim(), command: q("command").value.trim(), timeout: to > 0 ? to : 0 };
  };
  function hkCloseForm() { HK.edit = null; HK.recipe = null; $("hook-form").innerHTML = ""; $("hook-form-box").open = false; }

  async function hkSave(hooks, extra) {
    const sc = hkScopeData();
    const r = await api("/api/ext/hooks/save", { method: "POST", body: JSON.stringify({ scope: HK.scope, dir: HK.data.dir, hooks, ...extra }) });
    if (r.ok === false) {
      toast(r.code === "badjson" ? t("这个配置文件不是合法的 JSON（{msg}），先打开修好，这里才能改。", { msg: r.message }) : t("保存失败：{msg}", { msg: r.message }), true);
      return false;
    }
    toast(t("已保存，下一条消息生效"));
    await loadExtHooks();
    return !!sc;
  }
  const hkClone = () => JSON.parse(JSON.stringify((hkScopeData() || {}).hooks || {}));

  /** 试运行结果：按事件和退出码说人话 */
  function hkShowResult(box, res, ev, cmd, matcher, timeout) {
    const blockEv = ["PreToolUse", "PermissionRequest", "UserPromptSubmit"].includes(ev);
    const ctxEv = ["UserPromptSubmit", "SessionStart"].includes(ev);
    let v, cls = "ok";
    if (res.timedOut) { v = t("超时了，命令没跑完就被停掉。"); cls = "warn"; }
    else if (res.code === 0) v = ctxEv && res.stdout.trim() ? t("正常结束：打印的内容会作为补充说明交给 Claude。") : blockEv ? t("放行：Claude 照常继续。") : t("正常结束。");
    else if (res.code === 2) { v = blockEv ? t("拦下（退出码 2）：Claude 这一步不会执行，stderr 里的话会转告它。") : ev === "Stop" || ev === "SubagentStop" ? t("退出码 2：Claude 会接着干，stderr 里的话会转告它。") : t("退出码 2：stderr 里的话会反馈给 Claude。"); cls = "warn"; }
    else { v = t("出错了（退出码 {n}）：不会拦下，Claude 照常继续。", { n: res.code }); cls = "err"; }
    const pre = (label, s) => s.trim() ? `<div class="tiny">${label}</div><pre class="hk-pre">${esc(s.slice(0, 4000))}</pre>` : "";
    box.innerHTML = `<div class="hk-verdict ${cls}">${esc(v)} <span class="tiny">${res.ms} ms</span></div>
      ${pre(t("输出（stdout）"), res.stdout)}${pre(t("错误输出（stderr）"), res.stderr)}
      <details class="ext-more"><summary>${t("模拟的输入（可以改了再试）")}</summary>
        <textarea class="mono hk-input" rows="8" spellcheck="false">${esc(res.input)}</textarea>
        <button class="btn sm ghost" data-hk="retest">${t("再试一次")}</button></details>`;
    box.querySelector('[data-hk="retest"]').onclick = (e) => { e.preventDefault(); hkRunTest(box, ev, cmd, matcher, timeout, box.querySelector(".hk-input").value); };
  }
  async function hkRunTest(box, ev, cmd, matcher, timeout, input) {
    if (!cmd) return toast(t("命令是空的"), true);
    box.innerHTML = `<div class="tiny">${t("运行中…")}</div>`;
    if (/\$HOME\/\.claude\/hooks\/cc-/.test(cmd)) await api("/api/ext/hooks/scripts", { method: "POST", body: "{}" }).catch(() => {});
    try {
      const res = await api("/api/ext/hooks/test", { method: "POST", body: JSON.stringify({ command: cmd, event: ev, matcher, timeout, input, dir: HK.data.dir }) });
      if (res.ok === false) throw new Error(res.message);
      hkShowResult(box, res, ev, cmd, matcher, timeout);
    } catch (e) { box.innerHTML = `<div class="tiny warn">${esc(e.message)}</div>`; }
  }

  $("ext-hook-sec").addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-hscope]");
    if (chip) { HK.scope = chip.dataset.hscope; localStorage.setItem("cc.hookScope", HK.scope); hkCloseForm(); return renderHooks(); }
    const mc = e.target.closest("[data-chip]");
    if (mc) {
      const inp = $("hook-form").querySelector('[data-f="matcher"]');
      const cur = inp.value.split("|").filter(Boolean);
      for (const p of mc.dataset.chip.split("|")) if (!cur.includes(p)) cur.push(p);
      inp.value = cur.join("|");
      return;
    }
    const b = e.target.closest("[data-hk]");
    if (!b || b.dataset.hk === "pause") return;
    e.preventDefault();
    const a = b.dataset.hk;
    const items = hkFlat(hkScopeData());
    const it = b.closest(".hk-item") ? items[+b.closest(".hk-item").dataset.i] : null;
    if (a === "open-file") { const sc = hkScopeData(); return openViewer(sc.file, "text", 0); }
    if (a === "test" && it) return hkRunTest(b.closest(".hk-item").querySelector(".hk-out"), it.ev, it.h.command, it.matcher, it.h.timeout);
    if (a === "del" && it) {
      if (!confirm(t("删除这条规则？"))) return;
      const h = hkClone();
      h[it.ev][it.gi].hooks.splice(it.hi, 1);
      return hkSave(h);
    }
    if (a === "edit" && it) {
      HK.edit = { ev: it.ev, gi: it.gi, hi: it.hi };
      HK.recipe = hkRecipeOf(it.ev, it.h) || null;
      const param = HK.recipe && HK.recipe.back ? HK.recipe.back(shArgs(it.h.command)) : undefined;
      return hkForm({ event: it.ev, matcher: it.matcher, command: it.h.command, timeout: it.h.timeout, param });
    }
    if (a === "recipe") {
      HK.edit = null;
      HK.recipe = HK_RECIPES.find((r) => r.id === b.dataset.id);
      return hkForm({ event: HK.recipe.event, matcher: HK.recipe.matcher });
    }
    if (a === "f-cancel") return hkCloseForm();
    if (a === "f-test") { const v = hkFormVal(); return hkRunTest($("hook-form").querySelector(".hk-out"), v.event, v.command, v.matcher, v.timeout); }
    if (a === "f-save") {
      const v = hkFormVal();
      if (!v.command) return toast(t("命令是空的"), true);
      if (/\$HOME\/\.claude\/hooks\/cc-/.test(v.command)) await api("/api/ext/hooks/scripts", { method: "POST", body: "{}" }).catch(() => {});
      const h = hkClone();
      const entry = { type: "command", command: v.command };
      if (v.timeout) entry.timeout = v.timeout;
      if (HK.edit) {
        const old = h[HK.edit.ev][HK.edit.gi];
        const keep = old.hooks[HK.edit.hi];
        // 事件、匹配都没变就原地换；变了就从原组里摘掉，按新的事件 / 匹配放
        if (HK.edit.ev === v.event && (old.matcher || "") === v.matcher) { const nh = { ...keep, ...entry }; if (!v.timeout) delete nh.timeout; old.hooks[HK.edit.hi] = nh; }
        else { old.hooks.splice(HK.edit.hi, 1); hkPut(h, v, entry); }
      } else hkPut(h, v, entry);
      if (await hkSave(h)) hkCloseForm();
    }
  });
  $("ext-hook-sec").addEventListener("change", async (e) => {
    if (e.target.dataset.hk !== "pause") return;
    const on = e.target.checked;
    const r = await api("/api/ext/hooks/save", { method: "POST", body: JSON.stringify({ scope: "user", disableAll: on }) });
    if (r.ok === false) { e.target.checked = !on; return toast(t("保存失败：{msg}", { msg: r.message }), true); }
    toast(on ? t("已暂停全部 hooks") : t("hooks 已恢复"));
    loadExtHooks();
  });
  /** 放进事件下匹配规则相同的那组（没有就新开一组） */
  function hkPut(h, v, entry) {
    const groups = h[v.event] || (h[v.event] = []);
    let g = groups.find((x) => (x.matcher || "") === v.matcher);
    if (!g) { g = v.matcher ? { matcher: v.matcher, hooks: [] } : { hooks: [] }; groups.push(g); }
    g.hooks.push(entry);
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
    // 文件选择器不限类型（群里转来的 zip 常被标成别的类型，限了就选不中）；可一次选多个，zip 里有几个技能装几个
    const list = [...(e.target.files || [])]; e.target.value = "";
    if (!list.length) return;
    const ok = [], bad = [];
    for (const f of list) {
      const r = await api("/api/ext/skills/import", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: await f.arrayBuffer() })
        .catch((err) => ({ ok: false, message: err.message }));
      if (r.ok) ok.push(...(r.dirs || [r.dir]));
      else bad.push(`${f.name}：${r.message || ""}`);
      for (const x of r.skipped || []) bad.push(`${x.name}：${x.why}`);
    }
    if (ok.length) toast(t("已安装技能 {name}", { name: ok.join("、") }) + (bad.length ? "\n" + t("未装：{msg}", { msg: bad.join("；") }) : ""), !!bad.length);
    else toast(t("安装失败：{msg}", { msg: bad.join("；") }), true);
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
  // 到 GitHub 反馈：网关拼好链接（设备、ROM、自检、组件），先给用户看要填进去的内容，再用外部浏览器打开
  $("btn-issue").addEventListener("click", async () => {
    let r;
    try { r = await api("/api/issue-draft"); } catch (e) { return toast(e.message, true); }
    const dev = r.body.slice(r.body.indexOf("### Device"), r.body.indexOf("<sub>")).trim();
    if (!confirm(t("将打开 GitHub 的新建 Issue 页面，下面这些会预先填好，提交前还能改：") + "\n\n" + (dev.length > 1500 ? dev.slice(0, 1500) + "…" : dev))) return;
    openExternal(r.url);
  });
  // 状态对账：组件 / 模块 / 包清单 / 自定义组件的记录和磁盘对一遍（网关启动后自动核过一次，这里看结果或再核）
  function paintReconcile(r, always) {
    const box = $("reconcile-box"), bad = (r.findings || []).filter((f) => f.level !== "info");
    if (!r.supported || (!always && !bad.length)) return box.classList.add("hidden");
    const head = r.at ? `<div class="tiny">${esc(bad.length ? t("记录和磁盘有 {n} 处对不上：", { n: bad.length }) : t("记录和磁盘一致"))} · ${esc(new Date(r.at).toLocaleString())}</div>` : "";
    box.innerHTML = head + (r.findings || []).map((f) => `<div class="item ledger ${f.level === "info" ? "" : "bad"}">
        <div class="it-title wrap">${uiI(f.level === "error" ? "x" : f.level === "warn" ? "warn" : "info", "lv-" + f.level)}${esc(f.msg)}</div>
        ${f.fix ? `<div class="tiny">${esc(t("怎么办："))}${esc(f.fix)}</div>` : ""}
        ${f.samples.length ? `<div class="tiny mono">${f.samples.slice(0, 5).map(esc).join("<br>")}</div>` : ""}
      </div>`).join("");
    box.classList.remove("hidden");
  }
  async function loadReconcile(run) {
    const r = await api("/api/reconcile" + (run ? "?run=1" : "")).catch(() => null);
    if (r) paintReconcile(r, run);
    return r;
  }
  $("btn-reconcile").addEventListener("click", async () => {
    const box = $("reconcile-box");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    toast(t("正在核对…"));
    const r = await loadReconcile(true);
    if (!r) toast(t("核对失败"), true);
    else if (!r.supported) toast(t("这里没有工具包，不用核对"));
  });
  const LEDGER_KIND = () => ({ verify: t("校验"), repair: t("修复"), install: t("安装"), uninstall: t("卸载"), recover: t("恢复"), "safe-mode": t("安全模式"), logs: t("日志") });
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
  const GROUP_NAME = provEn() ? { claude: "Claude", third: "Third-party (just add a key)", local: "On-device", custom: "Custom endpoints" }
    : { claude: "Claude", third: t("第三方（填 Key 即用）"), local: t("端侧（本机运行）"), custom: t("自定义接口") };
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
      sel.innerHTML = ["claude", "third", "local", "custom"].filter((g) => g !== "local" || groups.local).map((g) =>
        `<optgroup label="${GROUP_NAME[g]}">` + (groups[g] || []).map(opt).join("") +
        (g === "custom" ? `<option value="__new__">${provEn() ? "+ Add a custom endpoint…" : t("＋ 新增自定义接口…")}</option>` : "") + `</optgroup>`).join("");
      sel.value = state.provView;
      $("provider-count").textContent = t("{n} 个", { n: state.providers.length });
      const cur = state.providers.find((p) => p.id === r.active) || {};
      $("provider-info").textContent = t("当前在用：{name}", { name: pLabel(cur) || r.active });
      $("provider-info").title = cur.baseUrl || "";
      renderProvCard();
    } catch (e) {
      $("provider-info").textContent = t("读取接口清单失败：{msg}", { msg: e.message });
    }
  }

  // 照稿收起接口卡：正在用、而且已经配好的那一家默认只露一行；看别家 / 没配好时自动展开
  let provOpen = null;
  function foldProvCard() {
    const id = state.provView, p = (state.providers || []).find((x) => x.id === id);
    const auto = !(p && p.active && (p.login || p.local || p.hasKey));
    const open = provOpen == null ? auto : provOpen;
    $("prov-card").classList.toggle("hidden", !open);
    $("prov-more").textContent = open ? t("收起") : t("详情");
  }
  $("prov-more").addEventListener("click", () => { provOpen = $("prov-card").classList.contains("hidden"); foldProvCard(); });
  function renderProvCard() {
    const box = $("prov-card");
    const id = state.provView;
    foldProvCard();
    // 卡片容器是复用的：密钥卡 / 自定义卡会在它上面挂 onclick（闭包里记着那一家）。
    // 换卡前必须摘掉，否则旧处理还在 —— 在登录卡上点「使用这个接口」，冒泡上来又把接口切回上一家
    // （实测：同一毫秒发出 provider=anthropic 和 provider=deepseek，后者赢）。
    box.onclick = null;
    if (id === "__new__") return renderCustomCard(box, null);
    const p = (state.providers || []).find((x) => x.id === id);
    if (!p) { box.innerHTML = ""; return; }
    if (p.login) return renderLoginCard(box, p);
    if (p.local) return renderLocalCard(box, p);
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

  // ── 端侧小模型卡：llama.cpp 装没装、有没有 GPU、模型目录里有哪些、聊天 / 自定义模式、服务状态 ──
  async function renderLocalCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div><div class="tiny">${t("读取中…")}</div>`;
    let j;
    try { j = await api("/api/local"); } catch (e) { box.innerHTML += `<div class="prov-state err">${esc(e.message)}</div>`; return; }
    if (state.provView !== p.id) return;
    const gb = (n) => (n / 1073741824).toFixed(1) + " GB";
    const ok = (b) => b ? "✓" : "✗";
    const sv = j.server || {}, cu = j.custom || {};
    const cmdText = t("请阅读 {skill}，帮我给端侧小模型配置一个自定义模式。", { skill: (cu.skill || "~/.claude/skills/local-model-mode/SKILL.md") });
    const svText = sv.state === "ready" ? t("已加载 {name}（{min} 分钟不用自动卸载）", { name: sv.model, min: Math.round(sv.idleMs / 60000) })
      : sv.state === "loading" ? t("正在加载 {name}…", { name: sv.model })
      : sv.state === "error" ? t("上次没起来：{msg}", { msg: sv.err || "?" })
      : t("未运行（发消息时自动加载）");
    box.innerHTML = `<div class="sub">${esc(pLabel(p))}</div>
      <div class="tiny">${esc(pHint(p))}</div>
      <div class="local-facts tiny">
        <div>${ok(j.bin)} ${j.bin ? t("llama.cpp 已装") : t("没装 llama.cpp：到「扩展」页装 llama-cpp 组件")}</div>
        <div>${j.gpu ? "✓ " + t("GPU 推理（Vulkan）") : "· " + t("只有 CPU 推理（装 GPU 驱动组件可以快几倍）")}</div>
        <div>· ${t("内存 {total}，可用 {avail}；上下文 {ctx} token，{n} 线程", { total: gb(j.memTotal), avail: gb(j.memAvail), ctx: j.ctx.toLocaleString(), n: j.threads })}</div>
      </div>
      <div class="tiny" style="margin:8px 0 4px">${t("模型（{dir}）", { dir: esc(j.dirs[0] || "") })}</div>
      ${j.models.length ? `<div class="local-models">${j.models.map((m) => `<div class="tiny">· <code>${esc(m.id)}</code> ${gb(m.size)}</div>`).join("")}</div>`
        : `<div class="tiny dim">${t("还没有模型。到「扩展」页 llama-cpp 组件下的「下载模型」一键下载，或把 .gguf 文件放进上面的目录。")}</div>`}
      <div class="tiny" style="margin:10px 0 4px">${t("模式")}</div>
      <div class="local-mode">
        <label><input type="radio" name="lm" value="chat" ${j.mode !== "custom" ? "checked" : ""}> ${t("聊天")}<span class="tiny dim"> — ${t("不给工具，提示最短、回得最快")}</span></label>
        <label><input type="radio" name="lm" value="custom" ${j.mode === "custom" ? "checked" : ""} ${cu.ok ? "" : "disabled"}> ${cu.ok ? esc(cu.label) : t("自定义")}<span class="tiny dim"> — ${
          cu.ok ? (cu.tools ? t("工具：{tools}", { tools: esc(cu.tools) }) : t("不给工具")) : cu.have ? "" : t("还没配置")}</span></label>
        ${cu.have && !cu.ok ? `<div class="tiny err">${t("配置文件有误，已按聊天模式跑：{msg}", { msg: esc(cu.err) })}</div>` : ""}
      </div>
      <div class="local-custom tiny dim">
        ${t("手机算力有限，小模型干不了活，所以只内置聊天。想自己折腾的话，可以写 {file} 开一个自定义模式（指定工具、系统提示、llama-server 参数）。最省事的办法：切到云端模型，把下面这句发给它：", { file: "<code>" + esc(cu.path || "~/.cccodroid/local-mode.json") + "</code>" })}
        <div class="local-copy"><code>${esc(cmdText)}</code><button class="btn sm ghost" data-act="copy">${t("复制")}</button></div>
      </div>
      <div class="prov-state">${esc(svText)}${sv.loadMs ? ` · ${t("加载用了 {s} 秒", { s: (sv.loadMs / 1000).toFixed(1) })}` : ""}</div>
      <div class="row-actions">
        ${sv.state === "ready" || sv.state === "loading" ? `<button class="btn sm ghost" data-act="stop">${t("卸载模型")}</button>` : ""}
        <button class="btn sm ghost" data-act="refresh">${t("刷新")}</button>
        ${j.bin && j.models.length ? useBtn(p) : ""}
      </div>`;
    box.onclick = async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === "use") return useProvider(p);
      if (act === "refresh") return renderLocalCard(box, p);
      if (act === "stop") { await post("/api/local", { stop: true }).catch((e2) => toast(e2.message, true)); return renderLocalCard(box, p); }
      if (act === "copy") { navigator.clipboard?.writeText(cmdText); return toast(t("已复制")); }
    };
    box.querySelectorAll('input[name="lm"]').forEach((r) => r.addEventListener("change", async () => {
      await post("/api/local", { mode: r.value }).catch((e2) => toast(e2.message, true));
      toast(t("已切换（下一条消息生效）"));
    }));
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
  /** 用量页的额度面板：只有用 Claude 账户登录时才显示，大数字 + 进度条 + 重置时间 */
  async function loadQuota() {
    let st = null;
    try { st = await api("/api/login/status"); } catch {}
    const box = $("quota-field"), l = st && st.loggedIn !== false && st.limits;
    box.classList.toggle("hidden", !(st && st.loggedIn));
    if (!l) { $("quota-tiles").innerHTML = ""; $("quota-note").textContent = t("额度：发一条消息后显示（5 小时 / 每周）"); return; }
    const tile = (label, w) => {
      if (!w) return "";
      const pct = Math.max(0, Math.min(100, w.used));
      const cls = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
      const at = w.resetsAt ? new Date(w.resetsAt * 1000) : null;
      const reset = at ? t("{time} 重置", { time: esc(at.toDateString() === new Date().toDateString()
        ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : at.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) }) : "";
      return `<div class="q-tile ${cls}"><span class="q-l">${label}</span><b>${Math.round(pct)}<small>%</small></b>
        <span class="quota-bar"><i class="${cls}" style="width:${pct}%"></i></span><span class="q-r">${reset}</span></div>`;
    };
    $("quota-tiles").innerHTML = tile(t("5 小时"), l.fiveHour) + tile(t("每周"), l.sevenDay);
    const lq = $("login-state") && $("login-state").querySelector(".quota");   // 设置里登录卡片上的那两条
    if (lq) lq.outerHTML = quotaHtml(l);
    usDash.quota = l.sevenDay || null; usPaint(); paintSetUsage();
    const ago = Math.max(0, Math.round((Date.now() - l.at) / 60000));
    $("quota-note").textContent = ago < 1 ? t("额度刚刚更新") : t("额度更新于 {n} 分钟前（每轮对话后刷新）", { n: ago });
  }
  // 额度看得见的地方（用量页、设置里的用量行 / 登录卡片、第三方的余额卡片）只在打开时拉过一次，
  // 之后要切页面才更新。现在：网关记下新额度时推 quota、每轮跑完、回到前台，都把看得见的那几处重画一遍
  let quotaT = 0, billAt = 0;
  function refreshQuota() {
    clearTimeout(quotaT);
    quotaT = setTimeout(() => {
      if (document.hidden) return;
      const usageOpen = curPage === "usage" && !$("pages").classList.contains("hidden");
      if (setOpen || usageOpen) loadQuota().catch(() => {});
      const rb = setOpen && $("pc-bill") && $("pc-bill").querySelector('[data-bill="refresh"]');
      if (rb && Date.now() - billAt > 30e3) { billAt = Date.now(); rb.click(); }   // 厂商余额接口别打太勤
    }, 800);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQuota(); });
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
  let billTimer = 0;
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
    if (b.balanceAt && b.ledgerCurrency) rows.push(`<div class="tiny">${esc(t("{time} 查询；平台扣费有几分钟延迟，跑完会自动补查", { time: new Date(b.balanceAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }))}</div>`);
    el.innerHTML = `<div class="bill-head"><span class="sub">${t("余额与消费")}</span>
      <button class="btn sm ghost" data-bill="refresh">${t("刷新")}</button></div>${rows.join("")}`;
    el.querySelector('[data-bill="refresh"]').onclick = (e) => { e.stopPropagation(); loadBill(p, true); };
    // 卡片开着就每分钟重拉一次（网关有 60 秒缓存，跑完后的补查结果也会被带出来）
    clearTimeout(billTimer);
    billTimer = setTimeout(() => { if (state.provView === p.id && $("pc-bill") && !document.hidden) loadBill(p); }, 60e3);
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
    $("priv-actions").insertAdjacentHTML("beforeend", `<button class="btn sm ghost" data-act="refresh">${t("刷新")}</button>` +
      (st.dev ? "" : `<button class="btn sm ghost" data-act="audit">${t("特权命令记录")}</button>`));
    $("priv-auto-row").classList.toggle("hidden", !(wl && st.paired));
    $("priv-auto").checked = st.autostart !== false;
    $("priv-ka-row").classList.toggle("hidden", !!st.dev);
    $("priv-ka-row").style.opacity = st.state === "ok" ? "1" : ".45";
    $("priv-ka").disabled = st.state !== "ok";
    $("priv-ka").checked = !!st.keepalive;
    // 安装、配对、启动都在进行时自己刷新（设置页开着才刷）
    clearTimeout(privPoll);
    if (busy && pageOn("settings")) privPoll = setTimeout(loadPriv, 1500);
  }
  // 经 priv 执行过的命令（谁发起、命令、退出码、用时）。再点一次收起
  const privBy = (k) => ({ claude: "Claude", terminal: t("终端"), gateway: "cccodroid", "cc-mem": t("内存管家"), other: t("其他") })[k] || k;
  async function togglePrivAudit() {
    const box = $("priv-audit");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.textContent = t("加载中…");
    try {
      const r = await api("/api/priv/audit");
      if (!r.items.length) { box.innerHTML = `<div class="tiny">${t("还没有经 priv 执行过命令")}</div>`; return; }
      const two = (n) => String(n).padStart(2, "0");
      box.innerHTML = `<div class="tiny" style="margin-bottom:6px">${t("最近 {n} 条（最新的在前）。只记在本机，不上传。", { n: r.items.length })}</div>` +
        r.items.map((x) => {
          const d = new Date(x.t);
          const when = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
          return `<div class="audit-row${x.rc ? " bad" : ""}"><span class="audit-meta">${when} · ${esc(privBy(x.by))} · rc=${x.rc}${x.ms >= 1000 ? " · " + (x.ms / 1000).toFixed(1) + "s" : ""}</span><code>${esc(x.cmd)}</code></div>`;
        }).join("");
    } catch (e) { box.textContent = e.message; }
  }
  $("priv-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === "open") await post("/api/priv/open").catch(() => {});
    if (act === "appsettings") return post("/api/app/open_app_settings").catch(() => {});
    if (act === "audit") return togglePrivAudit();
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
    const UPD_TEXT = { uptodate: t("已是最新"), available: t("有新版本"), downloading: t("下载中"), ready: t("已下载，待安装"), installing: t("安装中"), error: t("出错"), unknown: t("未检查"), verifying: t("校验中"), damaged: t("已损坏"), missing: t("未安装") };
  let updPoll = null;
  let updFollowUntil = 0;
  const followUpd = () => { updFollowUntil = Date.now() + 15000; };
  let lastUpd = {};
  // 升级工具包时留下的旧程序（网关启动时隔离到 files/orphans-<日期>/，14 天后自动删）：有就提一句，给个立即删
  async function loadOrphans() {
    const r = await api("/api/orphans").catch(() => null);
    const el = $("upd-orphans");
    const n = r && r.ok ? r.dirs.reduce((a, d) => a + d.count, 0) : 0;
    el.classList.toggle("hidden", !n);
    if (!n) return;
    const bytes = r.dirs.reduce((a, d) => a + d.bytes, 0);
    el.innerHTML = `<div class="row-actions" style="justify-content:space-between">
      <span class="tiny">${esc(t("旧工具包留下的 {n} 个程序（{size}）已隔离，{d} 天后自动删除。", { n, size: fmtSize(bytes), d: r.ttlDays }))}</span>
      <button class="btn sm ghost danger" id="orphans-purge">${t("立即删除")}</button></div>`;
    $("orphans-purge").onclick = async () => {
      if (!confirm(t("立即删除隔离的 {n} 个旧程序？删了就找不回来了。", { n }))) return;
      const x = await post("/api/orphans/purge", {}).catch((e2) => ({ ok: false, message: e2.message }));
      toast(x.ok ? t("已删除 {n} 个", { n: x.removed }) : x.message, !x.ok);
      loadOrphans();
    };
  }
  async function loadUpd() {
    let st;
    try { st = await api("/api/app/upd_status"); } catch { return; }
    if (!st.ok || !st.items) return;                 // 旧版 / 开发端：没有这项
    lastUpd = st;
    $("upd-field").classList.remove("hidden");
    $("upd-auto").checked = !!st.auto;
    $("upd-channel").value = st.channel === "pinned" ? "pinned" : st.channel || "stable";
    $("upd-channel").querySelector("option[value=pinned]").textContent = st.channel === "pinned" && st.pin ? t("CLI：固定 {v}", { v: st.pin }) : t("CLI：固定版本…");
    let moving = st.checking;
    $("upd-items").innerHTML = st.items.map((it) => {
      const busy = it.state === "downloading" || it.state === "installing" || it.state === "verifying";
      moving ||= busy;
      const ver = esc(it.current || "?") + (it.latest && it.latest !== it.current && it.state !== "uptodate" ? " → " + esc(it.latest) : "");
      const prog = it.state === "downloading" && it.total ? `（${fmtSize(it.done)} / ${fmtSize(it.total)} · ${Math.floor(it.done * 100 / it.total)}%）`
        : (it.state === "installing" || it.state === "verifying") && it.total ? `（${Math.floor(it.done * 100 / it.total)}%）` : "";
      const cls = it.state === "error" || it.state === "damaged" || it.state === "missing" ? "err" : it.state === "uptodate" ? "ok" : it.state === "unknown" ? "" : "warn";
      const btn = it.state === "missing" ? t("安装…") : it.state === "available" ? (it.id === "claude" ? t("更新") : t("下载并安装"))
        : it.state === "ready" ? t("安装") : it.state === "damaged" ? t("修复") : it.state === "error" && it.latest ? t("重试") : "";
      // 工具包：随时可以逐个核对文件；坏了就「修复」（重装同一版本）
      const act = it.state === "damaged" ? "repair" : it.state === "missing" ? "pick" : "";
      const verifyBtn = it.id === "devkit" && it.current && ["uptodate", "unknown", "error", "damaged"].includes(it.state)
        ? `<button class="btn sm ghost" data-item="devkit" data-act="verify">${t("校验")}</button>` : "";
      // 从本地文件装（离线、或者已经用电脑下好了）：外壳弹系统文件选择器，认身份、替换都在外壳里做
      const localBtn = it.id === "devkit" && !busy && window.CCApp && CCApp.pickDevkit
        ? `<button class="btn sm ghost" data-item="devkit" data-act="local" title="${esc(t("选一个已经下好的工具包文件来安装"))}">${t("本地文件…")}</button>` : "";
      // 卸载：工具包回到首装（重选来源和模块）、Claude Code 重新下载；外壳做，老外壳没有这个接口就不显示
      const unBtn = (it.id === "devkit" || it.id === "claude") && it.current && !busy && window.CCApp && CCApp.uninstall
        ? `<button class="btn sm ghost danger" data-item="${it.id}" data-act="uninstall">${t("卸载")}</button>` : "";
      const verBtn = it.id === "claude" && it.current && !busy
        ? `<button class="btn sm ghost" data-item="claude" data-act="versions">${t("版本…")}</button>` : "";
      return `<div class="row-actions" style="justify-content:space-between">
        <div><b>${esc(it.name)}</b> <span class="tiny">${ver}</span><br>
          <span class="prov-state ${cls}" style="margin:0">${UPD_TEXT[it.state] || esc(it.state)}${prog}${it.message ? " · " + esc(it.message) : ""}</span></div>
        <div class="row-actions">${verifyBtn}${localBtn}${verBtn}${unBtn}${btn ? `<button class="btn sm" data-item="${esc(it.id)}"${act ? ` data-act="${act}"` : ""}>${btn}</button>` : ""}</div></div>`;
    }).join("");
    const v = st.verify;
    if (v && v.manifest && (v.missing || v.changed) && (v.samples || []).length)
      $("upd-items").insertAdjacentHTML("beforeend", `<pre class="tiny mono" style="white-space:pre-wrap;margin:6px 0 0;color:var(--fg3)">${esc(v.samples.join("\n"))}${v.missing + v.changed > v.samples.length ? "\n…" : ""}</pre>`);
    loadOrphans();
    $("upd-last").textContent = st.checking ? t("检查中…") : st.error ? "✗ " + st.error
      : st.lastCheck ? t("上次检查：{at}", { at: new Date(st.lastCheck).toLocaleString() }) : t("还没检查过");
    clearTimeout(updPoll);
    // 点完按钮 / 换完渠道后的一小段时间也接着刷：后台的检查、换版本要过一会儿才开始，只看「正在进行」会漏掉结果
    if ((moving || st.checking || Date.now() < updFollowUntil) && pageOn("settings")) updPoll = setTimeout(loadUpd, 1500);
  }
  /** Claude Code 版本选单：跟随 stable / latest，或固定到某一版（固定后自动更新、检查更新都不动它） */
  async function openClaudeVersions() {
    if ($("ccv-pick")) return;
    const it = ((lastUpd && lastUpd.items) || []).find((x) => x.id === "claude") || {};
    const mode = (lastUpd && lastUpd.channel) || "stable", pin = (lastUpd && lastUpd.pin) || "";
    const m = document.createElement("div");
    m.id = "ccv-pick";
    m.innerHTML = `<div class="sheet-panel mp-panel">
      <div class="mp-head"><b>${t("Claude Code 版本")}</b><button class="mp-x" type="button" aria-label="${t("关闭")}">${uiI("x")}</button></div>
      <div class="mp-lbl">${t("跟随渠道（自动更新跟着它走）")}</div><div class="ccv-ch"><div class="tiny">${t("读取中…")}</div></div>
      <div class="mp-lbl">${t("固定到某一版（自动更新不再改它）")}</div>
      <label class="searchbox mp-sb"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input class="mp-q" type="search" inputmode="decimal" autocomplete="off" placeholder="${t("搜索版本号")}"></label>
      <div class="mp-list"><div class="tiny">${t("读取中…")}</div></div>
      <div class="tiny mp-note">${t("登录、会话和设置不受影响；版本越旧，越可能缺新功能。")}</div></div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest(".mp-x")) close(); });
    let info;
    try { info = await api("/api/claude/versions"); } catch (e) { info = { ok: false, message: e.message, versions: [] }; }
    if (!m.isConnected) return;
    const chBox = m.querySelector(".ccv-ch"), list = m.querySelector(".mp-list"), q = m.querySelector(".mp-q");
    const chRow = (ch, v, sub) => `<button type="button" class="mp-item${mode === ch ? " cur" : ""}" data-ch="${ch}"><span>${t("跟随 {ch}", { ch })}${v ? " · " + esc(v) : ""}</span><small>${esc(sub)}</small></button>`;
    chBox.innerHTML = chRow("stable", info.stable, t("官方稳定渠道")) + chRow("latest", info.latest, t("最新发布，比 stable 新，也可能没那么稳"));
    const tags = (v) => [v === info.stable ? "stable" : "", v === info.latest ? "latest" : "", v === it.current ? t("当前装的") : "", mode === "pinned" && v === pin ? t("已固定") : ""].filter(Boolean).join(" · ");
    const paint = () => {
      const kw = q.value.trim();
      const vs = (info.versions || []).filter((v) => !kw || v.includes(kw));
      list.innerHTML = vs.slice(0, 200).map((v) => `<button type="button" class="mp-item${mode === "pinned" && v === pin ? " cur" : ""}" data-v="${esc(v)}"><span>${esc(v)}</span>${tags(v) ? `<small>${esc(tags(v))}</small>` : ""}</button>`).join("")
        || `<div class="tiny">${info.versions && info.versions.length ? t("没有匹配的版本") : esc(info.message || t("取不到版本列表"))}</div>`;
    };
    paint();
    q.addEventListener("input", paint);
    m.querySelector(".mp-panel").addEventListener("click", async (e) => {
      const b = e.target.closest(".mp-item");
      if (!b) return;
      const ch = b.dataset.ch || "pinned", v = b.dataset.v || "";
      if (ch === mode && (ch !== "pinned" || v === pin) && it.state !== "missing") { close(); toast(t("已经是这个设置")); return; }
      close();
      const r = await post("/api/app/upd_set", ch === "pinned" ? { channel: ch, version: v } : { channel: ch }).catch((e2) => ({ ok: false, message: e2.message }));
      // 卸载过（未安装）：改设置不会自动装回，要再明说装一次
      if (it.state === "missing" && r.ok !== false) {
        const r2 = await post("/api/app/upd_apply", { item: "claude", version: ch === "pinned" ? v : ch }).catch((e2) => ({ ok: false, message: e2.message }));
        toast(r2.message || (r2.ok ? t("开始") : t("失败")), !r2.ok);
      } else toast(r.ok === false ? (r.message || t("失败")) : ch === "pinned" ? t("已固定到 {v}，正在切换", { v }) : t("已改为跟随 {ch}", { ch }), r.ok === false);
      followUpd(); setTimeout(loadUpd, 500);
    });
  }
  $("upd-items").addEventListener("click", async (e) => {
    const item = e.target.dataset && e.target.dataset.item;
    if (!item) return;
    const act = e.target.dataset.act;
    if (act === "pick" || act === "versions") { openClaudeVersions(); return; }   // 卸载后重装、平时换版本：都走版本选单
    if (act === "uninstall") {
      const msg = item === "devkit"
        ? t("卸载开发工具包？\n\n会删掉整个工具包，连同装在里面的组件、加装的模块、你用 pip / npm -g / pkg 装的东西，然后回到首次安装，重新选下载来源和模块。\n\n会话、工作区、登录和设置都保留。正在跑的终端会被关掉。")
        : t("卸载 Claude Code？\n\n删掉已下载的 Claude Code 程序，之后不会自动装回。要用时在这里点「安装…」，自己选版本（stable、latest 或具体版本号）。\n\n登录、会话和设置都保留；没装的时候发消息会提示先安装。");
      if (!confirm(msg)) return;
      CCApp.uninstall(item);
      return;
    }
    if (act === "local") {
      if (!confirm(t("从本地文件安装开发工具包？\n\n选一个 devkit-cc.codroid.tar.gz（或 .tar），可以在 GitHub 发布页或 cccodroid.net 下载。装之前会核对它是不是已发布的版本；装的时候暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
      CCApp.pickDevkit();
      return;
    }
    if (act === "verify" || act === "repair") {
      if (act === "repair" && !confirm(t("修复开发工具包？\n\n会重新下载当前这一版你装着的部分（断点续传）并重装，装的时候暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
      const r = await post(act === "verify" ? "/api/app/upd_verify" : "/api/app/upd_repair", { full: true }).catch((e2) => ({ ok: false, message: e2.message }));
      toast(r.message || (r.ok ? t("开始") : t("失败")), !r.ok);
      followUpd(); setTimeout(loadUpd, 500);
      return;
    }
    if (item === "devkit" && !confirm(t("更新开发工具包？\n\n要下多少见这一项旁边标的大小（断点续传），装的时候会暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
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

  // ── 设备工具（只有 cccodroid：DeviceTools.java + A11y.java，经 device-mcp.mjs 给 Claude）──
  const devName = (n) => ({
    device_status: t("设备状态"), notify: t("发通知"), clipboard_read: t("读剪贴板"), clipboard_write: t("写剪贴板"),
    open: t("打开应用 / 链接 / 日历…"), share_file: t("分享文件"), app_list: t("已装应用列表"),
    screen_read: t("读屏"), screen_tap: t("点按"), screen_swipe: t("滑动 / 滚动"), screen_type: t("输入文字"), screen_key: t("返回 / 主页等按键"), screenshot: t("截屏"),
  })[n] || n;
  function devRender(st) {
    $("dev-field").classList.remove("hidden");
    $("dev-on").checked = !!st.on;
    const box = $("dev-tools");
    box.replaceChildren();
    for (const tl of st.tools || []) {
      const l = document.createElement("label");
      l.className = "tiny";
      l.style.cssText = "display:flex;gap:6px;align-items:center";
      l.innerHTML = `<input type="checkbox" style="width:auto;margin:0"${tl.enabled ? " checked" : ""}${st.on ? "" : " disabled"}><span>${esc(devName(tl.name))}</span>`;
      l.firstChild.addEventListener("change", (e) => post("/api/app/dev_set", { tool: tl.name, enabled: e.target.checked }).then(devRender).catch(() => {}));
      box.appendChild(l);
    }
    const a = st.a11y || {};
    $("dev-a11y").value = a.mode || "off";
    $("dev-a11y").disabled = !st.on;
    $("dev-idle").value = a.idle || 10;
    $("dev-idle-row").classList.toggle("hidden", a.mode !== "auto");
    const s = $("dev-a11y-state");
    s.className = "prov-state " + (a.connected ? "ok" : a.mode === "off" ? "" : "warn");
    s.textContent = a.connected ? t("无障碍服务：已连接") : a.mode === "off" ? t("无障碍服务：关") : t("无障碍服务：现在没开（用到时再开）");
    // 自己开不了（没 WRITE_SECURE_SETTINGS）时，只能让用户去系统设置里开；安卓 13+ 侧载的应用还要先「允许受限设置」
    $("dev-a11y-how").textContent = a.mode !== "off" && !a.canToggle
      ? t("还没激活 Shizuku，应用没法自己开关无障碍：去系统无障碍设置里手动打开 cccodroid。安卓 13 起，侧载的应用要先在 应用信息 → 右上角菜单 → 允许受限设置。")
      : "";
    if (st.message) toast(st.message, true);
  }
  async function loadDev() {
    let st;
    try { st = await api("/api/app/dev_status"); } catch { return; }
    if (!st.ok) return;
    devRender(st);
  }
  $("dev-on").addEventListener("change", (e) => post("/api/app/dev_set", { on: e.target.checked }).then(devRender).catch(() => {}));
  $("dev-a11y").addEventListener("change", (e) => post("/api/app/dev_set", { a11y: e.target.value }).then(devRender).catch((e2) => toast(e2.message, true)));
  $("dev-idle").addEventListener("change", (e) => post("/api/app/dev_set", { idle: Number(e.target.value) || 10 }).then(devRender).catch(() => {}));
  $("dev-a11y-sys").addEventListener("click", () => post("/api/app/a11y_settings").catch(() => {}));

  $("upd-check").addEventListener("click", async () => {
    await post("/api/app/upd_check").catch((e2) => toast(e2.message, true));
    followUpd(); setTimeout(loadUpd, 300);
  });
  $("upd-auto").addEventListener("change", (e) => post("/api/app/upd_set", { auto: e.target.checked }).then(loadUpd).catch(() => {}));
  $("upd-channel").addEventListener("change", (e) => {
    // 固定版本要先挑一版：开选单，下拉框先退回原样，挑完 loadUpd 会刷新成「固定 x.y.z」
    if (e.target.value === "pinned") { e.target.value = (lastUpd && lastUpd.channel) || "stable"; openClaudeVersions(); return; }
    followUpd(); post("/api/app/upd_set", { channel: e.target.value }).then(loadUpd).catch(() => {});
  });
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

  // ── 耗电卡：小时 / 日 / 周三档，SVG 手画（像 macOS 的电池页：上面电量，下面用量柱）──
  const en = { view: "hour", data: null, sel: -1 };
  const enW = 320, enH = 96, enTop = 6, enBot = 80;
  const enPct = (x) => (Math.round(x * 10) / 10) + "%";
  function enLabel(b, view, long) {
    if (view === "hour") {
      const a = new Date(b.t), z = new Date(b.t + 3600e3), hm = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return long ? hm(a) + "–" + hm(z) : String(a.getHours()).padStart(2, "0");
    }
    const [y, m, d] = b.t.split("-").map(Number), dt = new Date(y, m - 1, d);
    if (!long) return (m) + "/" + d;
    if (view === "day") return dt.toLocaleDateString([], { month: "short", day: "numeric", weekday: "short" });
    const e = new Date(dt); e.setDate(e.getDate() + 6);
    return dt.toLocaleDateString([], { month: "short", day: "numeric" }) + " – " + e.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  /** 柱状图：series = [[键, 样式类]]，后面的叠画在前面的上面（比如亮屏里套前台）；fmtMax 给左上角的刻度 */
  function enBars(bars, series, fmtMax, labelEvery) {
    const n = bars.length, slot = enW / n, bw = Math.max(2, slot * 0.68);
    const max = Math.max(...bars.flatMap((b) => series.map(([k]) => b[k] || 0)), 0);
    if (!(max > 0)) return null;
    let s = `<line class="grid" x1="0" x2="${enW}" y1="${enTop}" y2="${enTop}"/><line class="grid" x1="0" x2="${enW}" y1="${enBot}" y2="${enBot}"/>`;
    s += `<text x="${enW}" y="${enTop - 1}" text-anchor="end">${esc(fmtMax(max))}</text>`;
    bars.forEach((b, i) => {
      const x = i * slot + (slot - bw) / 2, dim = en.sel >= 0 && en.sel !== i ? " dim" : "";
      for (const [k, cls] of series) {
        const h = ((b[k] || 0) / max) * (enBot - enTop);
        if (h > 0) s += `<rect class="bar ${cls}${dim}" x="${x.toFixed(1)}" y="${(enBot - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.8).toFixed(1)}" rx="1.5"/>`;
      }
      if (i % labelEvery === 0) s += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${enH - 4}" text-anchor="middle">${esc(enLabel(b, en.view))}</text>`;
      s += `<rect class="hit" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${enH}"/>`;
    });
    return s;
  }
  /** 电量曲线（近 24 小时）：充电的时段铺一层绿底 */
  function enLevels(levels, now) {
    if (levels.length < 2) return null;
    const t0 = now - 24 * 3600e3, X = (t) => ((t - t0) / (24 * 3600e3)) * enW, Y = (v) => enBot - (v / 100) * (enBot - enTop);
    let s = [0, 50, 100].map((v) => `<line class="grid" x1="0" x2="${enW}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${enW}" y="${Y(v) - 1}" text-anchor="end">${v}%</text>`).join("");
    for (let i = 1; i < levels.length; i++) {
      // 中间隔了超过半小时（关机 / 网关没跑）就断开，不连成一条假的直线
      if (levels[i][2] && levels[i - 1][2] && levels[i][0] - levels[i - 1][0] < 1800e3)
        s += `<rect class="chg" x="${X(levels[i - 1][0]).toFixed(1)}" y="${enTop}" width="${(X(levels[i][0]) - X(levels[i - 1][0])).toFixed(1)}" height="${enBot - enTop}"/>`;
    }
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        const pts = seg.map((l) => X(l[0]).toFixed(1) + "," + Y(l[1]).toFixed(1)).join(" ");
        s += `<polygon class="lvl-a" points="${X(seg[0][0]).toFixed(1)},${enBot} ${pts} ${X(seg[seg.length - 1][0]).toFixed(1)},${enBot}"/><polyline class="lvl" points="${pts}"/>`;
      }
      seg = [];
    };
    levels.forEach((l, i) => { if (i && l[0] - levels[i - 1][0] > 1800e3) flush(); seg.push(l); });
    flush();
    for (let h = 0; h < 24; h += 6) {
      const d = new Date(now - (24 - h) * 3600e3); d.setMinutes(0, 0, 0);
      const t = d.getTime() + 3600e3;
      s += `<text x="${X(t).toFixed(1)}" y="${enH - 4}" text-anchor="middle">${String(new Date(t).getHours()).padStart(2, "0")}</text>`;
    }
    return s;
  }
  function enChart(title, legend, body) {
    if (!body) return "";
    return `<div class="en-chart"><div class="en-t"><span>${esc(title)}</span><span>${legend || ""}</span></div><svg viewBox="0 0 ${enW} ${enH}">${body}</svg></div>`;
  }
  const enDot = (cls, text) => `<span class="en-dot ${cls}"><i></i>${esc(text)}</span>`;
  function enCaption() {
    const d = en.data;
    if (!d) return;
    const pick = en.sel >= 0 ? [d.bars[en.sel]] : d.bars;
    const tot = pick.reduce((a, b) => { for (const k of ["c", "f", "s", "d"]) a[k] += b[k] || 0; return a; }, { c: 0, f: 0, s: 0, d: 0 });
    const head = en.sel >= 0 ? enLabel(d.bars[en.sel], en.view, true) : t({ hour: tk("近 24 小时"), day: tk("近 14 天"), week: tk("近 12 周") }[en.view]);
    const parts = [t("本应用 CPU {d}", { d: fmtDur(tot.c * 1000) })];
    if (d.native) parts.push(t("前台 {d}", { d: fmtDur(tot.f * 1000) }), t("亮屏 {d}", { d: fmtDur(tot.s * 1000) }), t("整机掉电 {p}", { p: enPct(tot.d) }));
    $("en-cap").textContent = head + " · " + parts.join(" · ");
  }
  function enRender() {
    const d = en.data, box = $("en-charts");
    if (!d) return;
    const every = { hour: 6, day: 2, week: 3 }[en.view];
    const empty = !d.bars.some((b) => b.c || b.s);
    let h = "";
    if (en.view === "hour") h += enChart(t("电量"), enDot("chg", t("充电")), enLevels(d.levels, d.now));
    else if (d.native) h += enChart(t("整机掉电"), "", enBars(d.bars, [["d", ""]], enPct, every));
    h += enChart(t("本应用 CPU 时间"), "", enBars(d.bars, [["c", ""]], (v) => fmtDur(v * 1000), every));
    if (d.native) h += enChart(t("亮屏时间"), enDot("s", t("亮屏")) + enDot("f", t("本应用在前台")), enBars(d.bars, [["s", "s"], ["f", "f"]], (v) => fmtDur(v * 1000), every));
    if (empty) h += `<div class="tiny">${esc(t("刚开始记录，每 5 分钟采一次，过一会儿再来看。"))}</div>`;
    if (!d.native) h += `<div class="tiny">${esc(t("这个版本没有原生层，只记 CPU 时间（电量、亮屏、前台时长要 cccodroid）。"))}</div>`;
    box.innerHTML = h;
    const b = d.battery;
    $("en-bat").textContent = b ? [t("电池 {p}", { p: Math.round(b.level) + "%" }), b.charging ? t("充电中") : t("放电中"),
      Number.isFinite(b.currentUa) && b.currentUa ? Math.round(Math.abs(b.currentUa) / (Math.abs(b.currentUa) > 20000 ? 1000 : 1)) + " mA" : ""].filter(Boolean).join(" · ") : "";
    enCaption();
  }
  // ── 使用统计：网关按 UTC 小时记，这里按本地时区汇总成日 / 周 / 月；月报画在 canvas 上，看到的就是导出的 ──
  const us = { raw: null, days: new Map(), month: null, busy: false };
  const usDayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const usMonthKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const usNum = (n) => Number(n || 0).toLocaleString(I18N.lang);
  const usCompact = (n) => { try { return new Intl.NumberFormat(I18N.lang, { notation: "compact", maximumFractionDigits: 1 }).format(n || 0); } catch { return usNum(n); } };
  function usEmpty() { return { m: 0, t: 0, tl: 0, i: 0, o: 0, c: 0, s: new Set(), md: {}, mt: {}, st: {}, hr: new Array(24).fill(0) }; }
  function usMerge(a, b, hour) {
    for (const k of ["m", "t", "tl", "i", "o", "c"]) a[k] += b[k] || 0;
    for (const x of b.s || []) a.s.add(x);
    for (const f of ["md", "mt", "st"]) for (const [k, v] of Object.entries(b[f] || {})) a[f][k] = (a[f][k] || 0) + v;
    if (hour != null) a.hr[hour] += b.m || 0; else if (b.hr) b.hr.forEach((v, i) => { a.hr[i] += v; });
    return a;
  }
  function usBuild() {
    us.days = new Map();
    for (const [k, b] of Object.entries(us.raw.hours || {})) {
      const d = new Date(+k * 3600e3), key = usDayKey(d);
      if (!us.days.has(key)) us.days.set(key, usEmpty());
      usMerge(us.days.get(key), b, d.getHours());
    }
  }
  /** [a, b) 两个本地日期之间的合计 */
  function usSum(a, b) {
    const out = usEmpty();
    for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) { const x = us.days.get(usDayKey(d)); if (x) usMerge(out, x); }
    return out;
  }
  const usDay0 = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const usAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const usWeek0 = (d) => { const x = usDay0(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };   // 周一起算
  const usMonth0 = (y, m) => new Date(y, m, 1);
  const usMonthName = (y, m) => new Date(y, m, 1).toLocaleDateString(I18N.lang, { year: "numeric", month: "long" });

  /** 一个月的全部数字：月报和下面的按钮都用它 */
  function usMonthStats(y, m) {
    const a = usMonth0(y, m), b = usMonth0(y, m + 1), today = usDay0(new Date());
    const tot = usSum(a, b), prev = usSum(usMonth0(y, m - 1), a);
    const cal = [];
    let streak = 0, best = 0, active = 0, top = null;
    for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) {
      const x = us.days.get(usDayKey(d)), n = x ? x.m : 0;
      cal.push({ date: new Date(d), n, future: d > today });
      if (n) { active++; streak++; best = Math.max(best, streak); if (!top || n > top.n) top = { date: new Date(d), n }; } else streak = 0;
    }
    const peak = tot.hr.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);
    const models = Object.entries(tot.md).sort((p, q) => q[1] - p[1]);
    const days = Math.round((b - a) / 86400e3);
    return { y, m, tot, prev, cal, active, best, top, peak, models, days };
  }

  // 月报的配色跟着当前外观走（原生 / 求索 × 深 / 浅）：取 style.css 的变量，透明度另算
  function usPalette() {
    const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
    const probe = document.createElement("canvas").getContext("2d");
    const rgb = (col) => {
      probe.fillStyle = "#000"; probe.fillStyle = col;
      const x = probe.fillStyle;                       // 规范成 #rrggbb 或 rgba(r, g, b, a)
      return x[0] === "#" ? [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)) : x.match(/[\d.]+/g).slice(0, 3).map(Number);
    };
    const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const bg = rgb(v("--bg")), bg2 = rgb(v("--bg2")), fg = rgb(v("--fg")), acc = rgb(v("--accent"));
    const dark = lum(bg) < 0.5;
    const a = (c, al) => `rgba(${c[0]},${c[1]},${c[2]},${al})`;
    const mix = (c, d, k) => `rgb(${c.map((x, i) => Math.round(x + (d[i] - x) * k)).join(",")})`;
    return {
      dark, BG0: a(dark ? bg2 : bg, 1), BG1: a(dark ? bg : bg2, 1),
      ACC: a(acc, 1), ACC2: dark ? mix(acc, [255, 255, 255], 0.3) : mix(acc, [0, 0, 0], 0.15), acc: (al) => a(acc, al),
      FG: a(fg, 1), FG2: v("--fg2"), FG3: v("--fg3"), fg: (al) => a(fg, al),
      UP: v("--ok"), DOWN: v("--err"), ON: a(bg, 1),     // ON：铺满强调色的格子上的字（深色外观是深字、浅色外观是白字）
    };
  }

  // 画月报：宽 1080，配色随当前外观（见 usPalette）
  function usDraw(cv, st) {
    const K = usPalette();
    const W = 1080, P = 72, ACC = K.ACC, FG = K.FG, FG2 = K.FG2, FG3 = K.FG3, TILE = K.fg(K.dark ? 0.055 : 0.05);
    const font = (w, px) => `${w} ${px}px system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif`;
    const calRows = Math.ceil((((st.cal[0].date.getDay() + 6) % 7) + st.cal.length) / 7);
    const cell = Math.floor((W - 2 * P - 6 * 14) / 7), calH = 52 + calRows * (cell + 14);
    const mdRows = Math.min(st.models.length, 4);
    const H = 880 + calH + 70 + 300 + (mdRows ? 90 + mdRows * 64 : 0) + 110;   // 与下面逐段累加的 y 一致
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const rr = (x, y, w, h, r) => { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); };
    const text = (s, x, y, f, col, align) => { c.font = f; c.fillStyle = col; c.textAlign = align || "left"; c.fillText(s, x, y); };
    // 底色 + 右上角一团强调色的光
    const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, K.BG0); bg.addColorStop(1, K.BG1);
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    const glow = c.createRadialGradient(W - 120, 60, 0, W - 120, 60, 560); glow.addColorStop(0, K.acc(K.dark ? 0.3 : 0.16)); glow.addColorStop(1, K.acc(0));
    c.fillStyle = glow; c.fillRect(0, 0, W, H);
    c.textBaseline = "alphabetic";
    let y = P + 34;
    text("cccodroid · " + t("使用月报"), P, y, font(500, 30), FG2);
    y += 92; text(usMonthName(st.y, st.m), P, y, font(700, 76), FG);
    // 主数字
    y += 190;
    c.font = font(800, 168); const nw = c.measureText(usNum(st.tot.m)).width;
    const hero = c.createLinearGradient(P, y - 150, P + nw, y); hero.addColorStop(0, K.ACC2); hero.addColorStop(1, ACC);
    c.fillStyle = hero; c.textAlign = "left"; c.fillText(usNum(st.tot.m), P - 6, y);
    text(t("次对话"), P + nw + 20, y - 12, font(600, 44), FG);
    const dp = st.prev.m ? Math.round(((st.tot.m - st.prev.m) / st.prev.m) * 100) : null;
    y += 62;
    text(dp == null ? t("和 Claude 一起度过的这个月") : t("比上月 {p}", { p: (dp >= 0 ? "+" : "") + dp + "%" }), P, y, font(500, 32), dp == null ? FG2 : dp >= 0 ? K.UP : K.DOWN);
    // 六格数字
    y += 50;
    const tiles = [
      [t("活跃天数"), t("{n} / {d} 天", { n: st.active, d: st.days })],
      [t("会话"), t("{n} 个", { n: usNum(st.tot.s.size) })],
      [t("最长连续"), t("{n} 天", { n: st.best })],
      [st.top ? t("最忙的一天 · {n} 次", { n: usNum(st.top.n) }) : t("最忙的一天"), st.top ? st.top.date.toLocaleDateString(I18N.lang, { month: "short", day: "numeric" }) : "—"],
      [t("工具调用"), t("{n} 次", { n: usCompact(st.tot.tl) })],
      [t("Claude 写了"), usCompact(st.tot.o) + " token"],
    ];
    const tw = (W - 2 * P - 2 * 24) / 3;
    tiles.forEach(([k, v], i) => {
      const x = P + (i % 3) * (tw + 24), ty = y + Math.floor(i / 3) * 170;
      c.fillStyle = TILE; rr(x, ty, tw, 146, 26); c.fill();
      text(k, x + 28, ty + 52, font(500, 26), FG3);
      c.font = font(700, 40); let s = v; while (c.measureText(s).width > tw - 56 && s.length > 2) s = s.slice(0, -2) + "…";
      text(s, x + 28, ty + 110, font(700, 40), FG);
    });
    y += 2 * 170 + 40;
    // 日历热力图：颜色按本月最多那天分五档
    text(t("每天"), P, y + 10, font(600, 30), FG);
    const wk = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(I18N.lang, { weekday: "narrow" }));
    const max = Math.max(1, ...st.cal.map((x) => x.n));
    wk.forEach((w, i) => text(w, P + i * (cell + 14) + cell / 2, y + 58, font(500, 22), FG3, "center"));
    const lv = [K.fg(0.06), K.acc(0.28), K.acc(0.48), K.acc(0.7), K.acc(0.9), K.ACC2];
    const today = usDayKey(new Date());
    st.cal.forEach((d, i) => {
      const k = i + ((st.cal[0].date.getDay() + 6) % 7), x = P + (k % 7) * (cell + 14), cy = y + 76 + Math.floor(k / 7) * (cell + 14);
      const l = d.n ? Math.min(5, 1 + Math.floor((d.n / max) * 4.999)) : 0;
      c.fillStyle = d.future ? K.fg(0.025) : lv[l]; rr(x, cy, cell, cell, 18); c.fill();
      if (usDayKey(d.date) === today) { c.strokeStyle = FG; c.lineWidth = 3; rr(x + 1.5, cy + 1.5, cell - 3, cell - 3, 17); c.stroke(); }
      text(String(d.date.getDate()), x + 16, cy + 34, font(600, 22), l >= 4 ? K.ON : d.future ? FG3 : FG2);
      if (d.n) text(usNum(d.n), x + cell - 16, cy + cell - 18, font(700, 28), l >= 4 ? K.ON : FG, "right");
    });
    y += calH + 70;
    // 24 小时分布
    const hmax = Math.max(1, ...st.tot.hr);
    text(t("一天里什么时候聊"), P, y, font(600, 30), FG);
    if (st.tot.m) text(t("最常在 {h} 点前后", { h: st.peak }), W - P, y, font(500, 26), ACC, "right");
    const bw = (W - 2 * P) / 24, by = y + 200;
    st.tot.hr.forEach((v, i) => {
      const h = Math.max(4, (v / hmax) * 150);
      c.fillStyle = v === hmax && v ? ACC : v ? K.acc(0.45) : K.fg(0.07);
      rr(P + i * bw + 4, by - h, bw - 8, h, 6); c.fill();
      if (i % 6 === 0) text(String(i).padStart(2, "0"), P + i * bw + bw / 2, by + 40, font(500, 22), FG3, "center");
    });
    y += 300;
    // 模型
    if (mdRows) {
      text(t("用得最多的模型"), P, y, font(600, 30), FG);
      const sum = st.models.reduce((a, [, v]) => a + v, 0);
      st.models.slice(0, 4).forEach(([name, v], i) => {
        const ry = y + 50 + i * 64, pct = v / sum;
        text(name.replace(/^claude-/, "").replace(/-\d{8}$/, ""), P, ry + 30, font(500, 28), FG2);
        c.fillStyle = K.fg(0.07); rr(P + 420, ry + 8, W - 2 * P - 420 - 110, 26, 13); c.fill();
        c.fillStyle = i ? K.acc(0.55) : ACC; rr(P + 420, ry + 8, Math.max(26, (W - 2 * P - 420 - 110) * pct), 26, 13); c.fill();
        text(pct < 0.01 ? "<1%" : Math.round(pct * 100) + "%", W - P, ry + 32, font(600, 28), FG, "right");
      });
      y += 90 + mdRows * 64;
    }
    // 页脚
    c.fillStyle = K.fg(0.08); c.fillRect(P, y, W - 2 * P, 2);
    text(t("{t} 轮回复 · 读了 {i} token", { t: usNum(st.tot.t), i: usCompact(st.tot.i) }), P, y + 56, font(500, 24), FG3);
    text("cccodroid.net", W - P, y + 56, font(600, 24), FG2, "right");
  }

  // 换外观时重画月报（theme.js 只改 html 的 data-theme / data-skin，不发事件）
  new MutationObserver(() => { if (us.raw && $("us-card")) usRender(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });

  function usRender() {
    if (!us.raw) return;
    const now = new Date(), d0 = usDay0(now), w0 = usWeek0(now), m0 = usMonth0(now.getFullYear(), now.getMonth());
    const tile = (label, cur, prev, prevLabel) => `<div class="us-tile"><div class="us-n">${usNum(cur.m)}</div><div class="us-l">${esc(label)}</div>
      <div class="us-sub">${esc(t("{p}：{n}", { p: prevLabel, n: usNum(prev.m) }))}</div></div>`;
    $("us-tiles").innerHTML = tile(t("今天"), usSum(d0, usAddDays(d0, 1)), usSum(usAddDays(d0, -1), d0), t("昨天"))
      + tile(t("本周"), usSum(w0, usAddDays(w0, 7)), usSum(usAddDays(w0, -7), w0), t("上周"))
      + tile(t("本月"), usSum(m0, usMonth0(now.getFullYear(), now.getMonth() + 1)), usSum(usMonth0(now.getFullYear(), now.getMonth() - 1), m0), t("上月"));
    // 近 12 个月的小柱子，点一下切到那个月
    const months = Array.from({ length: 12 }, (_, i) => { const d = usMonth0(now.getFullYear(), now.getMonth() - 11 + i); return { y: d.getFullYear(), m: d.getMonth(), n: usSum(d, usMonth0(d.getFullYear(), d.getMonth() + 1)).m }; });
    const mx = Math.max(1, ...months.map((x) => x.n));
    const [sy, sm] = us.month;
    $("us-year").innerHTML = months.map((x) => `<button class="us-mb ${x.y === sy && x.m === sm ? "on" : ""}" data-ym="${x.y}-${x.m}" title="${esc(usMonthName(x.y, x.m) + " · " + usNum(x.n))}">
      <i style="height:${Math.max(x.n ? 8 : 3, Math.round((x.n / mx) * 100))}%"></i><span>${x.m + 1}</span></button>`).join("");
    const st = usMonthStats(sy, sm);
    $("us-mlabel").textContent = usMonthName(sy, sm);
    $("us-next").disabled = sy > now.getFullYear() || (sy === now.getFullYear() && sm >= now.getMonth());
    usDraw($("us-card"), st);
    const r = us.raw;
    $("us-note").textContent = [
      r.off ? t("已暂停记录。") : t("从 {d} 起实时记录。", { d: new Date(r.since).toLocaleDateString(I18N.lang) }),
      r.imported ? t("更早的部分是从历史会话补算的（删掉的会话补不回来）。") : "",
      t("只记次数和用量，不记对话内容；数据只存在本机。"),
    ].filter(Boolean).join(" ");
    $("us-off").checked = !r.off;
    $("us-share").classList.toggle("hidden", !canShare() && !navigator.canShare);
  }
  // ── 用量看板（照设计稿）：数字一排 / 14 天柱状图 / 型号占比 / 最费的对话 / 今天耗电 ──
  // token 数一律 1.24M / 380k 这种写法（照稿；中文的「亿 / 万」在图上反而难对齐）
  const usTok = (n) => { try { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: n >= 1e6 ? 2 : 1 }).format(n || 0); } catch { return String(n || 0); } };
  const usDash = { view: "chart", quota: null, energy: null };
  const MODEL_COLORS = ["#c96442", "#2f6aa8", "#d6a84a"];      // 按出现顺序固定分配；第 4 个起并进「其他」
  function usPaint() {
    const now = new Date(), d0 = usDay0(now), m0 = usMonth0(now.getFullYear(), now.getMonth());
    const today = us.raw ? usSum(d0, usAddDays(d0, 1)) : usEmpty(), month = us.raw ? usSum(m0, usAddDays(d0, 1)) : usEmpty();
    // 数字一排：额度（官方账户才有）、今天、本月、缓存命中
    const q = usDash.quota, kpi = [];
    if (q) {
      const pct = Math.round(Math.max(0, Math.min(100, q.used)));
      const left = q.resetsAt ? q.resetsAt * 1000 - Date.now() : 0, gone = 1 - Math.max(0, Math.min(1, left / (7 * 86400e3)));
      const pace = !q.resetsAt ? "" : pct <= gone * 100 + 5 ? t("按现在的速度够用") : t("照这个速度会提前用完");
      const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
      const reset = at ? t("{time} 重置", { time: at.toLocaleDateString(I18N.lang, { weekday: "short" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
      kpi.push(`<div class="tile big${pct >= 90 ? " hot" : pct >= 70 ? " warm" : ""}"><span class="k">${esc(t("本周额度 · 官方账户"))}</span><span class="n num">${pct}%</span>
        <div class="bar-mini"><i style="width:${pct}%"></i></div><span class="k">${esc([reset, pace].filter(Boolean).join(" · "))}</span></div>`);
    }
    kpi.push(`<div class="tile"><span class="k">${esc(t("今天"))}</span><span class="n num">${usTok(today.i + today.o)}</span><span class="k">${esc(t("tokens · {n} 轮对话", { n: usNum(today.t) }))}</span></div>`);
    kpi.push(`<div class="tile"><span class="k">${esc(t("本月"))}</span><span class="n num">${usTok(month.i + month.o)}</span><span class="k">${esc(t("tokens · {n} 个会话", { n: usNum(month.s.size) }))}</span></div>`);
    kpi.push(`<div class="tile"><span class="k">${esc(t("缓存命中"))}</span><span class="n num">${month.c && month.i ? Math.round((month.c / month.i) * 100) + "%" : "—"}</span><span class="k">${esc(t("本月 · 越高越省"))}</span></div>`);
    $("us-kpis").innerHTML = kpi.join("");
    setPageSub("usage", q ? t("本周额度 {p}%", { p: Math.round(q.used) }) : t("今天 {n} tokens", { n: usTok(today.i + today.o) }));
    // 每天用量：最近 14 天，单序列（不要图例），今天那根用强调色
    const days = Array.from({ length: 14 }, (_, i) => { const d = usAddDays(d0, i - 13), x = us.days.get(usDayKey(d)); return { d, v: x ? x.i + x.o : 0, t: x ? x.t : 0 }; });
    const box = $("us-daily");
    if (usDash.view === "table") {
      box.innerHTML = `<table class="ctable"><tr><th>${esc(t("日期"))}</th><th>${esc(t("轮"))}</th><th>tokens</th></tr>${days.slice().reverse().map((x) =>
        `<tr><td>${x.d.toLocaleDateString(I18N.lang, { month: "2-digit", day: "2-digit" })}</td><td class="num">${x.t || "—"}</td><td class="num">${x.v ? usTok(x.v) : "—"}</td></tr>`).join("")}</table>`;
    } else {
      const W = 640, H = 180, pl = 38, pb = 22, pt = 8, bw = (W - pl) / days.length;
      const raw = Math.max(1, ...days.map((x) => x.v)), mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => raw / k <= 4) || mag * 10;
      const max = step * Math.ceil(raw / step), y = (v) => pt + (H - pt - pb) * (1 - v / max);
      let g = "";
      for (let v = 0; v <= max + 1e-9; v += step) g += `<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pl - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${usTok(v)}</text>`;
      days.forEach((x, i) => {
        const bx = pl + i * bw + 3, w = bw - 6, top = y(x.v), h = Math.max(0, y(0) - top), r = Math.min(4, h, w / 2);
        if (h) g += `<path class="bar${i === days.length - 1 ? " today" : ""}" d="M${bx},${y(0)} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + w - r} Q${bx + w},${top} ${bx + w},${top + r} V${y(0)} Z"/>`;
        g += `<rect class="hit" x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}" data-tip="${esc(x.d.toLocaleDateString(I18N.lang, { month: "numeric", day: "numeric" }) + "：" + (x.v ? usTok(x.v) + " tokens · " + t("{n} 轮", { n: x.t }) : t("没用")))}"/>`;
        if (i % 2 === 1) g += `<text x="${bx + w / 2}" y="${H - 6}" class="ax" text-anchor="middle">${x.d.getDate()}</text>`;
      });
      box.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg><div class="tip"></div>`;
    }
    // 按型号：本月 token 占比
    const mods = Object.entries(month.mt).sort((a, b) => b[1] - a[1]), msum = mods.reduce((a, [, v]) => a + v, 0);
    const parts = mods.slice(0, 3).map(([n, v], i) => [prettyModel(n), v, MODEL_COLORS[i]]);
    if (mods.length > 3) parts.push([t("其他"), mods.slice(3).reduce((a, [, v]) => a + v, 0), "#8b867a"]);
    $("us-models-card").classList.toggle("hidden", !msum);
    $("us-share-bar").innerHTML = parts.map(([n, v, c]) => `<i style="flex:${v};background:${c}" data-tip="${esc(n)}：${Math.round((v / msum) * 100)}%"></i>`).join("") + '<div class="tip"></div>';
    $("us-share-leg").innerHTML = parts.map(([n, v, c]) => `<span><b class="sw" style="background:${c}"></b>${esc(n)} <span class="num">${Math.max(1, Math.round((v / msum) * 100))}%</span></span>`).join("");
    // 最费的对话：本月按 token 排前 5
    const titleOf = (id) => ((state.sessions || []).find((x) => x.id === id) || {}).title;
    const top = Object.entries(month.st).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $("us-top").innerHTML = top.length ? top.map(([id, v], i) => `<div class="row" data-sid="${esc(id)}"><span class="rank num">${i + 1}</span><span class="grow t1">${esc(titleOf(id) || t("（已删除的会话）"))}</span><span class="num muted">${usTok(v)}</span></div>`).join("")
      : `<div class="row"><span class="tiny">${esc(us.raw && !us.raw.imported ? t("正在从历史会话补算…") : t("这个月还没有记录"))}</span></div>`;
    // 耗电：今天
    const e = usDash.energy, b = e && e.bars && e.bars[e.bars.length - 1];
    const k = (v, l) => `<div><span class="num">${v}</span><small>${esc(l)}</small></div>`;
    $("en-kpis").innerHTML = e ? (e.native ? k(b && b.d != null ? (Math.round(b.d * 10) / 10) + "%" : "—", t("电量")) + k(b && b.s ? fmtDur(b.s * 1000) : "—", t("亮屏")) : "")
      + k(b && b.c ? fmtDur(b.c * 1000) : "—", t("本应用 CPU")) : "";
    $("en-kpi-note").textContent = e ? (e.native ? t("电量是整机今天掉了多少；CPU 是本应用（含 Claude 和它跑的命令）实际干活的时间。") : t("这个版本没有原生层，只记 CPU 时间（电量、亮屏要 cccodroid）。")) : "";
  }
  $("us-view").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    usDash.view = b.dataset.v; $("us-view").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); usPaint();
  });
  // 柱子、占比条：点或悬停出提示
  for (const id of ["us-daily", "us-share-bar"]) {
    const box = $(id);
    const show = (e) => {
      const tip = box.querySelector(".tip"), hit = e.target.closest("[data-tip]"); if (!tip) return;
      if (!hit) return tip.classList.remove("show");
      const br = box.getBoundingClientRect(), r = hit.getBoundingClientRect();
      tip.textContent = hit.dataset.tip; tip.classList.add("show");
      tip.style.left = Math.max(40, Math.min(br.width - 40, r.left + r.width / 2 - br.left)) + "px"; tip.style.top = (r.top - br.top - 6) + "px";
    };
    box.addEventListener("click", show); box.addEventListener("pointermove", show);
    box.addEventListener("pointerleave", () => box.querySelector(".tip")?.classList.remove("show"));
  }
  $("us-top").addEventListener("click", (e) => { const r = e.target.closest("[data-sid]"); if (r) openSession(r.dataset.sid); });
  $("en-more").addEventListener("click", () => { $("en-field").classList.toggle("hidden"); if (!$("en-field").classList.contains("hidden")) $("en-field").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("us-report-btn").addEventListener("click", () => { $("us-field").classList.toggle("hidden"); if (!$("us-field").classList.contains("hidden")) { usRender(); $("us-field").scrollIntoView({ behavior: "smooth", block: "start" }); } });
  $("us-csv").addEventListener("click", async () => {
    if (!us.raw) return;
    const keys = [...us.days.keys()].sort();
    const rows = [[t("日期"), t("消息"), t("回复轮数"), t("工具调用"), t("输入 tokens"), t("输出 tokens"), t("读缓存 tokens")].join(",")]
      .concat(keys.map((k) => { const x = us.days.get(k); return [k, x.m, x.t, x.tl, x.i, x.o, x.c].join(","); }));
    try {
      const r = await post("/api/usage/csv", { name: "cccodroid-usage-" + usDayKey(new Date()) + ".csv", text: rows.join("\n") });
      if (canSaveAs()) saveAs(r.file, "text/csv"); else toast(t("已保存：{name}", { name: r.file }));
    } catch (e) { toast(e.message, true); }
  });
  async function loadUsage() {
    try {
      us.raw = await api("/api/usage");
      if (!us.month) { const n = new Date(); us.month = [n.getFullYear(), n.getMonth()]; }
      usBuild(); usPaint();
      if (!$("us-field").classList.contains("hidden")) usRender();
      // 第一次打开：把装这个版本之前的历史会话补算进来
      if (!us.raw.imported && !us.raw.importing && !us.busy) usImport(true);
    } catch (e) { $("us-result").textContent = "✗ " + e.message; }
  }
  async function usImport(auto) {
    us.busy = true;
    $("us-result").textContent = t("正在从历史会话补算…");
    try {
      const r = await post("/api/usage/import", {});
      $("us-result").textContent = t("补算完成：{f} 个会话记录、{n} 条消息。", { f: r.files, n: usNum(r.prompts) });
      us.busy = false;
      if (!auto || r.prompts) loadUsage();
    } catch (e) { us.busy = false; $("us-result").textContent = "✗ " + e.message; }
  }
  $("us-year").addEventListener("click", (e) => {
    const b = e.target.closest(".us-mb");
    if (!b) return;
    us.month = b.dataset.ym.split("-").map(Number);
    usRender();
  });
  $("us-prev").addEventListener("click", () => { const d = usMonth0(us.month[0], us.month[1] - 1); us.month = [d.getFullYear(), d.getMonth()]; usRender(); });
  $("us-next").addEventListener("click", () => { const d = usMonth0(us.month[0], us.month[1] + 1); us.month = [d.getFullYear(), d.getMonth()]; usRender(); });
  $("us-off").addEventListener("change", async (e) => {
    try { await post("/api/usage/set", { off: !e.target.checked }); loadUsage(); } catch (err) { toast(err.message, true); }
  });
  // 月报图片：先交给网关落成文件，再走「保存到」/ 系统分享；都没有就让浏览器自己下载
  async function usCardFile() {
    const [y, m] = us.month, name = `cccodroid-usage-${y}-${String(m + 1).padStart(2, "0")}.png`;
    const data = $("us-card").toDataURL("image/png");
    return { name, data, file: (await post("/api/usage/card", { name, data: data.split(",")[1] })).file };
  }
  $("us-actions").addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    const [y, m] = us.month;
    try {
      if (act === "save") {
        const r = await usCardFile();
        if (canSaveAs()) return saveAs(r.file, "image/png");
        const a = document.createElement("a"); a.href = r.data; a.download = r.name; a.click();
      } else if (act === "share") {
        const r = await usCardFile();
        if (canShare()) {
          const j = await post("/api/app/share_file", { path: r.file, mime: "image/png" });
          if (!j.ok) toast(j.message || t("分享失败"), true);
        } else if (navigator.canShare) {
          const f = new File([await (await fetch(r.data)).blob()], r.name, { type: "image/png" });
          if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else toast(t("已保存：{name}", { name: r.file }));
        } else toast(t("已保存：{name}", { name: r.file }));
      } else if (act === "import") {
        if (confirm(t("按现存的会话记录重新补算 {d} 之前的统计？删掉的会话补不回来，那部分会变少。", { d: new Date(us.raw.since).toLocaleDateString(I18N.lang) }))) usImport(false);
      } else if (act === "clear-month") {
        if (!confirm(t("清除 {m} 的统计？", { m: usMonthName(y, m) }))) return;
        await post("/api/usage/clear", { from: usMonth0(y, m).getTime(), to: usMonth0(y, m + 1).getTime() });
        loadUsage();
      } else if (act === "clear-all") {
        if (!confirm(t("清空全部使用统计？之后从现在重新开始记。"))) return;
        await post("/api/usage/clear", { all: true });
        loadUsage();
      }
    } catch (err) { toast(err.message, true); }
  });

  async function loadEnergy() {
    api("/api/energy?view=day").then((d) => { usDash.energy = d; usPaint(); }).catch(() => {});
    try { en.data = await api("/api/energy?view=" + en.view); en.sel = -1; enRender(); if (en.data.sys) enSys(en.data.sys); }
    catch (e) { $("en-cap").textContent = "✗ " + e.message; }
  }
  $("en-seg").addEventListener("click", (e) => {
    const v = e.target.dataset && e.target.dataset.v;
    if (!v || v === en.view) return;
    en.view = v;
    $("en-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
    loadEnergy();
  });
  // 点柱子看那一格的明细，再点一下（或点同一格）回到合计
  $("en-charts").addEventListener("click", (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i == null) return;
    en.sel = en.sel === +i ? -1 : +i;
    enRender();
  });
  function enSys(s) {
    const ago = fmtDur(s.sinceMs || 0), me = s.me;
    let h = `<div class="tiny" style="margin-top:6px">${esc(me
      ? t("系统估算（自上次充满，{ago}）：本应用约 {mah} mAh，占整机已用 {used} mAh 的 {pct}；其中屏幕 {scr} mAh。在 {n} 个应用里排第 {rank}。", {
        ago, mah: Math.round(me.mah), used: Math.round(s.used), pct: s.used ? Math.round((me.mah / s.used) * 100) + "%" : "—", scr: Math.round(me.screen), n: s.apps, rank: me.rank })
      : t("系统估算（自上次充满，{ago}）：整机已用 {used} mAh，本应用没有记录。", { ago, used: Math.round(s.used) }))}</div>`;
    h += `<ul class="en-sys-list">${(s.top || []).map((a) => `<li class="${a.me ? "me" : ""}"><span>${esc(a.name)}</span><span>${Math.round(a.mah * 10) / 10} mAh</span></li>`).join("")}</ul>`;
    h += `<div class="tiny">${esc(t("安卓把亮屏时的屏幕耗电记在前台应用头上，开着看得越久排名越靠前；CPU 那部分才是应用自己干活用掉的。{time} 查询。", { time: new Date(s.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }))}</div>`;
    $("en-sys").innerHTML = h;
  }
  $("en-sys-btn").addEventListener("click", async () => {
    $("en-sys").innerHTML = `<div class="tiny">${esc(t("正在向系统查询…"))}</div>`;
    const r = await post("/api/energy/system", {}).catch((e) => ({ ok: false, message: e.message }));
    if (r.ok) enSys(r.sys);
    else $("en-sys").innerHTML = `<div class="prov-state err">${esc(t("查不到：{msg}（要先在上面开好 Shizuku）", { msg: r.message || t("失败") }))}</div>`;
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

  // ── 模型标签与快速切换（输入栏下面那一行最左边）──
  // 标签写「模型 · 思考强度」；点它从底部弹面板：上面一排思考强度，下面搜索 + 最近用过 + 全部模型。
  // 不占输入区的地方。OpenRouter 这类几十上百个模型的，靠搜索框过滤。
  const RECENT_KEY = "cc.recentModels";
  function prettyModel(name) {
    const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(name || "");
    return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2] + "." + m[3] : name || "";
  }
  function paintModel(name) {
    state.chipModel = name;
    const eff = state.settings && state.settings.effort;
    // 照设计稿拆成两片：型号（claude-opus-5-5 显示成 Opus 5.5）、思考强度
    const pretty = prettyModel(name);
    modelEl.innerHTML = `<span class="chip">${esc(pretty)}</span>${eff ? `<span class="chip">${esc(eff)}</span>` : ""}`;
    modelEl.title = name;
  }
  modelEl.setAttribute("role", "button");
  modelEl.tabIndex = 0;
  modelEl.addEventListener("click", (e) => { e.stopPropagation(); openModelPicker(); });

  async function openModelPicker() {
    if ($("model-pick")) return;
    const m = document.createElement("div");
    m.id = "model-pick";
    m.innerHTML = `<div class="sheet-panel mp-panel">
      <div class="mp-head"><b>${t("模型与思考强度")}</b><button class="mp-x" type="button" aria-label="${t("关闭")}">${uiI("x")}</button></div>
      <div class="mp-lbl">${t("思考强度")}</div><div class="mp-eff"></div>
      <div class="mp-lbl">${t("模型")}</div>
      <label class="searchbox mp-sb"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input class="mp-q" type="search" autocomplete="off" placeholder="${t("搜索模型")}"></label>
      <div class="mp-list"><div class="tiny">${t("读取中…")}</div></div>
      <div class="tiny mp-note">${t("从下一条消息起生效。")}</div></div>`;
    document.body.appendChild(m);
    const close = () => { m.remove(); removeEventListener("resize", close); };
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest(".mp-x")) close(); });
    // 宽屏：卡片宽 420、最高 宽×φ，左边对齐输入栏下的型号按钮，底边落在按钮上方 8px
    if (innerWidth >= 700) {
      m.classList.add("pop");
      // 首屏里 #model-chip 是 display:contents，自己没有盒子，量里面第一片
      const p = m.querySelector(".mp-panel"), ar = (modelEl.getBoundingClientRect().height ? modelEl : modelEl.firstElementChild || modelEl).getBoundingClientRect();
      const w = Math.min(420, innerWidth - 32);
      p.style.width = w + "px";
      const x0 = ar.left + ar.width / 2 > innerWidth / 2 ? ar.right - w : ar.left;   // 按钮在右半边就右对齐
      p.style.left = Math.max(16, Math.min(x0, innerWidth - w - 16)) + "px";
      p.style.bottom = (innerHeight - ar.top + 8) + "px";
      p.style.maxHeight = Math.min(Math.round(w * 1.618), ar.top - 8 - 16) + "px";
      addEventListener("resize", close);
    }
    let info;
    try { info = await api("/api/models"); } catch (e) { m.querySelector(".mp-list").textContent = t("拉取模型清单失败：{msg}", { msg: e.message }); return; }
    if (!m.isConnected) return;
    MODELS = info.models || MODELS;
    const cur = () => (state.settings && state.settings.model) || "";

    const effBox = m.querySelector(".mp-eff");
    const paintEff = (levels, now) => {
      const opts = [["", t("默认")], ...levels.map((l) => [l, l])];
      effBox.innerHTML = levels.length
        ? `<div class="seg mp-seg">${opts.map(([v, l]) => `<button type="button" class="${v === now ? "on" : ""}" data-eff="${esc(v)}">${esc(l)}</button>`).join("")}</div>`
        : `<span class="tiny">${t("这个模型没有可选的思考强度")}</span>`;
    };
    paintEff(info.effortLevels || [], info.effort || "");
    effBox.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-eff]");
      if (!b) return;
      await saveSettings({ effort: b.dataset.eff });
      paintEff(info.effortLevels || [], b.dataset.eff);
      const se = $("set-effort"); if (se) se.value = b.dataset.eff;
      paintModel(state.chipModel || cur() || t("默认"));
    });

    const list = m.querySelector(".mp-list"), q = m.querySelector(".mp-q");
    const row = (id, sub) => (sub = typeof sub === "string" ? { text: sub } : sub, `<button type="button" class="mp-item${id === cur() ? " cur" : ""}" data-id="${esc(id)}"><span>${esc(id || t("默认"))}</span>${sub && (sub.text || sub.img) ? `<small>${esc(sub.text || "")}${sub.img ? MM_IMG() : ""}</small>` : ""}</button>`);
    const meta = (md) => {
      if (!md) return null;
      const ctx = md.context_window ? Math.round(md.context_window / 1024) + "k" : "";
      return { text: [md.name && md.name !== md.id ? md.name : "", ctx].filter(Boolean).join(" · "), img: (md.input_modalities || []).includes("image") };
    };
    const paintList = () => {
      const kw = q.value.trim().toLowerCase();
      const all = MODELS.filter((md) => !kw || md.id.toLowerCase().includes(kw) || String(md.name || "").toLowerCase().includes(kw));
      let html = "";
      if (!kw) {
        if (info.nativeModels) html += row("", info.defaultModel ? t("（默认：{model}）", { model: info.defaultModel }) : t("（默认，由 claude 决定）"));
        const rec = (JSON.parse(localStorage.getItem(RECENT_KEY) || "[]")).filter((id) => MODELS.some((md) => md.id === id));
        if (rec.length) html += `<div class="mp-sec">${t("最近用过")}</div>` + rec.map((id) => row(id, meta(MODELS.find((md) => md.id === id)))).join("") + `<div class="mp-sec">${t("全部 {n} 个", { n: MODELS.length })}</div>`;
      }
      html += all.slice(0, 300).map((md) => row(md.id, meta(md))).join("");
      if (!all.length) html += `<div class="tiny">${MODELS.length ? t("没有匹配的模型") : t("（该厂商不提供模型清单）")}</div>`;
      list.innerHTML = html;
    };
    paintList();
    q.addEventListener("input", paintList);
    list.addEventListener("click", async (e) => {
      const b = e.target.closest(".mp-item");
      if (!b) return;
      const id = b.dataset.id;
      if (id) localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter((x) => x !== id)].slice(0, 6)));
      close();
      if (id === cur()) return;
      await saveSettings({ model: id });
      await loadModels();                                // 换模型后思考强度的档位可能不同
      const sm = $("set-model"); if (sm) sm.value = id;
      paintModel(id || state.model || t("默认"));
    });
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
            const img = (m.input_modalities || []).includes("image") ? ' data-img="1"' : "";
            // 官方 /v1/models 只报能力，不报窗口 —— 报不出来就别写 "0k"
            const ctx = m.context_window ? Math.round(m.context_window / 1024) + "k" : "—";
            return `<option value="${esc(m.id)}"${img}>${esc(m.id)} · ${esc(m.name || "")} · ${ctx}</option>`;
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

  // 下拉框换成分段（照稿）：下拉框留着当真身，分段只是它的镜子 —— 选项变了、代码里改了 value 都跟着重画
  // 输入框也能挂（opts 给定选项，输入框留着填别的数）
  function segMirror(sel, label, opts) {
    const seg = document.createElement("span");
    seg.className = "seg seg-mirror";
    if (opts) sel.before(seg); else { sel.after(seg); sel.classList.add("hidden"); }
    const list = () => opts ? opts.map((v) => ({ value: v })) : [...sel.options];
    let more = false;   // 输入框模式：值不在选项里、或点了「更多」才露出输入框
    const paint = () => {
      const hit = list().some((o) => o.value === String(sel.value));
      seg.innerHTML = list().map((o) => `<button data-v="${esc(o.value)}" class="${o.value === String(sel.value) ? "on" : ""}">${esc(label(o))}</button>`).join("")
        + (opts ? `<button data-v="__more" class="${hit ? "" : "on"}">${esc(t("更多"))}</button>` : "");
      if (opts) sel.classList.toggle("hidden", hit && !more);
    };
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), "value");
    Object.defineProperty(sel, "value", { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); paint(); } });
    if (!opts) new MutationObserver(paint).observe(sel, { childList: true });
    sel.addEventListener("change", paint);
    seg.addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (!b || b.dataset.v === sel.value) return;
      if (b.dataset.v === "__more") { more = true; paint(); sel.focus(); return; }
      more = false; sel.value = b.dataset.v; sel.dispatchEvent(new Event("change")); });
    paint();
  }
  segMirror($("set-effort"), (o) => o.value || t("默认"));
  const PERM_SHORT = { default: "问我", acceptEdits: "接受编辑", plan: "计划", auto: "自动", dontAsk: "不问就拒", bypassPermissions: "全部放行" };
  segMirror($("set-perm"), (o) => t(PERM_SHORT[o.value] || o.value));
  segMirror($("set-parallel"), (o) => o.value, ["1", "2", "3", "4"]);
  // 设置里的「打开用量页」
  $("set-ov").addEventListener("click", (e) => { const b = e.target.closest("[data-gopage]"); if (b) { closeSettings(); openPage(b.dataset.gopage); } });
  function paintSetUsage() {
    const q = usDash.quota, e = $("set-us-quota");
    $("set-us-quota-row").classList.toggle("hidden", !q);
    if (!q) return;
    e.textContent = Math.round(q.used) + "%";
    const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
    $("set-us-quota-sub").textContent = at ? t("{time} 重置", { time: at.toLocaleDateString([], { weekday: "short" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
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
      paintModel(state.settings.model || state.model || t("默认"));
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
      $("set-static").checked = state.settings.staticCompat !== false;
      $("set-idlecompact").checked = state.settings.idleCompaction !== false;
    } catch {}
  }


  function renderDirs() {
    const dirs = state.settings.addDirs || [];
    $("dir-toggle").textContent = t("{n} 个", { n: dirs.length });
    $("dir-list").innerHTML = dirs.length
      ? dirs.map((d, i) => `<div class="item"><div class="it-title">${esc(d)}</div>
          <div class="it-acts"><button data-i="${i}">${t("移除")}</button></div></div>`).join("")
      : '<div class="tiny">' + t("（没有附加目录）") + '</div>';
    $("dir-list").querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const dirs2 = (state.settings.addDirs || []).filter((_, i) => i !== Number(b.dataset.i));
      await saveSettings({ addDirs: dirs2 });
    }));
  }

  // 附加目录照稿收成一个「N 个」按钮，点开才是清单和添加框
  $("dir-toggle").addEventListener("click", () => document.querySelectorAll("#dir-field .dir-more").forEach((x) => x.classList.toggle("hidden")));

  async function saveSettings(patch) {
    try {
      const r = await api("/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      state.settings = { ...state.settings, ...(r.settings || {}) };
      paintModel(state.settings.model || state.model || t("默认"));
      setPermChip(state.settings.permissionMode || "default");
      renderDirs();
            toast(t("已保存"));
      return r;
    } catch (e) { toast(e.message || t("保存失败"), true); }
  }

  $("set-provider").addEventListener("change", (e) => {
    state.provView = e.target.value; provOpen = null;
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

  $("set-static").addEventListener("change", (e) => saveSettings({ staticCompat: e.target.checked }));
  $("set-idlecompact").addEventListener("change", (e) => saveSettings({ idleCompaction: e.target.checked }));
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

  // 工具的权限：规则优先（deny > ask > allow，Bash(git:*) 这种带括号的算「按规则」），否则看权限模式；只读的工具默认允许
  const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite", "TodoRead", "Task", "Agent", "NotebookRead", "ExitPlanMode", "BashOutput", "KillShell", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  function toolPerm(name, mode, rules) {
    const hit = (list) => (list || []).some((r) => r === name || (r.endsWith("*") && name.startsWith(r.slice(0, -1))));
    const part = (list) => (list || []).some((r) => r.startsWith(name + "("));
    if (hit(rules.deny)) return "deny";
    if (hit(rules.ask)) return "ask";
    if (hit(rules.allow)) return "allow";
    if (mode === "bypassPermissions") return "allow";
    if (mode === "plan" && (EDIT_TOOLS.has(name) || name === "Bash")) return "deny";
    if (mode === "acceptEdits" && EDIT_TOOLS.has(name)) return "allow";
    if (READ_TOOLS.has(name)) return "allow";
    if (part(rules.allow) || part(rules.deny)) return "rule";
    return "ask";
  }
  const permPill = (p) => ({ allow: `<span class="pill ok"><svg class="ei" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg> ${t("允许")}</span>`, ask: `<span class="pill">${t("询问")}</span>`,
    deny: `<span class="pill err"><svg class="ei" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg> ${t("拒绝")}</span>`, rule: `<span class="pill acc">${t("按规则")}</span>` }[p]);
  const capRows = (arr, fn) => arr?.length ? arr.map(fn).join("") : '<div class="row"><span class="tiny">' + t("（暂无数据，先发一条消息即可从 CLI 获取）") + "</span></div>";

  function renderCaps() {
    const c = state.caps || {};
    setPageSub("caps", c.version ? t("Claude Code {ver} · 这一轮能用的", { ver: c.version }) : t("这一轮 Claude 能用的"));
    const cmds = c.slashCommands || [];
    const mcp = (c.mcpServers || []).map((m) => typeof m === "string" ? { name: m } : m);
    const mcpOk = mcp.filter((m) => /^connected$/i.test(m.status || "")).length;
    const N = { cmd: cmds.length, tool: (c.tools || []).length, skill: (c.skills || []).length, agent: (c.agents || []).length, mcp: mcp.length && mcpOk < mcp.length ? mcpOk + "/" + mcp.length : mcp.length, plugin: (c.plugins || []).length };
    // 计数格：图标 + 大号数字 + 名字；点了跳到那一节
    const icoOf = (k) => document.querySelector(`#tab-caps [data-sec="${k}"] .icobox`)?.innerHTML || "";
    const nameOf = (k) => document.querySelector(`#tab-caps [data-sec="${k}"] .sec-h h3`)?.textContent || k;
    $("cap-tiles").innerHTML = Object.keys(N).map((k) => `<button class="tile" data-sec="${k}"><span class="icobox">${icoOf(k)}</span><span class="n num">${N[k]}</span><span class="k">${esc(nameOf(k))}</span></button>`).join("");
    // 斜杠命令：卡片（命令 + 说明），点一下插进输入框
    $("caps-cmds").innerHTML = cmds.length
      ? cmds.map((x) => { const n = "/" + (x.name || x); return `<button class="cmd-card" data-cmd="${esc(n)}"><span class="mono">${esc(n)}</span><span>${esc(x.desc ? t(x.desc) : "")}</span></button>`; }).join("")
      : '<span class="tiny">' + t("（暂无数据，先发一条消息即可从 CLI 获取）") + '</span>';
    const mode = state.permissionMode || c.permissionMode || "default", rules = c.rules || { allow: [], ask: [], deny: [] };
    const nRules = rules.allow.length + rules.ask.length + rules.deny.length;
    $("caps-permline").textContent = t("权限模式：{m} · 规则 {n} 条", { m: modeLabel(mode), n: nRules });
    $("caps-tools").innerHTML = capRows(c.tools, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span>${permPill(toolPerm(x, mode, rules))}</div>`);
    $("caps-skills").innerHTML = capRows(c.skills, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span></div>`);
    $("caps-agents").innerHTML = capRows(c.agents, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span></div>`);
    $("caps-mcp").innerHTML = capRows(mcp, (m) => { const ok = /^connected$/i.test(m.status || ""), bad = /fail|error|disconn/i.test(m.status || "");
      return `<div class="row"><span class="mono grow">${esc(m.name)}</span>${sdot(ok ? "ok" : bad ? "err" : "", ok ? t("已连接") : bad ? t("没连上") : m.status || "—")}</div>`; });
    $("caps-plugins").innerHTML = capRows(c.plugins, (x) => `<div class="row"><span class="mono grow">${esc(x)}</span></div>`);
    filterCaps();
  }
  // 搜索：同时筛命令卡片和各节的标签；一节里一个都不剩就整节先藏起来
  function filterCaps() {
    const q = ($("caps-q").value || "").trim().toLowerCase();
    for (const sec of document.querySelectorAll("#tab-caps > .ext-sec-plain")) {
      let any = !q;
      for (const el of sec.querySelectorAll(".cmd-card, .panel > .row")) {
        const hit = !q || el.textContent.toLowerCase().includes(q);
        el.classList.toggle("hidden", !hit); any ||= hit;
      }
      sec.classList.toggle("hidden", !any);
    }
  }
  $("caps-q").addEventListener("input", filterCaps);
  $("caps-rules").addEventListener("click", () => openSettings("claude"));
  $("cap-tiles").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"), x = b && document.querySelector(`#tab-caps > [data-sec="${b.dataset.sec}"]`); if (!x) return;
    const body = $("page-body");
    body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - 12, behavior: "smooth" });
  });
  $("caps-cmds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]"); if (!b) return;
    closePage();
    inputEl.value = b.dataset.cmd + " "; autoGrow(); inputEl.focus();
  });

  $("btn-refresh-mcp").addEventListener("click", async () => {
    $("caps-mcp").innerHTML = '<div class="row"><span class="tiny">' + esc(t("查询中…")) + "</span></div>";
    try {
      const r = await api("/api/cli?cmd=" + encodeURIComponent("mcp list"));
      const lines = (r.out || "").split("\n").map((s) => s.trim()).filter(Boolean);
      // claude mcp list 一行一个：「名字: 命令 - ✓ Connected」/「✗ Failed to connect」
      $("caps-mcp").innerHTML = capRows(lines.filter((l) => /:\s/.test(l) && /connect|fail|need/i.test(l)).slice(0, 40), (l) => {
        const name = l.split(":")[0], ok = /✓|connected/i.test(l) && !/fail|✗/i.test(l);
        return `<div class="row"><span class="mono grow">${esc(name)}</span>${sdot(ok ? "ok" : "err", ok ? t("已连接") : t("没连上"))}</div>`;
      }) || '<div class="row"><span class="tiny">' + esc(t("(无 MCP 服务器)")) + "</span></div>";
    } catch (e) { $("caps-mcp").innerHTML = '<div class="row"><span class="tiny">' + esc(t("查询失败：{msg}", { msg: e.message })) + "</span></div>"; }
  });

  // ── 侧栏 / 整页 ───────────────────────────────────────────────────
  // 侧栏（#drawer）只放：新对话、去哪（导航）、对话列表、账户行。设置 / 能力 / 扩展 / 用量 / 帮助是主区域的整页（#pages），
  // 宽屏时侧栏和右侧窗格都留着、整页只占对话那一块；窄屏整页盖住对话，返回键回到对话。
  function openDrawer(tab) {
    if (tab && tab !== "sessions") return openPage(tab);
    drawerEl.classList.remove("hidden");
    refreshStatus();
    loadSessions();
    if (!tab) loadCaps();
    renderSideNav();
    loadProjects(); loadSched();
  }
  // 三栏宽屏时侧栏常驻在左边：开会话之类顺手的关闭不收它，只有用户点收起 / 菜单键（force）才收
  function closeDrawer(force) { if (!force && window.CCLayout && CCLayout.docked()) return; drawerEl.classList.add("hidden"); }

  const PAGES = {
    sessions: { name: tk("对话"), icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>' },
    settings: { name: tk("设置"), icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' },
    projects: { name: tk("项目"), icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
    sched: { name: tk("定时任务"), icon: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>' },
    ext: { name: tk("扩展"), icon: '<path d="M10 3h4v4a2 2 0 1 0 4 0h3v4h-4a2 2 0 1 0 0 4h4v6H3V3z"/>' },
    caps: { name: tk("能力"), icon: '<path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H12z"/>' },
    usage: { name: tk("用量"), icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
    help: { name: tk("帮助"), icon: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>' },
  };
  const NAV_ITEMS = ["sessions", "projects", "sched", "ext", "caps", "usage", "help"];          // 侧栏「去哪」里能放的；设置走底部账户行
  var curPage = null;   // var：openSession 在启动早期就会调 closePage，别撞上 let 的暂时性死区
  // 轮询（下载进度、配对状态…）只在那一页开着时继续：整页关了、换页了就停
  function pageOn(name) { return name === "settings" ? setOpen : curPage === name && !$("pages").classList.contains("hidden"); }
  (function () { try { const p = JSON.parse(localStorage.getItem("cc.navPins")); if (Array.isArray(p) && !localStorage.getItem("cc.navPinsV2")) { localStorage.setItem("cc.navPins", JSON.stringify([...new Set([...p.filter((k) => k !== "ext"), "projects", "sched"])])); } localStorage.setItem("cc.navPinsV2", "1"); } catch {} })();
  const navPins = () => { try { const p = JSON.parse(localStorage.getItem("cc.navPins")); if (Array.isArray(p)) return NAV_ITEMS.filter((k) => p.includes(k)); } catch {} return ["sessions", "projects", "sched"]; };
  var navEdit = false;
  function renderSideNav() {
    const nav = $("side-nav"); if (!nav) return;
    const pins = navPins(), more = localStorage.getItem("cc.navMore") === "1";
    const ico = (k) => `<svg viewBox="0 0 24 24">${PAGES[k].icon}</svg>`;
    const live = srv.runs.filter((x) => !x.idle).length;
    const badge = (k) => k === "sessions" && live ? `<span class="nav-badge"><i></i>${esc(t("{n} 个在跑", { n: live }))}</span>` : "";
    const item = (k) => `<button class="nav-item${curPage === k || (!curPage && !setOpen && k === "sessions") ? " on" : ""}" data-page="${k}">${ico(k)}<span>${esc(t(PAGES[k].name))}</span>${badge(k)}</button>`;
    let h = pins.map(item).join("");
    const rest = NAV_ITEMS.filter((k) => !pins.includes(k));
    h += `<button class="nav-item nav-more${more ? " open" : ""}" data-nav="more"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg><span>${esc(t("更多"))}</span><svg viewBox="0 0 24 24" class="caret"><path d="M6 9l6 6 6-6"/></svg></button>`;
    if (more) {
      h += '<div class="nav-sub">';
      if (navEdit) h += NAV_ITEMS.map((k) => `<label class="nav-item">${ico(k)}<span>${esc(t(PAGES[k].name))}</span><input type="checkbox" data-pin="${k}"${pins.includes(k) ? " checked" : ""}></label>`).join("") + `<button class="nav-edit" data-nav="done">${esc(t("完成"))}</button>`;
      else h += rest.map(item).join("") + `<button class="nav-edit" data-nav="edit">${esc(t("自定常驻项…"))}</button>`;
      h += "</div>";
    }
    nav.innerHTML = h;
    $("side-acct")?.classList.toggle("on", !!setOpen);
  }
  $("side-nav").addEventListener("click", (e) => {
    const p = e.target.closest("[data-page]");
    if (p) { if (p.dataset.page === "projects") PJ.cur = null; if (p.dataset.page === "sched") SC.cur = null; return openPage(p.dataset.page); }
    const n = e.target.closest("[data-nav]")?.dataset.nav;
    if (n === "more") { localStorage.setItem("cc.navMore", localStorage.getItem("cc.navMore") === "1" ? "0" : "1"); navEdit = false; }
    if (n === "edit") navEdit = true;
    if (n === "done") navEdit = false;
    if (n) renderSideNav();
  });
  $("side-nav").addEventListener("change", (e) => {
    const k = e.target.dataset.pin; if (!k) return;
    const pins = navPins().filter((x) => x !== k);
    if (e.target.checked) pins.push(k);
    localStorage.setItem("cc.navPins", JSON.stringify(pins));
    renderSideNav();
  });
  $("side-new").addEventListener("click", () => { closePage(); closeDrawer(); newConversation(); });
  $("side-acct").addEventListener("click", () => acctMenu());
  // 账户行：哪家接口 + 型号；首字母当头像
  function paintAcct(s) {
    if (!s) return;
    const label = s.providerLabel || s.provider || "";
    const name = (s.keyMode === "login" && acctEmail) || label;
    $("acct-av").textContent = (name.trim()[0] || "C").toUpperCase();
    $("acct-name").textContent = name || t("设置");
    $("acct-sub").textContent = [s.keyMode === "login" && acctEmail ? label : "", prettyModel(s.model),
      s.keyMode === "login" && acctWeek != null ? t("本周额度 {p}%", { p: acctWeek }) : ""].filter(Boolean).join(" · ");
    if (s.product) $("side-title").textContent = s.product;
    // 官方账户：名字换成登录邮箱（问一次，之后十分钟内沿用）
    if (s.keyMode === "login" && Date.now() - acctEmailAt > 600000) {
      acctEmailAt = Date.now();
      api("/api/login/status").then((st) => {
        const wk = st && st.limits && st.limits.sevenDay ? Math.round(st.limits.sevenDay.used) : null;
        if (st && ((st.email && st.email !== acctEmail) || wk !== acctWeek)) { acctEmail = st.email || acctEmail; acctWeek = wk; paintAcct(s); }
      }).catch(() => {});
    }
  }
  var acctEmail = "", acctEmailAt = 0, acctWeek = null;

  // ── 弹出菜单（长按会话、账户行）：items 是 { label, icon, small, danger, fn } / "hr" / { head } ──
  function closeMenu() { document.querySelectorAll(".pop-menu").forEach((m) => m.remove()); }
  function popMenu(anchor, items, place) {
    // 同一个按钮再点一次 = 收起（侧栏账户、项目标签、⋯ 这些都走这里）
    const open = document.querySelector(".pop-menu");
    if (open && anchor && open._anchor === anchor) { closeMenu(); return null; }
    closeMenu();
    const m = document.createElement("div");
    m.className = "pop-menu";
    m._anchor = anchor;
    m.innerHTML = items.map((it, i) => it === "hr" ? "<hr>" : it.head ? `<div class="pm-head">${esc(it.head)}</div>`
      : `<button data-i="${i}" class="${it.danger ? "danger" : ""}">${it.icon ? `<svg viewBox="0 0 24 24">${it.icon}</svg>` : '<span class="pm-pad"></span>'}<span>${esc(it.label)}</span>${it.small ? `<small>${esc(it.small)}</small>` : ""}</button>`).join("");
    document.body.appendChild(m);
    const ar = anchor.getBoundingClientRect(), W = innerWidth, H = innerHeight, mw = m.offsetWidth, mh = m.offsetHeight;
    let x, y;
    if (place === "up") { m.classList.add("up"); x = ar.left + 8; m.style.width = (ar.width - 16) + "px"; y = ar.top - m.offsetHeight - 6; }   // 上弹的收在按钮里面，不溢出侧栏
    else { x = Math.min(ar.left + 24, W - mw - 8); y = ar.bottom + 2; if (y + mh > H - 8) y = Math.max(8, ar.top - mh - 2); }
    m.style.left = Math.max(8, Math.min(x, W - mw - 8)) + "px"; m.style.top = Math.max(8, y) + "px";
    m.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; closeMenu(); items[+b.dataset.i].fn(); });
    // 点菜单外面收起；点的是弹出它的那个按钮就留给 click 去切换（否则这里先关、click 又开，永远收不回去）
    setTimeout(() => addEventListener("pointerdown", function off(e) {
      if (!m.isConnected) return removeEventListener("pointerdown", off, true);
      if (m.contains(e.target) || (anchor && anchor.contains && anchor.contains(e.target))) return;
      closeMenu(); removeEventListener("pointerdown", off, true);
    }, true));
    return m;
  }
  // 下拉框不用系统弹出的选择器（深色、和主题不搭），换成同一套菜单：当前项打勾，optgroup 成小标题，
  // 长列表可滚、自动滚到当前项，宽度至少和下拉框一样。选了照常触发 input / change，原有逻辑不用改。
  const CHECK = '<path d="M5 12l5 5 9-10"/>';
  // 「能看图」标记（多模态）：图片框 + 山 + 太阳，不用 emoji
  const MM_IMG = () => `<svg class="mm-img" viewBox="0 0 24 24" role="img" aria-label="${esc(t("能看图"))}"><title>${esc(t("能看图"))}</title><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8.5 8"/></svg>`;
  function selMenu(sel) {
    closeMenu();
    const items = [];
    for (const n of sel.children) {
      if (n.tagName === "OPTGROUP") {
        items.push({ head: n.label });
        for (const o of n.children) if (!o.hidden) items.push(o);
      } else if (n.tagName === "OPTION" && !n.hidden) items.push(n);
    }
    const m = document.createElement("div");
    m.className = "pop-menu sel-menu";
    m._sel = sel;     // 记住是哪个下拉框开的：再点它本身就是收起
    m.innerHTML = items.map((it, i) => it.head != null ? `<div class="pm-head">${esc(it.head)}</div>`
      : `<button type="button" data-i="${i}" class="${it.selected ? "on" : ""}"${it.disabled ? " disabled" : ""}>`
        + (it.selected ? `<svg viewBox="0 0 24 24">${CHECK}</svg>` : '<span class="pm-pad"></span>')
        + `<span>${esc(it.textContent)}</span>${it.dataset && it.dataset.img ? MM_IMG() : ""}</button>`).join("");
    document.body.appendChild(m);
    const ar = sel.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    m.style.minWidth = Math.min(ar.width, W - 16) + "px";
    m.style.maxHeight = Math.max(160, Math.min(H * 0.6, Math.max(H - ar.bottom, ar.top) - 14)) + "px";
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let y = ar.bottom + 4;
    if (y + mh > H - 8) y = ar.top - mh - 4 >= 8 ? ar.top - mh - 4 : Math.max(8, H - mh - 8);
    const x = getComputedStyle(sel).direction === "rtl" ? ar.right - mw : ar.left;
    m.style.left = Math.max(8, Math.min(x, W - mw - 8)) + "px"; m.style.top = y + "px";
    const on = m.querySelector("button.on"); if (on) m.scrollTop = on.offsetTop - (m.clientHeight - on.offsetHeight) / 2;
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]"); if (!b || b.disabled) return;
      closeMenu();
      const o = items[+b.dataset.i];
      if (o.selected) return;
      sel.value = o.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 点外面收起；按在自己这个下拉框上不算（交给下面的 click：同一个 = 收起）
    setTimeout(() => addEventListener("pointerdown", function off(e) {
      if (!m.isConnected) return removeEventListener("pointerdown", off, true);
      if (m.contains(e.target) || sel.contains(e.target)) return;
      closeMenu(); removeEventListener("pointerdown", off, true);
    }, true));
  }
  // 捕获阶段拦住：mousedown / 触摸的 pointerdown 不让系统选择器弹出，click 打开我们的菜单；回车 / 空格同样打开。
  // 带 data-native 的保留系统选择器
  const selOk = (s) => s && !s.disabled && !s.multiple && !s.dataset.native && s.size <= 1;
  const selOf = (e) => e.target.closest && e.target.closest("select");
  addEventListener("mousedown", (e) => { if (selOk(selOf(e))) e.preventDefault(); }, true);
  addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse" && selOk(selOf(e))) e.preventDefault(); }, true);
  addEventListener("click", (e) => {
    const s = selOf(e); if (!selOk(s)) return;
    e.preventDefault();
    const open = document.querySelector(".sel-menu");
    if (open) { const same = open._sel === s; closeMenu(); if (same) return; }   // 点同一个：收起；点另一个：换成它的
    selMenu(s);
  }, true);
  addEventListener("keydown", (e) => {
    const s = selOf(e);
    if (selOk(s) && (e.key === "Enter" || e.key === " " || (e.altKey && e.key === "ArrowDown"))) { e.preventDefault(); selMenu(s); }
  }, true);
  // 所有搜索框（.searchbox）统一：有字时右侧出现清空键；系统自带的清空叉隐藏（各家 WebView 长得不一样）
  addEventListener("input", (e) => {
    const box = e.target.closest && e.target.closest(".searchbox"); if (!box || e.target.tagName !== "INPUT") return;
    if (!box.querySelector(".sb-x")) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "sb-x"; x.setAttribute("aria-label", t("清空"));
      x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
      e.target.after(x);
    }
    box.classList.toggle("has-v", !!e.target.value);
  }, true);
  addEventListener("click", (e) => {
    const x = e.target.closest && e.target.closest(".sb-x"); if (!x) return;
    e.preventDefault();
    const box = x.closest(".searchbox"), inp = box.querySelector("input");
    inp.value = ""; box.classList.remove("has-v");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.focus();
  }, true);
  const SM = {
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    export: '<path d="M12 15V3M7 8l5-5 5 5M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    chat: '<path d="M4 4h16v12H8l-4 4z"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 4a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  };

  // 侧栏的最近对话：一行一个，分组 置顶 / 今天 / 昨天 / 更早；更早的只列前一段，全部在「对话」整页
  const RECENT_MAX = 40;
  function renderSideRecent() {
    const box = $("side-recent"); if (!box) return;
    const list = state.sessions || [];
    const live = new Set(srv.runs.filter((x) => !x.idle).map((x) => x.sessionId).filter(Boolean));
    const ask = new Set(srv.runs.filter((x) => x.perms && x.perms.length).map((x) => x.sessionId).filter(Boolean));
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const t0 = d0.getTime(), y0 = t0 - 86400000;
    const groups = [[t("置顶"), list.filter((x) => x.pinned)], [t("今天"), []], [t("昨天"), []], [t("更早"), []]];
    for (const x of list) if (!x.pinned) groups[x.mtime >= t0 ? 1 : x.mtime >= y0 ? 2 : 3][1].push(x);
    const more = groups[3][1].length > RECENT_MAX;
    groups[3][1] = groups[3][1].slice(0, RECENT_MAX);
    const cur = view.sessionId && list.find((x) => x.id === view.sessionId);
    if (cur && cur.title && cur.title !== view.title) { view.title = cur.title; paintTitle(); }
    const row = (x) => `<button class="sr-item${x.id === view.sessionId ? " on" : ""}" data-sid="${esc(x.id)}" title="${esc(x.title)}">${ask.has(x.id) ? '<i class="sr-dot ask"></i>' : live.has(x.id) ? '<i class="sr-dot"></i>' : ""}<span>${esc(x.title)}</span></button>`;
    box.innerHTML = list.length
      ? groups.filter(([, l]) => l.length).map(([g, l]) => `<h4>${esc(g)}</h4>` + l.map(row).join("")).join("")
        + (more ? `<button class="sr-all" data-all>${esc(t("全部对话"))}</button>` : "")
        + `<div class="sr-hint">${esc(t("长按会话：置顶、重命名、导出、删除"))}</div>`
      : `<div class="sr-empty">${esc(t("还没有历史会话。"))}</div>`;
  }
  $("side-recent").addEventListener("click", (e) => {
    if (e.target.closest("[data-all]")) return openPage("sessions");
    const it = e.target.closest("[data-sid]"); if (!it) return;
    closeDrawer(); openSession(it.dataset.sid);
  });
  $("side-recent").addEventListener("contextmenu", (e) => {
    const it = e.target.closest("[data-sid]"); if (!it) return;
    e.preventDefault(); sessMenu(it.dataset.sid, it);
  });
  // 单个会话的操作：置顶、重命名、导出、删除（进回收站）
  function sessMenu(id, anchor) {
    const x = (state.sessions || []).find((s) => s.id === id) || (sess.hits || []).find((s) => s.id === id); if (!x) return;
    const reload = () => loadSessions();
    popMenu(anchor, [
      { label: x.pinned ? t("取消置顶") : t("置顶"), icon: SM.pin, fn: () => post(`/api/session/${encodeURIComponent(id)}/pin`, { pin: !x.pinned }).then(reload, (e) => toast(e.message, true)) },
      { label: t("移到项目…"), icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', fn: () => moveToProject(id, anchor) },
      { label: t("重命名"), icon: SM.edit, fn: () => { const n = prompt(t("新的会话名称"), x.title || ""); if (n) post(`/api/session/${encodeURIComponent(id)}/rename`, { title: n }).then(reload, (e) => toast(e.message, true)); } },
      { label: t("导出"), icon: SM.export, fn: async () => {
        if (!confirm(t("会话记录可能含有你贴过的密钥、令牌或文件内容。导出的压缩包请只发给你信任的地方。继续？"))) return;
        const r = await post("/api/sessions/export", { ids: [id] }).catch((e) => ({ ok: false, message: e.message }));
        if (!r.ok) return toast(t("导出失败：{msg}", { msg: r.message || "" }), true);
        if (canSaveAs()) saveAs(r.file, "application/zip"); else toast(t("已导出 {n} 个会话：{file}", { n: r.count, file: r.file }));
      } },
      "hr",
      { label: t("删除（进回收站）"), icon: SM.trash, danger: true, fn: async () => {
        try { await api(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
        if (view.sessionId === id) newConversation();
        reload();
        toast(t("已移进回收站（{d} 天内可恢复）", { d: sess.keepDays }));
      } },
    ]);
  }
  // 账户菜单：常用的在上，不可逆的放最下
  function acctMenu() {
    const st = state.serverStatus || {};
    const items = [
      { head: [st.providerLabel || st.provider, st.model].filter(Boolean).join(" · ") || t("设置") },
      { label: t("设置"), icon: PAGES.settings.icon, fn: () => openPage("settings") },
      { label: t("切换接口 / 账户"), icon: SM.swap, small: st.providerLabel || "", fn: () => openPage("settings", "provider") },
      { label: t("用量"), icon: PAGES.usage.icon, fn: () => openPage("usage") },
      "hr",
      { label: t("帮助"), icon: PAGES.help.icon, fn: () => openPage("help") },
      { label: t("到 GitHub 反馈"), icon: SM.chat, fn: () => $("btn-issue").click() },
      { label: t("交流群 · 讨论区"), icon: SM.people, fn: () => { openPage("help"); setTimeout(() => $("help-body").querySelector(".cm-box")?.scrollIntoView({ block: "center", behavior: "smooth" }), 400); } },
    ];
    if (st.keyMode === "login") items.push("hr", { label: t("退出登录"), icon: SM.logout, danger: true, fn: async () => {
      if (!confirm(t("退出这台设备上的 Claude 账户登录？"))) return;
      const r = await post("/api/login/logout").catch((e) => ({ ok: false, output: e.message }));
      toast(r.ok ? t("已退出登录") : t("退出失败：{msg}", { msg: r.output || r.message || "" }), !r.ok);
      refreshStatus();
    } });
    popMenu($("side-acct"), items, "up");
  }

  // ══ 项目与定时任务（照稿）════════════════════════════════════════
  // 项目 = 一个工作目录 + 自己的 CLAUDE.md + 默认型号/思考强度/权限；会话按 cwd 归到项目里（网关 gw/projects.mjs）
  // 定时任务 = 到点在本机跑一次 Claude（网关 gw/sched.mjs，App 进程活着就准点；错过的下次打开按任务设置处理）
  // PJ / SC 在文件开头声明：启动早期 openSession → renderSessions 就会用到
  var pageTitleOv = "";
  var PI = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    kebab: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    skip: '<path d="M6 6l8 6-8 6zM17 6v12"/>',
    term: '<path d="M4 17l6-5-6-5M12 19h8"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 21a2 2 0 0 1 0-4h2a3 3 0 0 0 3-3"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  function pi(n, cls) { return `<svg class="ei${cls ? " " + cls : ""}" viewBox="0 0 24 24">${PI[n]}</svg>`; }
  const jsend = (p, body, method = "POST") => api(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  function normPath(p) { return String(p || "").replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0").replace(/\/+$/, ""); }
  function pjById(id) { return PJ.list.find((p) => p.id === id) || null; }
  /** 会话的 cwd 落在哪个项目里（取最深的那个） */
  function pjOfCwd(cwd) {
    const c = normPath(cwd); if (!c) return null;
    let best = null;
    for (const p of PJ.list) { const r = normPath(p.path); if ((c === r || c.startsWith(r + "/")) && (!best || r.length > normPath(best.path).length)) best = p; }
    return best;
  }
  function pjMark(p) { return `<span class="pj-mark"><i style="background:${esc(p.color || "var(--accent)")}"></i>${esc(p.name)}</span>`; }
  function pjOfSession(id) { const s = (state.sessions || []).find((x) => x.id === id); return s ? pjOfCwd(s.cwd) : null; }
  async function loadProjects() {
    try { const r = await api("/api/projects"); PJ.list = r.projects || []; PJ.colors = r.colors || []; PJ.ws = r.workspace || ""; PJ.loaded = true; }
    catch { return; }
    paintProjChip();
    if (curPage === "projects") renderProjects();
    if (curPage === "sessions") renderSessions();
  }
  async function loadSched() {
    try { SC.data = await api("/api/sched"); } catch { return; }
    if (curPage === "sched") renderSched();
    if (curPage === "projects" && PJ.cur) renderProjects();
    if (curPage === "sessions") renderSessions();
  }
  function schedSids() { return new Set((SC.data && SC.data.sids) || []); }

  // ── 时间与频率的说法 ──
  const p2 = (n) => String(n).padStart(2, "0");
  // 星期名跟界面语言走（Intl）：WD()[0] 是周日；dayShort(1..7) 给「每周一、三」和选日按钮用（中文去掉「周」字）
  const WD = () => [0, 1, 2, 3, 4, 5, 6].map((d) => new Date(2024, 0, 7 + d).toLocaleDateString(I18N.lang, { weekday: "short" }));
  const dayShort = (d) => { const n = WD()[d % 7]; return /^zh/.test(I18N.lang) ? n.replace(/^(周|星期)/, "") : n; };
  function whenText(ms) {
    if (!ms) return "—";
    const d = new Date(ms), hm = p2(d.getHours()) + ":" + p2(d.getMinutes());
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const diff = Math.floor((ms - d0.getTime()) / 864e5);
    if (diff === 0) return t("今天 {t}", { t: hm });
    if (diff === 1) return t("明天 {t}", { t: hm });
    if (diff === -1) return t("昨天 {t}", { t: hm });
    return `${d.getMonth() + 1}-${d.getDate()} ${WD()[d.getDay()]} ${hm}`;
  }
  function freqText(f) {
    f = f || {};
    const tm = f.time || "09:00";
    if (f.kind === "daily") return t("每天 {t}", { t: tm });
    if (f.kind === "weekly") {
      const ds = (f.days || []).slice().sort();
      if (ds.length === 7) return t("每天 {t}", { t: tm });
      if (ds.join() === "1,2,3,4,5") return t("工作日 {t}", { t: tm });
      return t("每周{d} {t}", { d: ds.map(dayShort).join(/^(zh|ja)/.test(I18N.lang) ? "、" : ", "), t: tm });
    }
    if (f.kind === "monthly") return f.day === "last" ? t("每月最后一天 {t}", { t: tm }) : t("每月 {d} 号 {t}", { d: f.day || 1, t: tm });
    if (f.kind === "every") return t("每隔 {h} 小时（{a}–{b}）", { h: f.hours || 2, a: f.from || "00:00", b: f.to || "23:59" });
    if (f.kind === "once") return t("仅一次 · {d} {t}", { d: f.date || "", t: tm });
    if (f.kind === "cron") return "cron " + (f.cron || "");
    return "";
  }
  // 花费：网关记美元；中文界面按汇率换成人民币（标 ≈）
  const costText = (usd) => { const d = toDisp(+usd || 0, "USD", SC.data && SC.data.fx); return (d.approx ? "≈ " : "") + money(d.v, d.cur); };
  const durText = (ms) => !ms ? "—" : ms < 60000 ? t("{n} 秒", { n: Math.round(ms / 1000) }) : t("{m} 分 {s} 秒", { m: Math.floor(ms / 60000), s: p2(Math.round(ms % 60000 / 1000)) });
  const stIcon = (st) => st === "ok" ? `<span class="sc-st ok">${pi("check")}</span>` : st === "err" ? `<span class="sc-st err">${pi("x")}</span>` : `<span class="sc-st">${pi("skip")}</span>`;
  const swHtml = (on, attr) => `<input type="checkbox" class="sw" ${attr || ""}${on ? " checked" : ""}>`;
  const pageHead = (title, right, back) => `<div class="page-head">${back ? `<button class="icon-btn pj-back" data-a="back" aria-label="${esc(t("返回"))}">${pi("back")}</button>` : ""}<h2>${title}</h2>${right || ""}</div>`;
  const kebabBtn = (a) => `<button class="icon-btn pj-kebab" data-a="${a}" aria-label="${esc(t("更多"))}"><svg viewBox="0 0 24 24">${PI.kebab}</svg></button>`;
  const emptyRow = (txt) => `<div class="row pj-empty"><span class="muted">${esc(txt)}</span></div>`;
  function setOv(text) { pageTitleOv = text || ""; paintTitle(); }

  // ── 项目页 ──
  async function renderProjects() {
    const box = $("tab-projects");
    if (PJ.cur) return renderProject(box);
    setOv("");
    setPageSub("projects", t("{n} 个", { n: PJ.list.length }));
    const card = (p) => `<button class="pj-card" data-pj="${esc(p.id)}">
        <span class="pj-ct"><span class="pj-fold" style="color:${esc(p.color)}">${pi("folder")}</span><b>${esc(p.name)}</b></span>
        <span class="mono muted pj-path">\u200e${esc(p.path)}\u200e</span>
        <span class="muted pj-meta">${esc(t("{n} 个对话", { n: p.sessions || 0 }))} · ${esc(relTime(p.lastAt || p.created))}${p.exists === false ? ` · <span class="pj-gone">${esc(t("目录不在了"))}</span>` : ""}</span></button>`;
    box.innerHTML = pageHead(esc(t("项目")), `<button class="btn sm pj-primary" data-a="new">${pi("plus")}${esc(t("新建项目"))}</button>`) +
      `<p class="pj-lead muted">${esc(t("一个项目 = 一个工作目录，带自己的指令（CLAUDE.md）、默认型号与权限。项目里开的对话都在这个目录里跑。"))}</p>` +
      (PJ.list.length ? `<div class="pj-grid">${PJ.list.map(card).join("")}</div>`
        : `<div class="panel">${emptyRow(t("还没有项目。新建一个，或者把已有的目录收进来。"))}</div>`);
  }
  async function renderProject(box) {
    const id = PJ.cur;
    let d = PJ.detail && PJ.detail.project && PJ.detail.project.id === id ? PJ.detail : null;
    if (!d) {
      box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(t("加载中…"))}</div>`;
      try { d = PJ.detail = await api("/api/projects/" + encodeURIComponent(id)); } catch (e) { box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(e.message)}</div>`; return; }
      if (PJ.cur !== id) return;
      try { const r = await api("/api/projects/" + encodeURIComponent(id) + "/instr"); d.instr = r.text || ""; } catch { d.instr = ""; }
    }
    const p = d.project;
    setOv(p.name); setPageSub("projects", p.path);
    if (!MODELS.length) api("/api/models").then((r) => { MODELS = r.models || []; PJ.effLevels = r.effortLevels || []; if (PJ.cur === id) renderProject(box); }).catch(() => {});
    const opt = (v, l, cur) => `<option value="${esc(v)}"${v === (cur || "") ? " selected" : ""}>${esc(l)}</option>`;
    const follow = t("跟随全局");
    const modelSel = `<select data-def="model">${opt("", follow, p.model)}${MODELS.map((m) => opt(m.id, prettyModel(m.id), p.model)).join("")}${p.model && !MODELS.some((m) => m.id === p.model) ? opt(p.model, prettyModel(p.model), p.model) : ""}</select>`;
    const effs = PJ.effLevels && PJ.effLevels.length ? PJ.effLevels : ["low", "medium", "high", "xhigh", "max"];
    const effSel = `<select data-def="effort">${opt("", follow, p.effort)}${effs.map((e) => opt(e, e, p.effort)).join("")}</select>`;
    const permSel = `<select data-def="perm">${opt("", follow, p.perm)}${["default", "acceptEdits", "plan", "auto", "dontAsk"].map((k) => opt(k, t(PERM_SHORT[k]), p.perm)).join("")}</select>`;
    const tasks = ((SC.data && SC.data.tasks) || []).filter((x) => x.projectId === id);
    const files = d.files || [];
    box.innerHTML = pageHead(`<span class="pj-fold" style="color:${esc(p.color)}">${pi("folder")}</span>${esc(p.name)}`,
        `<button class="btn sm pj-primary" data-a="chat">${pi("plus")}${esc(t("新对话"))}</button>${kebabBtn("pmenu")}`, true) +
      `<div class="mono muted pj-dpath">${esc(p.path)}${p.exists === false ? ` · <span class="pj-gone">${esc(t("目录不在了"))}</span>` : ""}</div>` +
      `<div class="pj-sec"><span class="grow">${esc(t("对话"))}（${d.sessions.length}）</span></div>
      <div class="panel">${d.sessions.length ? d.sessions.slice(0, 30).map((s) => `<div class="row pj-row" data-sid="${esc(s.id)}"><div class="grow"><div class="t1">${schedSids().has(s.id) ? pi("clock", "pj-ic") : ""}${esc(s.title)}</div><div class="muted pj-sub">${esc(relTime(s.mtime))}</div></div></div>`).join("") : emptyRow(t("还没有对话"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("指令 · CLAUDE.md"))}</span><span class="muted pj-note">${esc(t("每次对话自动带上"))}</span></div>
      <textarea class="pj-field pj-instr" placeholder="${esc(t("这个项目是什么、怎么构建、有什么规矩…"))}">${esc(d.instr || "")}</textarea>
      <div class="pj-save hidden"><button class="btn sm ghost" data-a="instr-undo">${esc(t("还原"))}</button><button class="btn sm" data-a="instr-save">${esc(t("保存"))}</button></div>
      <div class="pj-sec"><span class="grow">${esc(t("默认设置"))} <span class="muted pj-note">${esc(t("（只管这个项目里新开的对话）"))}</span></span></div>
      <div class="panel">
        <div class="row"><div class="grow"><b>${esc(t("型号"))}</b></div>${modelSel}</div>
        <div class="row"><div class="grow"><b>${esc(t("思考强度"))}</b></div>${effSel}</div>
        <div class="row"><div class="grow"><b>${esc(t("权限模式"))}</b></div>${permSel}</div>
        <div class="row"><div class="grow"><b>${esc(t("MCP 服务器"))}</b><div class="muted pj-sub">${d.mcp && d.mcp.length ? esc(t("项目自己的 .mcp.json：{list}", { list: d.mcp.join("、") })) : esc(t("没有 .mcp.json；用的是全局的"))}</div></div></div>
      </div>
      <div class="pj-sec"><span class="grow">${esc(t("文件"))}</span><button class="btn sm ghost" data-a="files">${esc(t("在文件浏览器打开"))}</button></div>
      <div class="panel pj-files">${files.length ? files.slice(0, 12).map((f) => `<div class="row pj-row" data-file="${esc(f.name)}" data-dir="${f.dir ? 1 : ""}"><span class="mono grow">${esc(f.name)}${f.dir ? "/" : ""}</span></div>`).join("") + (files.length > 12 ? `<div class="row"><span class="muted">${esc(t("还有 {n} 项", { n: files.length - 12 }))}</span></div>` : "") : emptyRow(t("（空目录）"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("记忆"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(t("{n} 条", { n: (d.memory || []).length }))}</b><div class="muted pj-sub">${esc(t("Claude 在这个项目里记下的事"))}</div></div>${(d.memory || []).length ? `<button class="btn sm ghost" data-a="memory">${esc(t("查看"))}</button>` : ""}</div></div>
      <div class="pj-sec"><span class="grow">${esc(t("定时任务"))}</span><button class="btn sm ghost" data-a="newtask">${pi("plus")}${esc(t("新建"))}</button></div>
      <div class="panel">${tasks.length ? tasks.map((x) => `<div class="row pj-row" data-task="${esc(x.id)}"><div class="grow"><div class="t1">${pi("clock", "pj-ic")}${esc(x.name)}</div><div class="muted pj-sub">${esc(freqText(x.freq))}</div></div><span class="pill ${x.on ? "acc" : ""}">${esc(x.on ? t("开") : t("关"))}</span></div>`).join("") : emptyRow(t("没有"))}</div>`;
    const ta = box.querySelector(".pj-instr");
    ta.addEventListener("input", () => box.querySelector(".pj-save").classList.toggle("hidden", ta.value === (d.instr || "")));
  }
  $("tab-projects").addEventListener("click", async (e) => {
    const box = $("tab-projects");
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "back") { PJ.cur = null; PJ.detail = null; return renderProjects(); }
    if (a === "new") return newProjectDlg();
    const card = e.target.closest("[data-pj]"); if (card) return openProject(card.dataset.pj);
    const sid = e.target.closest("[data-sid]"); if (sid) return openSession(sid.dataset.sid);
    const tk = e.target.closest("[data-task]"); if (tk) { SC.cur = tk.dataset.task; SC.detail = null; return openPage("sched"); }
    const p = PJ.detail && PJ.detail.project; if (!p) return;
    if (a === "chat") return newChatIn(p.id);
    if (a === "pmenu") return projMenu(p, e.target.closest("[data-a]"));
    if (a === "files") return openFiles(p.path);
    if (a === "memory") { const m = PJ.detail.memory[0]; return openFiles(m.path.replace(/\/[^/]+$/, "")); }
    if (a === "newtask") return taskDlg(null, { projectId: p.id });
    const f = e.target.closest("[data-file]");
    if (f) { const full = p.path.replace(/\/$/, "") + "/" + f.dataset.file; return f.dataset.dir ? openFiles(full) : openViewer(full); }
    if (a === "instr-undo") { box.querySelector(".pj-instr").value = PJ.detail.instr || ""; box.querySelector(".pj-save").classList.add("hidden"); return; }
    if (a === "instr-save") {
      const text = box.querySelector(".pj-instr").value;
      try { await jsend(`/api/projects/${encodeURIComponent(p.id)}/instr`, { text }, "PUT"); PJ.detail.instr = text; box.querySelector(".pj-save").classList.add("hidden"); toast(t("已保存")); }
      catch (err) { toast(err.message, true); }
    }
  });
  // 长按项目卡片（安卓长按 = contextmenu）：重命名、换颜色、打开目录、删除，和详情页的 ⋯ 是同一份菜单
  $("tab-projects").addEventListener("contextmenu", (e) => {
    const c = e.target.closest(".pj-card[data-pj]"); if (!c) return;
    const p = PJ.list.find((x) => x.id === c.dataset.pj); if (!p) return;
    e.preventDefault(); projMenu(p, c);
  });
  $("tab-projects").addEventListener("change", async (e) => {
    const k = e.target.dataset.def; const p = PJ.detail && PJ.detail.project; if (!k || !p) return;
    try { const r = await jsend("/api/projects/" + encodeURIComponent(p.id), { [k]: e.target.value }, "PATCH"); Object.assign(p, r.project); toast(t("已保存")); loadProjects(); }
    catch (err) { toast(err.message, true); }
  });
  function openProject(id) { PJ.cur = id; PJ.detail = null; if (curPage !== "projects") openPage("projects"); else { renderProjects(); $("page-body").scrollTop = 0; } }
  /** 在项目里开新对话：换到空白会话，记下项目，发第一条时网关在项目目录里跑 */
  function newChatIn(id) {
    closePage(); closeDrawer();
    newConversation();
    view.projectId = id || null;
    paintProjChip();
  }
  function projMenu(p, anchor) {
    popMenu(anchor, [
      { label: t("重命名"), icon: PI.edit, fn: async () => { const n = prompt(t("项目名称"), p.name); if (!n || !n.trim()) return; try { await jsend("/api/projects/" + encodeURIComponent(p.id), { name: n.trim() }, "PATCH"); PJ.detail = null; await loadProjects(); renderProjects(); } catch (e) { toast(e.message, true); } } },
      { label: t("换颜色"), icon: PI.palette, fn: () => popMenu(anchor, PJ.colors.map((c) => ({ label: c, icon: `<circle cx="12" cy="12" r="7" fill="${esc(c)}" stroke="none"/>`, fn: async () => { try { await jsend("/api/projects/" + encodeURIComponent(p.id), { color: c }, "PATCH"); PJ.detail = null; await loadProjects(); renderProjects(); } catch (e) { toast(e.message, true); } } }))) },
      { label: t("在文件浏览器打开目录"), icon: PI.folder, fn: () => openFiles(p.path) },
      { label: t("在终端打开这个目录"), icon: PI.term, fn: () => openTermAt(p.path) },
      "hr",
      { label: t("删除项目…"), icon: PI.trash, danger: true, fn: () => deleteProjectDlg(p) },
    ]);
  }
  async function openTermAt(dir) {
    await openTerm();
    if (TERM.list.some((x) => x.alive)) await newTerm({ cwd: dir });
  }

  // ── 弹层：宽屏居中（宽 560、高不过宽×φ），窄屏整页推入；返回键先关它 ──
  function dlg(title, body, foot) {
    document.querySelectorAll(".pj-ov").forEach((x) => x.remove());
    const narrow = innerWidth < 680;
    const o = document.createElement("div");
    o.className = "pj-ov" + (narrow ? " narrow" : "");
    const xb = `<button class="icon-btn" data-close aria-label="${esc(t(narrow ? "返回" : "关闭"))}"><svg viewBox="0 0 24 24">${narrow ? PI.back : PI.x}</svg></button>`;
    o.innerHTML = `<div class="pj-sheet" role="dialog" aria-modal="true"><div class="pj-shead">${narrow ? xb : ""}<h3>${esc(title)}</h3>${narrow ? "" : xb}</div>
      <div class="pj-smain">${body}</div><div class="pj-sfoot">${foot}</div></div>`;
    document.body.appendChild(o);
    o.addEventListener("click", (e) => {
      if ((e.target === o && !narrow) || e.target.closest("[data-close]")) return o.remove();
      const rc = e.target.closest(".pj-rc");
      if (rc && !rc.classList.contains("on")) { rc.parentNode.querySelectorAll(":scope > .pj-rc").forEach((x) => x.classList.toggle("on", x === rc)); rc.parentNode.dispatchEvent(new Event("pick", { bubbles: true })); }
      const sb = e.target.closest(".pj-seg button");
      if (sb) { [...sb.parentNode.children].forEach((b) => b.classList.toggle("on", b === sb)); sb.parentNode.dispatchEvent(new Event("pick", { bubbles: true })); }
    });
    return o;
  }
  const rcards = (name, opts, on) => `<div class="pj-rcs" data-name="${name}">${opts.map(([k, l, d]) => `<div class="pj-rc${k === on ? " on" : ""}" data-v="${k}" role="radio" tabindex="0"><span class="pj-dot"></span><div>${esc(l)}${d ? `<small>${d}</small>` : ""}</div></div>`).join("")}</div>`;
  const segOf = (name, opts, on) => `<span class="seg pj-seg" data-name="${name}">${opts.map(([k, l]) => `<button type="button" data-v="${k}" class="${k === on ? "on" : ""}">${esc(l)}</button>`).join("")}</span>`;
  const picked = (o, name) => { const el = o.querySelector(`[data-name="${name}"] > .on`); return el ? el.dataset.v : ""; };
  const frow = (label, inner, hint) => `<div class="pj-frow"><label>${esc(label)}</label>${inner}${hint ? `<div class="pj-hint">${hint}</div>` : ""}</div>`;

  function newProjectDlg() {
    const ws = PJ.ws || "";
    const o = dlg(t("新建项目"), frow(t("名称"), `<input class="pj-field" id="np-name" value="${esc(t("新项目"))}" autocomplete="off">`) +
      frow(t("目录"), rcards("mode", [
        ["new", t("在工作区新建"), `<span class="mono" id="np-where">${esc(ws + "/" + t("新项目"))}</span>`],
        ["dir", t("用已有的目录"), esc(t("以前在这个目录里开的对话自动归进来"))],
        ["git", t("从 git 克隆"), esc(t("填仓库地址，克隆到工作区"))],
      ], "new") + `<input class="pj-field mono hidden" id="np-dir" placeholder="${esc(ws + "/…")}" value="${esc(ws + "/")}" autocomplete="off" spellcheck="false">
        <input class="pj-field mono hidden" id="np-url" placeholder="https://github.com/…" autocomplete="off" spellcheck="false">`) +
      frow(t("指令（写进 CLAUDE.md，可留空）"), `<textarea class="pj-field" id="np-instr" placeholder="${esc(t("这个项目是什么、怎么构建、有什么规矩…"))}"></textarea>`),
      `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm" id="np-ok">${esc(t("创建"))}</button>`);
    const name = o.querySelector("#np-name");
    const sync = () => {
      const m = picked(o, "mode");
      o.querySelector("#np-dir").classList.toggle("hidden", m !== "dir");
      o.querySelector("#np-url").classList.toggle("hidden", m !== "git");
      o.querySelector("#np-where").textContent = ws + "/" + (name.value.trim() || "…");
    };
    o.addEventListener("pick", sync); name.addEventListener("input", sync);
    name.select();
    o.querySelector("#np-ok").addEventListener("click", async (e) => {
      const b = e.currentTarget, mode = picked(o, "mode");
      const body = { name: name.value.trim(), mode, path: o.querySelector("#np-dir").value.trim(), url: o.querySelector("#np-url").value.trim(), instr: o.querySelector("#np-instr").value };
      if (!body.name) return toast(t("项目名不能为空"), true);
      b.disabled = true; b.textContent = mode === "git" ? t("正在克隆…") : t("创建中…");
      try { const r = await jsend("/api/projects", body); o.remove(); await loadProjects(); toast(t("已创建项目")); openProject(r.project.id); }
      catch (err) { b.disabled = false; b.textContent = t("创建"); toast(err.message, true); }
    });
  }
  function deleteProjectDlg(p) {
    const o = dlg(t("删除项目「{n}」", { n: p.name }), rcards("how", [
      ["keep", t("只删项目，目录和对话都留着"), esc(t("对话回到「不在项目里」，目录还在 {p}", { p: p.path }))],
      ["dir", t("连目录一起删"), esc(t("对话进回收站（可恢复），目录直接删掉，不可恢复"))],
    ], "keep"), `<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm danger-fill" id="dp-ok">${esc(t("删除"))}</button>`);
    o.querySelector("#dp-ok").addEventListener("click", async () => {
      const withDir = picked(o, "how") === "dir";
      if (withDir && !confirm(t("目录 {p} 会被直接删掉，不能恢复。确定？", { p: p.path }))) return;
      try { await api(`/api/projects/${encodeURIComponent(p.id)}${withDir ? "?withDir=1" : ""}`, { method: "DELETE" }); }
      catch (err) { return toast(err.message, true); }
      o.remove(); PJ.cur = null; PJ.detail = null; await loadProjects(); loadSessions(); renderProjects(); toast(t("已删除项目"));
    });
  }

  // ── 输入栏下的项目标签 + 新会话的项目选择 ──
  function curProject() { return view.sessionId ? pjOfSession(view.sessionId) : pjById(view.projectId); }
  function paintProjChip() {
    const el = $("proj-chip"); if (!el) return;
    const p = curProject(), wel = document.documentElement.classList.contains("wel") && !view.sessionId && PJ.list.length > 0;
    el.classList.toggle("hidden", !p && !wel);
    el.classList.toggle("empty", !p);
    const CHEV = '<svg class="pj-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';
    if (p) el.innerHTML = `<span class="pj-fold" style="color:${esc(p.color)}">${pi("folder")}</span>${esc(p.name)}${wel ? CHEV : ""}`;
    else if (wel) el.innerHTML = `<span class="pj-fold">${pi("folder")}</span>${esc(t("项目"))}${CHEV}`;
  }
  $("proj-chip")?.addEventListener("click", (e) => {
    const p = curProject();
    if (view.sessionId) return p && openProject(p.id);
    popMenu(e.currentTarget, [{ label: t("不放进项目"), icon: view.projectId ? "" : PI.check, fn: () => { view.projectId = null; paintProjChip(); } },
      ...PJ.list.map((x) => ({ label: x.name, icon: x.id === view.projectId ? PI.check : PI.folder, fn: () => { view.projectId = x.id; paintProjChip(); } }))], "up");
  });
  // ── 会话：移到项目 ──
  function moveToProject(id, anchor) {
    const cur = pjOfSession(id);
    const run = (srv.runs || []).some((r) => r.sessionId === id);
    if (run) return toast(t("这个会话还在跑，等它停下再挪"), true);
    popMenu(anchor, [{ head: t("移到项目（会话记录跟着挪到项目目录）") }, { label: t("不放进项目"), icon: cur ? "" : PI.check, fn: () => mv(null) },
      ...PJ.list.map((p) => ({ label: p.name, icon: cur && cur.id === p.id ? PI.check : PI.folder, fn: () => mv(p.id) }))]);
    async function mv(pid) {
      try { await jsend(`/api/sessions/${encodeURIComponent(id)}/move`, { projectId: pid }); toast(pid ? t("已移到「{n}」", { n: pjById(pid).name }) : t("已移出项目")); loadSessions(); loadProjects(); }
      catch (err) { toast(err.message, true); }
    }
  }

  // ── 定时任务页 ──
  async function renderSched() {
    const box = $("tab-sched");
    if (SC.cur) return renderTask(box);
    setOv("");
    if (!SC.data) { box.innerHTML = pageHead(esc(t("定时任务"))) + `<div class="muted">${esc(t("加载中…"))}</div>`; return loadSched(); }
    const D = SC.data, tasks = D.tasks || [];
    const on = tasks.filter((x) => x.on), nx = on.map((x) => x.nextAt).filter(Boolean).sort((a, b) => a - b)[0];
    setPageSub("sched", t("{n} 个开着", { n: on.length }) + (nx ? " · " + t("下次 {w}", { w: whenText(nx) }) : ""));
    const byId = (id) => tasks.find((x) => x.id === id);
    const missed = (D.missed || []).map((m) => { const x = byId(m.taskId); return x ? `<div class="sc-missed">${pi("clock")}<div class="grow"><b>${esc(t("错过 1 次："))}</b>${esc(t("「{n}」{w}", { n: x.name, w: whenText(m.at) }))}</div>
        <button class="btn sm" data-missed="run" data-id="${esc(m.taskId)}" data-at="${m.at}">${esc(t("现在补跑"))}</button><button class="btn sm ghost" data-missed="skip" data-id="${esc(m.taskId)}" data-at="${m.at}">${esc(t("算了"))}</button></div>` : ""; }).join("");
    const list = tasks.filter((x) => SC.flt === "all" || (SC.flt === "on" ? x.on : !x.on));
    const running = new Set(D.running || []);
    const row = (x) => {
      const p = x.projectId && pjById(x.projectId);
      const last = running.has(x.id) ? `<span class="pill acc">${esc(t("在跑"))}</span>` : x.last ? `<span class="pill ${x.last.st === "ok" ? "ok" : x.last.st === "err" ? "err" : ""}">${x.last.st === "ok" ? pi("check") : x.last.st === "err" ? pi("x") : ""}${esc(whenText(x.last.at))}</span>` : `<span class="pill">${esc(t("没跑过"))}</span>`;
      return `<div class="row pj-row" data-task="${esc(x.id)}"><div class="grow"><div class="t1">${esc(x.name)}</div>
        <div class="muted pj-sub">${esc(freqText(x.freq))}${p ? " · " + pjMark(p) : ""} · ${esc(x.on ? (x.nextAt ? t("下次 {w}", { w: whenText(x.nextAt) }) : t("不会再跑")) : t("已关"))}</div></div>${last}${swHtml(x.on, `data-sw="${esc(x.id)}" aria-label="${esc(t("开关"))}"`)}</div>`;
    };
    const b = D.budget || {}, daily = b.daily || 0, today = b.today || 0, m = b.month || {};
    const pct = daily ? Math.min(100, today / daily * 100) : 0;
    box.innerHTML = pageHead(esc(t("定时任务")), `<button class="btn sm pj-primary" data-a="new">${pi("plus")}${esc(t("新建"))}</button>`) + missed +
      `<div class="sc-note">${esc(t("到点在本机跑一次 Claude，在指定目录里；跑完按设置通知你，结果存成一个对话。没人在旁边：要问你的操作一律当拒绝。错过的不会偷偷补跑，按每个任务的设置来。"))}</div>` +
      (tasks.length ? `<div class="seg-scroll">${segOf("flt", [["all", t("全部")], ["on", t("开着的")], ["off", t("关着的")]], SC.flt)}</div>` : "") +
      `<div class="panel">${list.length ? list.map(row).join("") : emptyRow(tasks.length ? t("没有") : t("还没有定时任务。比如每天早上让它看一眼 CI。"))}</div>
      <div class="pj-sec"><span class="grow">${esc(t("花费与额度"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(daily ? t("今天 {a} / 每日上限 {b}", { a: costText(today), b: costText(daily) }) : t("今天 {a} · 不设每日上限", { a: costText(today) }))}</b>
          ${daily ? `<div class="bar-mini"><i style="width:${pct.toFixed(1)}%"></i></div>` : ""}<div class="muted pj-sub">${esc(t("到上限后当天其余任务跳过，并通知你。第三方接口多数不回报花费，按 0 记。"))}</div></div><button class="btn sm ghost" data-a="budget">${esc(t("改上限"))}</button></div>
        <div class="row"><div class="grow"><b>${esc(t("本月 {c} · 跑了 {n} 次", { c: costText(m.cost || 0), n: m.runs || 0 }))}</b><div class="muted pj-sub">${esc(t("成功 {a} · 失败 {b} · 跳过 {c}", { a: m.ok || 0, b: m.err || 0, c: m.skip || 0 }))}</div></div></div></div>
      <div class="pj-sec"><span class="grow">${esc(t("叫醒"))}</span></div>
      <div class="panel"><div class="row"><div class="grow"><b>${esc(t("App 活着就准点跑"))}</b><div class="muted pj-sub">${esc(t("计时在网关里：App 开着或在后台运行时到点就跑；被系统清掉、关机时会错过，下次打开按任务的「错过了」设置处理。"))}</div></div></div>
        <div class="row"><div class="grow"><b>${esc(t("后台运行"))}</b><div class="muted pj-sub">${esc(t("锁屏后要能接着跑完，得允许后台运行、不被省电策略冻结"))}</div></div><button class="btn sm ghost" data-a="bgset">${esc(t("去设置"))}</button></div></div>`;
  }
  async function renderTask(box) {
    const id = SC.cur;
    let d = SC.detail && SC.detail.task.id === id ? SC.detail : null;
    if (!d) {
      box.innerHTML = pageHead("", "", true) + `<div class="muted">${esc(t("加载中…"))}</div>`;
      try { d = SC.detail = await api("/api/sched/" + encodeURIComponent(id)); } catch (e) { SC.cur = null; return renderSched(); }
      if (SC.cur !== id) return;
    }
    const x = d.task, p = x.projectId && pjById(x.projectId);
    setOv(x.name); setPageSub("sched", freqText(x.freq));
    const pauseNow = x.skipNext ? "skip" : x.pausedUntil > Date.now() ? "until" : "none";
    const yes = (b) => b ? t("是") : t("否");
    const kv = [
      [t("在哪"), p ? pjMark(p) : esc(t("工作区"))],
      [t("会话"), esc(x.session === "same" ? t("接着同一个对话（带着上次的上下文）") : t("每次新开一个对话"))],
      [t("型号"), esc([x.model ? prettyModel(x.model) : t("跟随项目 / 全局"), x.effort].filter(Boolean).join(" · "))],
      [t("权限"), esc((x.perm === "proj" ? t("可以改项目目录里的文件") : x.perm === "custom" ? t("只允许：{l}", { l: x.tools || "—" }) : t("只读")) + t("；要问你的操作一律当作拒绝"))],
      [t("条件"), esc([x.cond && x.cond.wifi ? t("只在 Wi-Fi 下") : "", x.cond && x.cond.charging ? t("只在充电时") : "", x.cond && x.cond.battery ? t("电量低于 {p}% 跳过", { p: x.cond.battery }) : ""].filter(Boolean).join(" · ") || t("连着网就跑"))],
      [t("撞上别的对话"), esc({ queue: t("排队等它跑完"), skip: t("跳过这次"), run: t("照跑（占一个并行名额）") }[x.busy] || "")],
      [t("上限"), esc([x.limitCost ? costText(x.limitCost) : t("花费不限"), t("{n} 分钟", { n: x.limitMin || 15 })].join(" · "))],
      [t("失败"), esc(x.retry ? t("重试 {n} 次", { n: x.retry }) : t("不重试"))],
      [t("错过"), esc({ ask: t("下次打开问我"), run: t("开机后立刻补跑一次"), skip: t("跳过") }[x.missed] || "")],
      [t("通知"), esc({ all: t("每次都通知"), fail: t("只在失败时"), found: t("只在有发现时（回复不是「{q}」）", { q: x.quiet || "—" }), none: t("不通知") }[x.notify] || "")],
      [t("结果存成对话"), esc(yes(x.saveSession !== false))],
      [t("有效期"), esc(x.freq && x.freq.kind === "once" ? t("跑完自动关") : x.until && x.until.kind === "date" ? t("到 {d} 为止", { d: x.until.date }) : x.until && x.until.kind === "count" ? t("跑满 {n} 次就关（已跑 {m} 次）", { n: x.until.count, m: x.runsDone || 0 }) : t("一直有效"))],
    ];
    const runs = (d.runs || []).filter((r) => SC.rflt === "all" || r.st !== "ok");
    box.innerHTML = pageHead(esc(x.name), `<button class="btn sm ghost" data-a="edit">${pi("edit")}${esc(t("编辑"))}</button>${kebabBtn("tmenu")}`, true) +
      `<div class="panel"><div class="row"><div class="grow"><b>${esc(x.on ? t("开着") : t("关着"))}</b><div class="muted pj-sub">${esc(freqText(x.freq))} · ${esc(x.on ? (x.nextAt ? t("下次 {w}", { w: whenText(x.nextAt) }) : t("不会再跑")) : t("不会自己跑"))}</div></div>${swHtml(x.on, `data-sw="${esc(x.id)}"`)}</div>
        <div class="row"><div class="grow"><b>${esc(t("暂停一阵"))}</b><div class="muted pj-sub">${esc(pauseNow === "until" ? t("暂停到 {w}，到时间自动恢复", { w: whenText(x.pausedUntil) }) : t("到时间自动恢复"))}</div></div>
          <select data-pause>${[["none", t("不暂停")], ["skip", t("跳过下一次")], ["1d", t("暂停 1 天")], ["1w", t("暂停 1 周")], ...(pauseNow === "until" ? [["until", t("暂停中")]] : [])].map(([k, l]) => `<option value="${k}"${k === pauseNow ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div></div>
      <div class="pj-sec"><span class="grow">${esc(t("要做的事"))}</span></div><div class="panel sc-prompt">${esc(x.prompt)}</div>
      <div class="pj-sec"><span class="grow">${esc(t("怎么跑"))}</span></div>
      <div class="panel sc-kvp"><dl class="sc-kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></div>
      <div class="pj-sec"><span class="grow">${esc(t("运行记录"))}</span>${segOf("rflt", [["all", t("全部")], ["bad", t("没成的")]], SC.rflt)}<button class="btn sm" data-a="run"${d.running ? " disabled" : ""}>${pi("play")}${esc(d.running ? t("在跑…") : t("立刻跑一次"))}</button></div>
      <div class="panel">${runs.length ? runs.map((r) => `<div class="row pj-row"${r.sid && !r.trial ? ` data-sid="${esc(r.sid)}"` : ""}>${stIcon(r.st)}<div class="grow"><div class="t1">${esc(r.msg || "—")}</div><div class="muted pj-sub">${esc([whenText(r.at), r.dur ? durText(r.dur) : "", r.st !== "skip" ? costText(r.cost || 0) : "", r.trial ? t("试跑") : "", r.attempt ? t("第 {n} 次重试", { n: r.attempt }) : ""].filter(Boolean).join(" · "))}</div></div>${r.sid ? pi("chev", "pj-go") : ""}</div>`).join("") : emptyRow(t("还没跑过"))}</div>`;
  }
  $("tab-sched").addEventListener("click", async (e) => {
    if (e.target.closest("input.sw")) return;       // 开关走 change
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "back") { SC.cur = null; SC.detail = null; renderSched(); $("page-body").scrollTop = 0; return; }
    if (a === "new") return taskDlg(null);
    if (a === "bgset") return openPage("settings", "run");
    if (a === "budget") {
      const D = SC.data || {}, cur = (D.budget && D.budget.daily) || 0;
      const v = prompt(t("每日上限（美元，0 = 不设）。定时任务当天累计花费到这里就跳过其余任务。"), String(cur));
      if (v == null) return;
      try { await jsend("/api/sched/budget", { daily: +v || 0 }, "PUT"); loadSched(); } catch (err) { toast(err.message, true); }
      return;
    }
    const ms = e.target.closest("[data-missed]");
    if (ms) { try { await jsend("/api/sched/missed", { taskId: ms.dataset.id, at: +ms.dataset.at, act: ms.dataset.missed }); toast(ms.dataset.missed === "run" ? t("已开始补跑") : t("这次就算了")); } catch (err) { toast(err.message, true); } return loadSched(); }
    const sid = e.target.closest("[data-sid]"); if (sid) return openSession(sid.dataset.sid);
    const tk = e.target.closest("[data-task]"); if (tk && !SC.cur) { SC.cur = tk.dataset.task; SC.detail = null; renderSched(); $("page-body").scrollTop = 0; return; }
    const d = SC.detail; if (!d) return;
    if (a === "edit") return taskDlg(d.task);
    if (a === "run") return runTaskNow(d.task);
    if (a === "tmenu") return taskMenu(d.task, e.target.closest("[data-a]"));
  });
  // 页面上的分段（筛选）不在弹层里：自己处理
  $("tab-sched").addEventListener("click", (e) => {
    const sb = e.target.closest(".pj-seg button"); if (!sb) return;
    const name = sb.parentNode.dataset.name;
    if (name === "flt") { SC.flt = sb.dataset.v; renderSched(); }
    if (name === "rflt") { SC.rflt = sb.dataset.v; renderSched(); }
  });
  $("tab-sched").addEventListener("change", async (e) => {
    const sw = e.target.closest("[data-sw]");
    if (sw) {
      try { const r = await jsend("/api/sched/" + encodeURIComponent(sw.dataset.sw), { on: sw.checked }, "PATCH"); toast(sw.checked ? t("已打开：{f}", { f: freqText(r.task.freq) }) : t("已关掉")); if (SC.detail) SC.detail.task = { ...SC.detail.task, ...r.task }; }
      catch (err) { sw.checked = !sw.checked; toast(err.message, true); }
      return loadSched();
    }
    const ps = e.target.closest("[data-pause]");
    if (ps && SC.detail && ps.value !== "until") {
      try { const r = await jsend(`/api/sched/${encodeURIComponent(SC.detail.task.id)}/pause`, { mode: ps.value }); SC.detail.task = { ...SC.detail.task, ...r.task }; renderSched(); loadSched(); }
      catch (err) { toast(err.message, true); }
    }
  });
  async function runTaskNow(x, trial) {
    try { const r = await jsend(`/api/sched/${encodeURIComponent(x.id)}/run`, { trial: !!trial }); if (!r.ok) throw new Error(t("没能开始（条件不满足或今天的额度用完了，看运行记录）")); toast(trial ? t("试跑开始：不计入记录，结果在新对话里") : t("已开始：会话出现在「最近」里，跑完按设置通知")); }
    catch (err) { toast(err.message, true); }
    SC.detail = null; setTimeout(loadSched, 800); if (SC.cur) setTimeout(renderSched, 900);
  }
  function taskMenu(x, anchor) {
    popMenu(anchor, [
      { label: t("立刻跑一次"), icon: PI.play, fn: () => runTaskNow(x) },
      { label: t("编辑"), icon: PI.edit, fn: () => taskDlg(x) },
      { label: t("复制一份"), icon: PI.copy, fn: () => taskDlg({ ...x, id: null, name: x.name + " " + t("（副本）") }) },
      { label: t("导出 JSON（复制到剪贴板）"), icon: SM.export, fn: () => { const { id, last, runs, nextAt, lastFiredAt, runsDone, created, lastSid, ...rest } = x; navigator.clipboard?.writeText(JSON.stringify(rest, null, 2)); toast(t("已复制")); } },
      "hr",
      { label: t("删除"), icon: PI.trash, danger: true, fn: async () => {
        if (!confirm(t("删除定时任务「{n}」？运行记录留着，存下的对话不受影响。", { n: x.name }))) return;
        try { await api("/api/sched/" + encodeURIComponent(x.id), { method: "DELETE" }); SC.cur = null; SC.detail = null; await loadSched(); renderSched(); toast(t("已删除")); } catch (err) { toast(err.message, true); }
      } },
    ]);
  }

  // ── 新建 / 编辑定时任务 ──
  function taskDlg(x, preset) {
    const edit = !!(x && x.id);
    const v = Object.assign({ name: "", prompt: "", projectId: null, freq: { kind: "daily", time: "09:00" }, session: "new", perm: "ro", tools: "", model: "", effort: "",
      cond: { wifi: false, charging: false, battery: 0 }, busy: "queue", limitCost: 0, limitMin: 15, retry: 0, missed: "ask", notify: "all", quiet: "", saveSession: true, carryLast: false, until: { kind: "ever" } }, x || {}, preset || {});
    const f = Object.assign({ time: "09:00", days: [1], day: 1, hours: 2, from: "08:00", to: "23:00", date: new Date(Date.now() + 864e5).toISOString().slice(0, 10), cron: "30 8 * * 1-5" }, v.freq);
    const opt = (val, l, cur) => `<option value="${esc(val)}"${String(val) === String(cur) ? " selected" : ""}>${esc(l)}</option>`;
    const sel = (id, opts, cur) => `<select id="${id}">${opts.map(([a, b]) => opt(a, b, cur)).join("")}</select>`;
    const line = (label, ctl, sub) => `<div class="row"><div class="grow"><b>${esc(label)}</b>${sub ? `<div class="muted pj-sub">${esc(sub)}</div>` : ""}</div>${ctl}</div>`;
    const tm = (id, val) => `<input class="pj-field pj-time" type="time" id="${id}" value="${esc(val)}">`;
    // 整句交给翻译，控件按占位符嵌进去（各语言语序不同）
    const tpl = (str, ctl) => str.split(/(\{\w+\})/).map((x) => /^\{\w+\}$/.test(x) && ctl[x.slice(1, -1)] != null ? ctl[x.slice(1, -1)] : esc(x)).join("");
    const FREQ = {
      daily: () => `<div class="pj-inline">${tpl(t("每天 {time}"), { time: tm("f-time", f.time) })}</div>`,
      weekly: () => `<div class="pj-days">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<button type="button" data-day="${d}" class="${(f.days || []).includes(d) ? "on" : ""}">${esc(dayShort(d))}</button>`).join("")}</div><div class="pj-inline">${tpl(t("这几天的 {time}"), { time: tm("f-time", f.time) })}</div>`,
      monthly: () => `<div class="pj-inline">${tpl(t("每月 {day} 的 {time}"), { day: sel("f-day", [...Array.from({ length: 28 }, (_, i) => [i + 1, t("{n} 号", { n: i + 1 })]), ["last", t("最后一天")]], f.day), time: tm("f-time", f.time) })}</div>`,
      every: () => `<div class="pj-inline">${tpl(t("每隔 {h} 小时，只在 {a} 到 {b} 之间"), { h: sel("f-hours", [1, 2, 3, 4, 6, 8, 12].map((h) => [h, String(h)]), f.hours), a: tm("f-from", f.from), b: tm("f-to", f.to) })}</div>`,
      once: () => `<div class="pj-inline"><input class="pj-field pj-date" type="date" id="f-date" value="${esc(f.date)}"> ${tm("f-time", f.time)}</div><div class="pj-hint">${esc(t("跑完自动关掉。"))}</div>`,
      cron: () => `<div class="pj-inline"><input class="pj-field mono" id="f-cron" value="${esc(f.cron)}" spellcheck="false" style="width:13em"></div><div class="pj-hint">${esc(t("标准五段式 cron：分 时 日 月 周。"))}</div>`,
    };
    const models = MODELS.length ? MODELS : [];
    const effs = PJ.effLevels && PJ.effLevels.length ? PJ.effLevels : ["low", "medium", "high", "xhigh", "max"];
    const cost = [0, 0.1, 0.3, 0.5, 1, 2, 5];
    const body = frow(t("名称"), `<input class="pj-field" id="t-name" value="${esc(v.name)}" placeholder="${esc(t("比如：每天早上看 CI"))}" autocomplete="off">`) +
      frow(t("要 Claude 做什么"), `<textarea class="pj-field" id="t-prompt" placeholder="${esc(t("写清楚做什么、做完怎么交代。没人在旁边：它不能问你问题。"))}">${esc(v.prompt)}</textarea>`,
        esc(t("想「没事就别吵我」：让它没发现时只回一句固定的话（比如「全绿」），下面的通知选「只在有发现时」。"))) +
      frow(t("在哪跑"), sel("t-proj", [["", t("工作区")], ...PJ.list.map((p) => [p.id, t("项目：{n}", { n: p.name })])], v.projectId || "")) +
      frow(t("什么时候"), `<div class="seg-scroll">${segOf("kind", [["daily", t("每天")], ["weekly", t("每周")], ["monthly", t("每月")], ["every", t("每隔几小时")], ["once", t("仅一次")], ["cron", t("自定义")]], f.kind)}</div><div class="pj-sub-form" id="t-freq">${FREQ[f.kind]()}</div><div class="pj-hint" id="t-next"></div>`) +
      frow(t("会话"), rcards("session", [["new", t("每次新开一个对话"), esc(t("互不干扰；结果一次一个，好翻"))], ["same", t("接着同一个对话"), esc(t("带着上次的上下文（适合「和上次比有什么变化」）；越跑越长，会自动压缩"))]], v.session)) +
      frow(t("权限"), rcards("perm", [["ro", t("只读"), esc(t("能看文件、跑查询类命令，不改任何东西（先这样试几天）"))], ["proj", t("可以改项目目录里的文件"), esc(t("目录外的写入、安装软件、删除等一律当作拒绝"))], ["custom", t("自己挑允许的工具"), esc(t("比如只允许 Bash(git *) 和 WebFetch；其余一律拒绝"))]], v.perm) +
        `<input class="pj-field mono${v.perm === "custom" ? "" : " hidden"}" id="t-tools" value="${esc(v.tools || "")}" placeholder="Bash(git *),WebFetch,Read" spellcheck="false">`) +
      `<button type="button" class="pj-col" data-col aria-expanded="false">${pi("chev")}${esc(t("更多设置"))}</button><div class="pj-colbody hidden">` +
      frow(t("型号"), `<div class="panel">${line(t("型号"), sel("t-model", [["", t("跟随项目 / 全局")], ...models.map((m) => [m.id, prettyModel(m.id)]), ...(v.model && !models.some((m) => m.id === v.model) ? [[v.model, prettyModel(v.model)]] : [])], v.model || ""))}${line(t("思考强度"), sel("t-effort", [["", t("跟随项目 / 全局")], ...effs.map((e) => [e, e])], v.effort || ""))}</div>`) +
      frow(t("条件（不满足就跳过这次，记一笔）"), `<div class="panel">${line(t("只在 Wi-Fi 下"), swHtml(v.cond.wifi, 'id="t-wifi"'))}${line(t("只在充电时"), swHtml(v.cond.charging, 'id="t-chg"'))}${line(t("电量低于多少就跳过"), sel("t-bat", [[0, t("不管")], [15, "15%"], [30, "30%"], [50, "50%"]], v.cond.battery || 0))}</div>`) +
      frow(t("到点时有别的对话在跑"), segOf("busy", [["queue", t("排队等它跑完")], ["skip", t("跳过这次")], ["run", t("照跑")]], v.busy), esc(t("「照跑」占一个并行名额（设置 → 后台与并行）；排队最多等 30 分钟，等不到算跳过。"))) +
      frow(t("限制"), `<div class="panel">${line(t("单次花费上限"), sel("t-cost", cost.map((c) => [c, c ? costText(c) : t("不限")]).concat(cost.includes(+v.limitCost) ? [] : [[v.limitCost, costText(v.limitCost)]]), v.limitCost || 0), t("超了就停，记成失败；第三方接口多数不回报花费"))}${line(t("单次时长上限"), sel("t-min", [5, 15, 30, 60, 90, 180].map((n) => [n, n < 60 ? t("{n} 分钟", { n }) : t("{n} 小时", { n: n / 60 })]), v.limitMin || 15))}${line(t("失败了"), sel("t-retry", [[0, t("不重试")], [1, t("重试 1 次")], [2, t("重试 2 次")]], v.retry || 0), t("网络断、接口报错、超上限"))}${line(t("错过了"), sel("t-missed", [["ask", t("下次打开问我")], ["run", t("开机后立刻补跑一次")], ["skip", t("跳过")]], v.missed), t("关机、被系统冻结、没网"))}</div>`) +
      frow(t("跑完"), `<div class="panel">${line(t("通知"), sel("t-notify", [["all", t("每次都通知")], ["fail", t("只在失败时")], ["found", t("只在有发现时")], ["none", t("不通知")]], v.notify))}
        <div class="row${v.notify === "found" ? "" : " hidden"}" id="t-quiet-row"><div class="grow"><b>${esc(t("没发现时它回的那句话"))}</b><div class="muted pj-sub">${esc(t("回复正好是这句就不通知"))}</div></div><input class="pj-field pj-quiet" id="t-quiet" value="${esc(v.quiet || "")}" placeholder="${esc(t("全绿"))}"></div>
        ${line(t("结果存成对话"), swHtml(v.saveSession !== false, 'id="t-save"'), t("列表里带时钟标记；关掉就只记在运行记录里"))}${line(t("把上一次的结果带上"), swHtml(v.carryLast, 'id="t-carry"'), t("让它知道上次说了什么（只对「每次新开」有用）"))}</div>`) +
      frow(t("有效期"), segOf("until", [["ever", t("一直有效")], ["date", t("到某天为止")], ["count", t("跑满几次就关")]], v.until.kind) +
        `<div class="pj-inline" id="t-until"><input class="pj-field pj-date${v.until.kind === "date" ? "" : " hidden"}" type="date" id="t-udate" value="${esc(v.until.date || "")}"><input class="pj-field pj-num${v.until.kind === "count" ? "" : " hidden"}" type="number" min="1" id="t-ucount" value="${esc(v.until.count || 10)}"></div>`) +
      `</div>`;
    const o = dlg(edit ? t("编辑定时任务") : t("新建定时任务"), body,
      `${edit ? `<button class="btn sm ghost pj-try" id="t-try">${esc(t("试跑一次"))}</button>` : ""}<button class="btn sm ghost" data-close>${esc(t("取消"))}</button><button class="btn sm" id="t-ok">${esc(t("保存"))}</button>`);
    const q = (s) => o.querySelector(s);
    const readFreq = () => {
      const kind = picked(o, "kind"), r = { kind };
      if (q("#f-time")) r.time = q("#f-time").value;
      if (kind === "weekly") r.days = [...o.querySelectorAll(".pj-days .on")].map((b) => +b.dataset.day);
      if (kind === "monthly") r.day = q("#f-day").value === "last" ? "last" : +q("#f-day").value;
      if (kind === "every") { r.hours = +q("#f-hours").value; r.from = q("#f-from").value; r.to = q("#f-to").value; }
      if (kind === "once") r.date = q("#f-date").value;
      if (kind === "cron") r.cron = q("#f-cron").value.trim();
      return r;
    };
    const keepFreq = () => { const r = readFreq(); Object.assign(f, r); };
    let pvT = 0, pvN = 0;
    const preview = () => { clearTimeout(pvT); pvT = setTimeout(async () => {
      const n = ++pvN;
      let r; try { r = await jsend("/api/sched/preview", { freq: readFreq() }); } catch { return; }
      if (n !== pvN || !o.isConnected) return;
      q("#t-next").textContent = r.error ? t("看不懂：{e}", { e: r.error }) : r.next.length ? t("下次 {a}", { a: whenText(r.next[0]) }) + (r.next[1] ? t("，再下次 {b}", { b: whenText(r.next[1]) }) : "") : t("算不出下一次（时间已经过了？）");
    }, 250); };
    preview();
    o.addEventListener("pick", (e) => {
      const name = e.target.dataset.name;
      if (name === "kind") { const k = picked(o, "kind"); q("#t-freq").innerHTML = FREQ[k](); preview(); }
      if (name === "perm") q("#t-tools").classList.toggle("hidden", picked(o, "perm") !== "custom");
      if (name === "until") { const k = picked(o, "until"); q("#t-udate").classList.toggle("hidden", k !== "date"); q("#t-ucount").classList.toggle("hidden", k !== "count"); }
    });
    o.addEventListener("click", (e) => {
      const d = e.target.closest("[data-day]"); if (d) { d.classList.toggle("on"); keepFreq(); preview(); }
      const c = e.target.closest("[data-col]"); if (c) { const open = c.getAttribute("aria-expanded") !== "true"; c.setAttribute("aria-expanded", String(open)); q(".pj-colbody").classList.toggle("hidden", !open); }
    });
    o.addEventListener("input", (e) => { if (e.target.closest("#t-freq")) { keepFreq(); preview(); } });
    o.addEventListener("change", (e) => {
      if (e.target.closest("#t-freq")) { keepFreq(); preview(); }
      if (e.target.id === "t-notify") q("#t-quiet-row").classList.toggle("hidden", e.target.value !== "found");
    });
    const collect = () => ({
      name: q("#t-name").value.trim(), prompt: q("#t-prompt").value.trim(), projectId: q("#t-proj").value || null, freq: readFreq(),
      session: picked(o, "session"), perm: picked(o, "perm"), tools: q("#t-tools").value.trim(), model: q("#t-model").value, effort: q("#t-effort").value,
      cond: { wifi: q("#t-wifi").checked, charging: q("#t-chg").checked, battery: +q("#t-bat").value }, busy: picked(o, "busy"),
      limitCost: +q("#t-cost").value, limitMin: +q("#t-min").value, retry: +q("#t-retry").value, missed: q("#t-missed").value,
      notify: q("#t-notify").value, quiet: q("#t-quiet").value.trim(), saveSession: q("#t-save").checked, carryLast: q("#t-carry").checked,
      until: { kind: picked(o, "until"), date: q("#t-udate").value, count: +q("#t-ucount").value },
    });
    q("#t-ok").addEventListener("click", async (e) => {
      const b = collect();
      if (!b.name || !b.prompt) return toast(t("名称和要做的事都要填"), true);
      if (b.freq.kind === "weekly" && !b.freq.days.length) return toast(t("每周至少挑一天"), true);
      if (b.notify === "found" && !b.quiet) return toast(t("「只在有发现时」要填没发现时它回的那句话"), true);
      e.currentTarget.disabled = true;
      try {
        const r = edit ? await jsend("/api/sched/" + encodeURIComponent(x.id), b, "PATCH") : await jsend("/api/sched", b);
        o.remove(); toast(edit ? t("已保存") : t("已创建：{f}", { f: freqText(r.task.freq) }));
        SC.cur = r.task.id; SC.detail = null; await loadSched();
        if (curPage !== "sched") openPage("sched"); else renderSched();
      } catch (err) { e.currentTarget.disabled = false; toast(err.message, true); }
    });
    q("#t-try")?.addEventListener("click", () => runTaskNow(x, true));
    if (!MODELS.length) api("/api/models").then((r) => { MODELS = r.models || []; PJ.effLevels = r.effortLevels || []; }).catch(() => {});
    setTimeout(() => (edit ? null : q("#t-name").focus()), 50);
  }

  // 网关推来的：任务变了 / 跑完了的提醒（App 在前台时只弹一句，后台由外壳发系统通知）
  let schedT = 0;
  function onSchedEvent(ev) {
    clearTimeout(schedT); schedT = setTimeout(() => { if (SC.detail && SC.cur) SC.detail = null; loadSched(); }, 400);
    if (ev.type === "sched_note" && !document.hidden) {
      const msg = ev.title + (ev.text ? "：" + ev.text.slice(0, 60) : "");
      if (ev.sessionId) toastAct(msg, t("打开"), () => openSession(ev.sessionId)); else toast(msg, !ev.ok);
      loadSessions();
    }
  }

  /** 打开整页：窄屏收起侧栏、盖住对话；宽屏侧栏照旧常驻，高亮当前项 */
  function openPage(name, cat) {
    if (!PAGES[name] || name === "settings") return openSettings(cat);
    const prev = curPage;
    curPage = name;
    $("pages").classList.remove("hidden");
    pageSub = "";
    paintTitle();
    document.querySelectorAll("#page-body > .tab-pane").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + name));
    if (prev !== name) $("page-body").scrollTop = 0;    // 换页从顶上看起
    closeDrawer();
    renderSideNav();
    refreshStatus();
    if (name === "sessions") loadSessions();
    if (name === "caps") loadCaps();
    if (name === "ext") loadExt();
    if (SUBNAVS[name]) paintSubnav(name);
    if (name === "help") loadHelp();
    if (name === "usage") { loadQuota(); loadUsage(); loadEnergy(); }
    if (name !== "projects" && name !== "sched") pageTitleOv = "";
    if (name === "projects") { if (prev !== name && !PJ.cur) PJ.detail = null; renderProjects(); loadProjects(); loadSched(); }
    if (name === "sched") { renderSched(); loadSched(); loadProjects(); }
  }
  function closePage() {
    if (!curPage) return;
    curPage = null;
    pageTitleOv = "";
    $("pages").classList.add("hidden");
    renderSideNav();
    paintTitle();
  }
  // 顶栏标题：对话里是会话名 + 状态；整页时是页名 + 这一页的一句概况（照设计稿，整页自己不再有标题条）
  var chatStatus = chatStatus || ["", ""], pageSub = pageSub || "";   // setStatus 可能在这行之前就调过
  function paintTitle() {
    const el = $("app-title");
    if (curPage) { el.textContent = pageTitleOv || t(PAGES[curPage].name); subEl.textContent = pageSub; subEl.className = ""; }
    else { el.textContent = view.title || t("新对话"); subEl.textContent = chatStatus[0]; subEl.className = chatStatus[1]; }
  }
  function setPageSub(name, text) { if (curPage !== name) return; pageSub = text || ""; subEl.textContent = pageSub; }

  // ── 设置：弹窗。宽屏居中（左分类、右内容）；窄屏铺满，先列分类，点进去看一类，返回键回分类 ──
  var setOpen = false;
  function openSettings(cat) {
    setOpen = true;
    $("set-ov").classList.remove("hidden");
    setCatOpen = cat || (pagesNarrow() ? null : setCatOpen || "general");
    loadQuota().catch(() => {});
    paintSetCats();
    renderSideNav();
    closeDrawer();
    loadProviders(); loadPriv(); loadUpd(); loadNotify(); loadDev(); loadReconcile(false);
  }
  function closeSettings() {
    if (!setOpen) return;
    setOpen = false;
    $("set-ov").classList.add("hidden");
    renderSideNav();
  }
  $("set-x").addEventListener("click", closeSettings);
  $("set-back").addEventListener("click", () => setBack());
  $("set-ov").addEventListener("click", (e) => { if (e.target.id === "set-ov") closeSettings(); });
  // 返回：窄屏点进了某一类先回分类列表，否则关掉设置
  function setBack() {
    if (pagesNarrow() && setCatOpen) { setCatOpen = null; paintSetCats(); $("tab-settings").scrollTop = 0; return; }
    closeSettings();
  }
  // ── 页内分区导航（扩展、能力）：吸顶一排，点了展开并滚到那一节，滚动时高亮当前节 ──
  // 节 = 页里直接挂着的 .ext-sec / .ext-sec-plain（没藏起来的）；名字取标题，计数取标题里的 .pill（「3 / 7 · 1.2 GB」只留前半）
  const SUBNAVS = { ext: "ext-subnav" };
  function subnavSecs(name) { return [...$("tab-" + name).querySelectorAll(":scope > .ext-sec, :scope > .ext-sec-plain")].filter((x) => !x.classList.contains("hidden")); }
  function paintSubnav(name) {
    const nav = $(SUBNAVS[name]); if (!nav) return;
    nav.innerHTML = subnavSecs(name).map((x) => {
      const nm = x.dataset.short ? t(x.dataset.short) : (x.querySelector(":scope > summary > span[data-i18n], :scope > summary > span.sec-name, :scope > .sec-title > span:last-child") || {}).textContent || "";
      const cnt = ((x.querySelector(":scope > summary .pill, :scope > .sec-title .pill") || {}).textContent || "").split("·")[0].trim();
      return `<button data-sec="${esc(x.dataset.sec)}">${esc(nm)}${cnt ? `<span class="cnt">${esc(cnt)}</span>` : ""}</button>`;
    }).join("");
    spySubnav();
  }
  function spySubnav() {
    const nav = curPage && $(SUBNAVS[curPage]); if (!nav) return;
    const body = $("page-body"), top = body.getBoundingClientRect().top + nav.offsetHeight + 24;
    let cur = null;
    for (const x of subnavSecs(curPage)) if (x.getBoundingClientRect().top <= top) cur = x.dataset.sec;
    if (!cur) cur = (subnavSecs(curPage)[0] || {}).dataset?.sec;
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sec === cur));
  }
  for (const [name, id] of Object.entries(SUBNAVS)) {
    $(id)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sec]"); if (!b) return;
      const x = $("tab-" + name).querySelector(`:scope > [data-sec="${b.dataset.sec}"]`); if (!x) return;
      if (x.tagName === "DETAILS") x.open = true;
      const body = $("page-body");
      body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - $(id).offsetHeight - 10, behavior: "smooth" });
    });
    // 计数、哪节显示都是异步加载出来的：内容一变就重画（下一帧合并；导航自己重画引起的变化不算）
    let raf = 0;
    new MutationObserver((recs) => { if (raf || recs.every((m) => $(id) && $(id).contains(m.target))) return; raf = requestAnimationFrame(() => { raf = 0; if (curPage === name) paintSubnav(name); }); })
      .observe($("tab-" + name), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  }
  $("page-body").addEventListener("scroll", () => { if (SUBNAVS[curPage]) spySubnav(); else if (curPage === "help") spyHelp(); }, { passive: true });


  // ── 设置分类：宽屏左栏分类 + 右边一类的内容；窄屏先是分类列表，点进去才是内容 ──
  var setCatOpen = null;
  const pagesNarrow = () => innerWidth < 680;
  // 各类内容是异步填的：有行显示 / 隐藏就在下一帧重画分类（代替原来打开后固定等 900ms 再画一次）
  let setCatRaf = 0;
  new MutationObserver(() => { if (!setOpen || setCatRaf) return; setCatRaf = requestAnimationFrame(() => { setCatRaf = 0; paintSetCats(); }); })
    .observe($("tab-settings"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  function paintSetCats() {
    paintSetUsage();
    const narrow = pagesNarrow(), cats = [...document.querySelectorAll("#set-cats [data-cat]")];
    // 一类里一项都没显示（比如开发端没有通知 / 更新）就连分类一起藏起来
    const empty = (k) => ![...document.querySelectorAll(`.set-cat[data-cat="${k}"] > :is(.srow, .sblock)`)].some((f) => !f.classList.contains("hidden"));
    cats.forEach((b) => b.classList.toggle("hidden", empty(b.dataset.cat)));
    if (!narrow && (!setCatOpen || empty(setCatOpen))) setCatOpen = "general";
    $("tab-settings").classList.toggle("set-list", narrow && !setCatOpen);
    $("tab-settings").classList.toggle("set-one", narrow && !!setCatOpen);
    cats.forEach((b) => b.classList.toggle("on", b.dataset.cat === setCatOpen));
    document.querySelectorAll(".set-cat").forEach((c) => c.classList.toggle("hidden", c.dataset.cat !== setCatOpen));
    const cb = cats.find((b) => b.dataset.cat === setCatOpen);
    $("set-title").textContent = narrow && cb ? cb.textContent.trim() : t("设置");
    $("set-ov").classList.toggle("narrow", narrow);
    $("set-back").classList.toggle("hidden", !narrow);
    $("set-x").classList.toggle("hidden", narrow);
  }
  $("set-cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    setCatOpen = b.dataset.cat; paintSetCats();
    if (pagesNarrow()) $("tab-settings").scrollTop = 0;
  });
  addEventListener("resize", () => { if (setOpen) paintSetCats(); });
  // 侧栏常驻项：打开侧栏、展开「更多」、进入勾选
  $("set-navpins").addEventListener("click", () => {
    localStorage.setItem("cc.navMore", "1"); navEdit = true;
    if (!(window.CCLayout && CCLayout.docked())) drawerEl.classList.remove("hidden");
    renderSideNav();
  });
  // 设置里较长的说明默认收成两行，点一下展开 / 收起
  $("tab-settings").addEventListener("click", (e) => {
    const p = e.target.closest(".sl p.clamp"); if (p && !e.target.closest("a, code")) p.classList.toggle("open");
  });
  // 整页从顶栏下沿开始：顶栏高度随安全区 / 手机横屏压缩而变，量出来给 CSS
  new ResizeObserver(() => document.documentElement.style.setProperty("--tbh", $("topbar").offsetHeight + "px")).observe($("topbar"), { box: "border-box" });   // 外壳注入 --safe-t 只改内边距，内容盒不变；不看边框盒就漏掉，页面层会压住顶栏


  // ── 交流群与参与：帮助页最后一节、更新说明卡片底部共用。群号为主，二维码点开才显示 ──
  const COMMUNITY = { qq: "1062538743", repo: "https://github.com/greyoak111/cccodroid" };
  function communityHtml(compact) {
    const R = COMMUNITY.repo, zh = isZh();
    return `<div class="cm-box${compact ? " compact" : ""}">
      <div class="cm-row"><span class="cm-k">${esc(t("QQ 交流群"))}</span>
        <button type="button" class="cm-num" data-cm="copy" title="${esc(t("点一下复制群号"))}">${COMMUNITY.qq}</button>
        <button type="button" class="btn ghost sm" data-cm="qr">${esc(t("二维码"))}</button></div>
      <img class="cm-qr hidden" src="/qq-group.jpg" alt="${esc(t("QQ 交流群二维码"))}" loading="lazy">
      ${compact ? "" : `<p>${esc(t("用起来有问题、有想法，欢迎进群聊。报 bug 最好走「设置 → 到 GitHub 反馈」，机型和自检结果会自动带上，群里消息一多就沉了。"))}</p>
      <p>${esc(t("这个项目目前只有作者一个人在维护，非常需要帮手：译文校对、机型适配报告、组件配方、文档、代码都欢迎，不会写代码也能帮上忙。怎么参与见仓库里的贡献指南。"))}</p>`}
      <div class="cm-links"><a href="${R}/discussions">${esc(t("讨论区"))}</a> · <a href="${R}/issues">${esc(t("反馈问题"))}</a> · <a href="${R}/blob/main/${zh ? "CONTRIBUTING.zh-CN.md" : "CONTRIBUTING.md"}">${esc(t("参与开发"))}</a></div>
    </div>`;
  }
  function communityBind(root) {
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cm]"), a = e.target.closest(".cm-links a");
      if (b && b.dataset.cm === "copy") {
        navigator.clipboard?.writeText(COMMUNITY.qq).then(() => toast(t("已复制群号 {n}", { n: COMMUNITY.qq })), () => toast(COMMUNITY.qq));
      } else if (b && b.dataset.cm === "qr") {
        const img = b.closest(".cm-box").querySelector(".cm-qr");
        img.classList.toggle("hidden");
        b.textContent = img.classList.contains("hidden") ? t("二维码") : t("收起二维码");
      } else if (a) {
        e.preventDefault();
        if (window.CCApp && CCApp.openUrl) CCApp.openUrl(a.href); else window.open(a.href, "_blank", "noopener");
      }
    });
  }

  // ── 帮助 ── 文档是 web/help/zh.md、en.md（其他语言先用英文）。第一次点开才取、才渲染。
  // 「## 」小节各包成一个 section：宽屏左边是固定目录、窄屏是顶上一排横向目录，滚动时高亮当前节；
  // 搜索框按节过滤。顶栏按钮那张表换成真图标的图例（md 里写的是字符，各语言共用一份映射）。
  let helpLang = "";
  const HELP_TOPBAR = { "☰": "btn-menu", "📁": "btn-files", ">_": "btn-term", "🌐": "btn-web", "‹›": "btn-palette", "❄": "btn-unfreeze", "＋": "btn-new" };
  function helpIcon(id) {
    const sv = $(id)?.querySelector("svg");
    return sv ? sv.outerHTML : "";
  }
  async function loadHelp() {
    const lang = /^zh/.test((window.I18N && I18N.lang) || "zh") ? "zh" : "en";
    if (helpLang === lang) return spyHelp();
    const body = $("help-body"), toc = $("help-toc");
    body.innerHTML = `<p class="muted">${esc(t("加载中…"))}</p>`;
    try {
      const r = await fetch("/help/" + lang + ".md", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setHtml(body, renderMd(await r.text()));
      // 最后一节：交流群与参与（不写在 md 里：群号、二维码、链接要能点）
      body.insertAdjacentHTML("beforeend", `<h3>${esc(t("交流群与参与"))}</h3>` + communityHtml(false));
      if (!body.dataset.cm) { body.dataset.cm = "1"; communityBind(body); }
      helpLang = lang;
    } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    // 顶栏表 → 图例
    body.querySelectorAll("table").forEach((tb) => {
      const rows = [...tb.querySelectorAll("tr")].filter((tr) => tr.querySelector("td")).map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      if (!rows.length || !rows.every((r) => HELP_TOPBAR[r[0]])) return;
      const g = document.createElement("div");
      g.className = "help-legend";
      // 「名称：说明」拆成两行（照稿：图标 + 粗体名 + 灰色说明）
      g.innerHTML = rows.map(([k, d]) => { const m = d.match(/^(.+?)[：:]\s*(.*)$/) || [0, d, ""];
        return `<div><span class="hl-ico">${helpIcon(HELP_TOPBAR[k])}</span><b>${esc(m[1])}</b><span>${esc(m[2])}</span></div>`; }).join("");
      (tb.closest(".md-table, .tbl-wrap") || tb).replaceWith(g);
    });
    // 正文里零散的 📎 换成附件图标
    const att = helpIcon("btn-attach");
    if (att) body.querySelectorAll("li, p").forEach((el) => {
      const tn = el.firstChild;
      if (tn && tn.nodeType === 3 && /^\s*📎/.test(tn.data)) { tn.data = tn.data.replace("📎", ""); el.insertAdjacentHTML("afterbegin", `<span class="hl-inl">${att}</span>`); }
    });
    // 按 h3 分节
    const lead = body.querySelector("h2");
    if (lead) lead.remove();
    const secs = [];
    let cur = null;
    for (const n of [...body.childNodes]) {
      if (n.nodeName === "H3") {
        cur = document.createElement("section");
        cur.className = "help-sec";
        cur.dataset.sec = "h" + secs.length;
        n.before(cur);
        secs.push(cur);
      }
      if (cur) cur.appendChild(n);
      else if (n.nodeType === 1) n.classList.add("help-lead");
    }
    const steps = secs[0] && secs[0].querySelector(":scope > ol");
    if (steps) {
      steps.classList.add("help-steps");
      // 「**标题**：说明」→ 标题一行、说明一行
      steps.querySelectorAll(":scope > li").forEach((li) => {
        const b = li.firstElementChild;
        if (!b || b.tagName !== "STRONG" || li.firstChild !== b) return;
        const rest = li.innerHTML.slice(b.outerHTML.length).replace(/^\s*[：:]\s*/, "");
        li.innerHTML = `<b>${b.innerHTML}</b><span>${rest}</span>`;
      });
    }
    // 已知问题：「状态 · 厂商 · **标题**：说明」→ 可折叠卡片
    const ISSUE_OK = ["修好了", "Fixed"], ISSUE_ALT = ["有绕法", "Workaround"];   // 帮助只有中英两份
    body.querySelectorAll(".help-sec li").forEach((li) => {
      const m = li.innerHTML.match(/^\s*([^·<]+?)\s*·\s*([^·<]+?)\s*·\s*<strong>(.+?)<\/strong>\s*[：:]\s*([\s\S]*)$/);
      if (!m) return;
      const ul = li.parentElement;
      const st = m[1].trim(), cls = ISSUE_OK.includes(st) ? "ok" : ISSUE_ALT.includes(st) ? "acc" : "";
      const d = document.createElement("details");
      d.className = "help-issue";
      d.innerHTML = `<summary><span class="pill ${cls}">${esc(st)}</span><b>${m[3]}</b><span class="tag">${esc(m[2].trim())}</span></summary><p>${m[4]}</p>`;
      ul.before(d);
      li.remove();
      if (!ul.children.length) ul.remove();
    });
    toc.innerHTML = secs.map((x) => `<button type="button" data-sec="${x.dataset.sec}">${esc(x.querySelector("h3").textContent)}</button>`).join("");
    $("help-q").value = "";
    spyHelp();
  }
  function helpSecs() { return [...$("help-body").querySelectorAll(".help-sec")].filter((x) => !x.classList.contains("hidden")); }
  function spyHelp() {
    const toc = $("help-toc"), body = $("page-body");
    if (curPage !== "help" || !toc.children.length) return;
    const narrow = getComputedStyle(toc).flexDirection === "row";
    const top = body.getBoundingClientRect().top + (narrow ? toc.offsetHeight : 0) + 40;
    let cur = null;
    for (const x of helpSecs()) if (x.getBoundingClientRect().top <= top) cur = x.dataset.sec;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = (helpSecs().at(-1) || {}).dataset?.sec || cur;
    if (!cur) cur = (helpSecs()[0] || {}).dataset?.sec;
    toc.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.sec === cur;
      if (on && !b.classList.contains("on") && narrow) b.scrollIntoView({ inline: "center", block: "nearest" });
      b.classList.toggle("on", on);
    });
  }
  $("help-toc").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"); if (!b) return;
    const x = $("help-body").querySelector(`.help-sec[data-sec="${b.dataset.sec}"]`); if (!x) return;
    const body = $("page-body"), toc = $("help-toc");
    const off = getComputedStyle(toc).flexDirection === "row" ? toc.offsetHeight + 8 : 8;
    body.scrollTo({ top: body.scrollTop + x.getBoundingClientRect().top - body.getBoundingClientRect().top - off, behavior: "smooth" });
  });
  $("help-q").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $("help-body").querySelectorAll(".help-sec").forEach((x) => x.classList.toggle("hidden", !!q && !x.textContent.toLowerCase().includes(q)));
    $("help-body").querySelectorAll(".help-lead").forEach((x) => x.classList.toggle("hidden", !!q));
    $("help-toc").querySelectorAll("button").forEach((b) => b.classList.toggle("hidden", !!q && !!$("help-body").querySelector(`.help-sec.hidden[data-sec="${b.dataset.sec}"]`)));
    spyHelp();
  });
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
  function closeGit() { gitEl.classList.add("hidden"); $("git-body").innerHTML = ""; $("git-sync").classList.add("hidden"); }
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
      $("git-sync").classList.add("hidden");
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
    $("git-info").textContent = s.files.length ? t("{n} 个文件有改动", { n: s.files.length }) : t("没有改动");   // 分支与领先/落后在同步栏
    gitSyncBar();
    gitRender();
  }

  // ── 同步栏：当前分支 → 上游，抓取 / 拉取 / 推送 ──
  // 拉取只做快进；分叉了就停下说清楚，可以交给 Claude 合并。推送第一次会顺便建立上游关联
  let gitBusy = "";
  function gitSyncBar() {
    const s = GIT.status, bar = $("git-sync");
    if (!s) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    const busy = (a) => gitBusy === a ? " …" : "";
    const dis = gitBusy ? "disabled" : "";
    bar.innerHTML = `<span class="gsy-br" data-a="branches" title="${esc(t("切换或新建分支"))}">⎇ ${gbdi(s.branch || "?")}</span>
      <span class="tiny gsy-up">${s.upstream ? "→ " + gbdi(s.upstream) : esc(t("还没关联远端分支"))}</span>
      <span style="flex:1"></span>
      <button class="btn ghost sm" data-a="fetch" ${dis} title="${esc(t("看看远端有没有新提交（不改动你的文件）"))}">${t("抓取")}${busy("fetch")}</button>
      <button class="btn ghost sm" data-a="pull" ${dis || (s.upstream ? "" : "disabled")} title="${esc(t("把远端的新提交拿下来（只快进）"))}">${t("拉取")}${s.behind ? " ↓" + s.behind : ""}${busy("pull")}</button>
      <button class="btn sm" data-a="push" ${dis} title="${esc(t("把本地的新提交推上去"))}">${t("推送")}${s.ahead ? " ↑" + s.ahead : ""}${busy("push")}</button>`;
  }
  $("git-sync").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]"); if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === "branches") { GIT.tab = "branches"; GIT.view = null; GIT.file = ""; return gitRender(); }
    if (gitBusy) return;
    if (a === "push" && GIT.status && !GIT.status.upstream && !confirm(t("第一次推送 {b}：会在远端建一个同名分支并关联起来。继续？", { b: GIT.status.branch }))) return;
    gitBusy = a; gitSyncBar();
    try {
      const r = await gpost(a);
      toast(r.message || t("完成"));
    } catch (err) {
      const m = err.message || "";
      // 分叉：交给 Claude 合并（它会先说明打算怎么做，冲突时会停下来问）
      if (a === "pull" && err.body && err.body.code === "diverged") {
        if (confirm(m + "\n\n" + t("让 Claude 帮你把远端的提交合并进来？"))) {
          const root = GIT.root; closeGit();
          send(t("{root} 的当前分支和远端分叉了。请先 git fetch，说明两边各有哪些提交，然后把远端的提交合并进来（能变基就变基，有冲突先停下来问我），最后告诉我结果，不要推送。", { root }));
          gitBusy = ""; return;
        }
      } else toast(m, true);
    }
    gitBusy = "";
    GIT.known = null;
    gitLoad();
  });

  function gitRender() {
    gitEl.querySelectorAll(".git-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === GIT.tab));
    if (GIT.view && GIT.view.kind === "diff") return gitShowDiff(GIT.file, GIT.view.commit);
    if (GIT.view && GIT.view.kind === "commit") return gitShowCommit(GIT.view.commit);
    if (GIT.tab === "history") return gitShowLog(GIT.file);
    if (GIT.tab === "branches") return gitShowBranches();
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

  async function gitShowBranches() {
    const box = $("git-body");
    box.innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let r;
    try { r = await gapi("branches"); } catch (e) { box.innerHTML = `<div class="vw-empty">${esc(e.message)}</div>`; return; }
    if (GIT.tab !== "branches") return;
    const row = (b, remote) => `<div class="git-row gbr${b.current ? " cur" : ""}" data-b="${esc(b.name)}" data-remote="${remote ? 1 : ""}">
        <span class="gbr-mark">${b.current ? "✓" : ""}</span>
        <span class="gp">${gbdi(b.name)}<span class="tiny gbr-sub">${esc(b.subject || "")}</span></span>
        ${b.gone ? `<span class="badge warn">${t("远端已删")}</span>` : ""}
        ${b.ahead ? `<span class="badge">↑${b.ahead}</span>` : ""}${b.behind ? `<span class="badge">↓${b.behind}</span>` : ""}
        <span class="tiny">${relTime(b.at)}</span>
        ${b.current ? "" : `<button class="btn ghost sm" data-sw="1">${remote ? t("检出") : t("切换")}</button>`}
      </div>`;
    box.innerHTML = `<div class="git-new row-actions">
        <input id="git-newbr" placeholder="${esc(t("新分支名，如 fix/login"))}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn sm" id="git-newbr-ok">${t("新建并切过去")}</button></div>
      <div class="tiny">${t("新分支从当前提交开始；没提交的改动会跟着带过去。")}</div>
      <div class="git-sec">${t("本地分支")}</div>${[...r.local].sort((x, y) => (y.current ? 1 : 0) - (x.current ? 1 : 0)).map((b) => row(b, false)).join("") || `<div class="tiny">${t("还没有提交，所以也还没有分支。")}</div>`}
      ${r.remote.length ? `<div class="git-sec">${t("只在远端的分支")}</div>${r.remote.map((b) => row(b, true)).join("")}` : ""}
      ${r.remotes.length ? "" : `<div class="tiny">${t("这个仓库还没有设置远端（remote），推送和拉取用不了。")}</div>`}`;
    const sw = async (name, create) => {
      try { const x = await gpost("switch", { branch: name, create }); toast(x.message || t("已切换")); }
      catch (e) { return toast(e.message, true); }
      GIT.known = null; GIT.sel = new Set();
      await gitLoad();
    };
    box.onclick = (e) => {
      const b = e.target.closest("[data-sw]"); if (!b) return;
      const rowEl = b.closest(".gbr");
      sw(rowEl.dataset.b, false);
    };
    $("git-newbr-ok").onclick = () => {
      const n = $("git-newbr").value.trim();
      if (!n) { toast(t("填一个分支名"), true); return $("git-newbr").focus(); }
      sw(n, true);
    };
    $("git-newbr").onkeydown = (e) => { if (e.key === "Enter") $("git-newbr-ok").click(); };
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
  const isHtml = (p) => /\.html?$/i.test(p);

  async function openViewer(path, kind, size) {
    if (VW.dirty && !confirm(t("有未保存的修改，丢弃？"))) return;
    if (VW.dirty) draftClear();
    closeViewerPdf();
    vwDropEd();
    vwHtmlStop();
    Object.assign(VW, { path, kind: kind || "other", size: size || 0, text: "", mtime: 0, dirty: false, zoom: 1, git: null, gitInfo: "", wb: null, sheets: null });
    $("vw-name").textContent = path.split("/").pop();
    $("vw-name").title = path;
    $("vw-info").textContent = fmtSize(VW.size);
    viewerEl.classList.remove("hidden");
    if (VW.kind === "text" && isHtml(path) && localStorage.getItem("cc.vw.htmlmode") !== "edit") return vwHtml();
    if (VW.kind === "text") return vwLoadText(isMd(path) ? (localStorage.getItem("cc.vw.mdmode") === "edit" ? "edit" : "md") : "edit");
    if (VW.kind === "image") return vwImage();
    if (VW.kind === "pdf") return vwPdf();
    if (VW.kind === "docx") return vwDocx();
    if (VW.kind === "sheet") return vwSheet();
    if (VW.kind === "office") return vwOffice();
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
    if (a === "md") { VW.text = vwText(); if (isMd(VW.path)) localStorage.setItem("cc.vw.mdmode", "md"); return vwRenderText("md"); }
    if (a === "edit" && VW.mode === "html") {
      // 从预览切回源码：预览期间文件可能被 Claude 改过，重新读
      localStorage.setItem("cc.vw.htmlmode", "edit");
      vwHtmlStop();
      return vwLoadText("edit");
    }
    if (a === "edit") { if (isMd(VW.path) && VW.mode === "md") localStorage.setItem("cc.vw.mdmode", "edit"); return vwRenderText("edit"); }
    if (a === "html") {
      if (VW.dirty) {
        if (!confirm(t("预览显示的是磁盘上的文件。先保存你的修改再预览？"))) return;
        return vwSave(false).then(() => { if (!VW.dirty) { localStorage.setItem("cc.vw.htmlmode", "html"); vwHtml(); } });
      }
      localStorage.setItem("cc.vw.htmlmode", "html");
      return vwHtml();
    }
    if (a === "reload") return vwHtmlReload();
    if (a === "openweb") { if (VW.pv) openWeb(VW.pv.url); return; }
    if (a === "gitdiff") return vwShowDiff();
    if (a === "aspdf") return vwOffice();
    if (a === "native") { closeViewerPdf(); return VW.kind === "docx" ? vwDocx() : vwSheet(); }
    if (a === "githist") return openGit(VW.path, { file: VW.git.rel, tab: "history" });
    if (a === "wrap") {
      VW.wrap = !VW.wrap;
      localStorage.setItem("cc.vw.wrap", VW.wrap ? "1" : "0");
      $("vw-text")?.classList.toggle("nowrap", !VW.wrap);
      gutSchedule();
      return vwRenderActs();
    }
    if (a === "zoom-" || a === "zoom+") {
      VW.zoom = Math.max(0.5, Math.min(4, VW.zoom * (a === "zoom+" ? 1.25 : 0.8)));
      return vwPdfRelayout();
    }
  });

  function vwText() { if (VW.ed) return VW.ed.getText(); const ta = $("vw-text"); return ta ? ta.value : VW.text; }
  function vwDropEd() { if (VW.ed) { try { VW.ed.destroy(); } catch {} VW.ed = null; } }

  /** 顶栏小字：大小 · git 状态 · 字数（md 编辑时） */
  function vwInfo() {
    let s = fmtSize(VW.size) + (VW.gitInfo || "");
    if (VW.ed) {
      s += " · " + t("{n} 字", { n: VW.ed.words().toLocaleString() });
      const sel = VW.ed.selWords();
      if (sel) s += " · " + t("选中 {n} 字", { n: sel.toLocaleString() });
    }
    $("vw-info").textContent = s;
  }

  // 草稿：没保存的修改每隔一会儿存进 localStorage，应用被杀、WebView 重载也不丢；保存或放弃后清掉
  const draftKey = () => "cc.draft:" + VW.path;
  function draftSave() {
    clearTimeout(VW.dt);
    VW.dt = setTimeout(() => {
      if (!VW.dirty) return;
      const text = vwText();
      if (text.length > 1024 * 1024) return;
      try { localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), text })); } catch {}
    }, 800);
  }
  function draftClear() { clearTimeout(VW.dt); try { localStorage.removeItem(draftKey()); } catch {} }
  function draftTake() {
    let d;
    try { d = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch {}
    if (!d || typeof d.text !== "string") return null;
    if (d.text === VW.text) { draftClear(); return null; }
    if (confirm(t("上次有没保存的修改（{time}），要恢复吗？\n确定：恢复\n取消：丢掉草稿", { time: new Date(d.at).toLocaleString() }))) return d.text;
    draftClear();
    return null;
  }

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
    const draft = draftTake();
    if (draft != null) { VW.text = draft; VW.dirty = true; mode = "edit"; }
    vwRenderText(mode);
    vwGitCheck();
  }

  function vwRenderActs() {
    const acts = [];
    if (isMd(VW.path)) acts.push(VW.mode === "md" ? [t("编辑"), "edit"] : [t("预览"), "md"]);
    if (isHtml(VW.path)) {
      if (VW.mode === "html") { vwActs([[t("源码"), "edit"], [t("刷新"), "reload"], [t("在浏览器打开"), "openweb"]]); return; }
      acts.push([t("预览"), "html"]);
    }
    if (VW.mode === "edit") {
      if (!isMd(VW.path)) acts.push([t("换行"), "wrap", VW.wrap]);
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
    VW.gitInfo = f ? " · " + gsTitle(f.kind) + (f.add != null ? ` +${f.add} −${f.del ?? 0}` : "") : " · " + t("和上次提交一样");
    vwInfo();
    vwRenderActs();
    VW.gitMarks = null;
    if (f && (f.kind === "modified" || f.kind === "renamed") && !f.binary) {
      try {
        const r = await api("/api/git/diff?" + new URLSearchParams({ dir: p, file: p }));
        if (p === VW.path) { VW.gitMarks = gutMarks(r.diff); gutSchedule(); }
      } catch {}
    } else gutSchedule();
  }

  // ── 编辑器行号 + git 改动标记 ──
  // 纯 textarea 没有行号：左边一列跟着滚动。自动换行时一行可能占好几行高，用一个看不见的镜像层量出每行的实际位置。
  // 标记对的是磁盘上的版本和上次提交（没保存的修改不算，存完重新算）：绿 = 新加的行，蓝 = 改过的行，红三角 = 这里删过东西。
  const GUT_MAX = 20000;                // 再长的文件不画行号，免得量一次卡半天
  let gutTimer = 0, gutRO = null;
  /** 统一 diff → Map(新文件行号 → { type, old:[原来的行] }) */
  function gutMarks(diff) {
    const m = new Map();
    let n = 0, dels = [], adds = [];
    const flush = () => {
      if (adds.length) adds.forEach((ln, i) => m.set(ln, { type: dels.length ? "mod" : "add", old: i === 0 ? dels : null, first: i === 0 }));
      else if (dels.length) m.set(n, { type: "del", old: dels });
      dels = []; adds = [];
    };
    for (const line of String(diff || "").split("\n")) {
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { flush(); n = +h[1]; continue; }
      if (!n || /^(\+\+\+|---) /.test(line) || line.startsWith("\\")) continue;
      if (line[0] === "-") { if (adds.length) flush(); dels.push(line.slice(1)); }
      else if (line[0] === "+") { adds.push(n++); }
      else if (line[0] === " ") { flush(); n++; }
    }
    flush();
    // 一段修改的所有行共用第一行记下的原文，点哪一行都能看到
    let last = null;
    for (const [ln, v] of [...m.entries()].sort((a, b) => a[0] - b[0])) { if (v.first) last = v; else if (v.type === "mod" && !v.old && last) v.old = last.old; }
    return m;
  }
  function gutAttach(ta) {
    const gin = ta.parentElement.querySelector(".vw-gut-in");
    ta.addEventListener("scroll", () => { gin.style.transform = `translateY(${-ta.scrollTop}px)`; }, { passive: true });
    if (gutRO) gutRO.disconnect();
    gutRO = new ResizeObserver(() => gutSchedule());
    gutRO.observe(ta);
    ta.parentElement.querySelector(".vw-gut").addEventListener("click", (e) => {
      const mk = e.target.closest(".gm"); if (!mk) return;
      gutPop(+mk.dataset.ln, mk);
    });
    gutSchedule();
  }
  function gutSchedule() { clearTimeout(gutTimer); gutTimer = setTimeout(gutDraw, 120); }
  function gutDraw() {
    const ta = $("vw-text"); if (!ta) return;
    const wrap = ta.parentElement, gut = wrap.querySelector(".vw-gut"), gin = wrap.querySelector(".vw-gut-in");
    const lines = ta.value.split("\n");
    if (lines.length > GUT_MAX) { gut.classList.add("hidden"); return; }
    gut.classList.remove("hidden");
    gut.style.width = (String(lines.length).length * 7.2 + 18) + "px";
    // 镜像层：和 textarea 同宽同字体同换行规则，逐行量位置
    const cs = getComputedStyle(ta);
    const mir = document.createElement("div");
    mir.className = "vw-mirror mono";
    mir.style.cssText = `position:absolute;visibility:hidden;left:0;top:0;width:${ta.clientWidth}px;box-sizing:border-box;padding:${cs.padding};font:${cs.font};line-height:${cs.lineHeight};tab-size:${cs.tabSize};white-space:${cs.whiteSpace};word-break:${cs.wordBreak};overflow-wrap:${cs.overflowWrap}`;
    const frag = document.createDocumentFragment();
    for (const l of lines) { const d = document.createElement("div"); d.textContent = l || " "; frag.appendChild(d); }
    mir.appendChild(frag);
    wrap.appendChild(mir);
    const kids = mir.children, marks = VW.gitMarks;
    const lh = parseFloat(cs.lineHeight) || 19.5;
    let html = "";
    for (let i = 0; i < kids.length; i++) {
      const top = kids[i].offsetTop, ln = i + 1, mk = marks && marks.get(ln);
      html += `<div class="gl" style="top:${top}px;height:${lh}px;line-height:${lh}px">${ln}</div>`;
      if (mk) html += mk.type === "del"
        ? `<div class="gm del" data-ln="${ln}" style="top:${top - 4}px" title="${esc(t("这里删掉了 {n} 行", { n: mk.old.length }))}"></div>`
        : `<div class="gm ${mk.type}" data-ln="${ln}" style="top:${top}px;height:${kids[i].offsetHeight}px"></div>`;
    }
    // 文件末尾删掉的行：标在最后一行下面
    if (marks) for (const [ln, mk] of marks) if (ln > kids.length && mk.type === "del") {
      const last = kids[kids.length - 1];
      html += `<div class="gm del" data-ln="${ln}" style="top:${last.offsetTop + last.offsetHeight - 4}px"></div>`;
    }
    mir.remove();
    gin.innerHTML = html;
    gin.style.transform = `translateY(${-ta.scrollTop}px)`;
  }
  /** 点标记：这一处原来是什么样 */
  function gutPop(ln, mk) {
    const v = VW.gitMarks && VW.gitMarks.get(ln); if (!v) return;
    const wrap = mk.closest(".vw-edwrap");
    wrap.querySelector(".vw-gpop")?.remove();
    const pop = document.createElement("div");
    pop.className = "vw-gpop";
    const old = v.old || [];
    pop.innerHTML = `<div class="tiny">${v.type === "add" ? t("第 {n} 行是新加的（上次提交里没有）", { n: ln }) : v.type === "del" ? t("这里删掉了 {n} 行：", { n: old.length }) : t("改过；上次提交时是：")}</div>`
      + (old.length ? `<pre class="gdel">${esc(old.slice(0, 40).join("\n"))}${old.length > 40 ? "\n…" : ""}</pre>` : "")
      + `<div class="row-actions"><button class="btn ghost sm" data-a="diff">${t("看整个文件的对比")}</button><button class="btn ghost sm" data-a="x">${t("关闭")}</button></div>`;
    pop.style.top = Math.max(4, Math.min(wrap.clientHeight - 60, parseFloat(mk.style.top) - $("vw-text").scrollTop + 22)) + "px";
    pop.onclick = (e) => { const a = e.target.dataset.a; if (a === "x") pop.remove(); if (a === "diff") { pop.remove(); vwShowDiff(); } };
    wrap.appendChild(pop);
  }

  async function vwShowDiff() {
    VW.text = vwText();
    vwDropEd();
    VW.mode = "diff";
    vwRenderActs();
    $("vw-body").innerHTML = `<div class="vw-diff">${VW.dirty ? `<div class="tiny">${t("还有没保存的修改；这里对比的是磁盘上的版本和上次提交。")}</div>` : ""}<div class="tiny">${t("读取中…")}</div></div>`;
    try {
      const r = await api("/api/git/diff?" + new URLSearchParams({ dir: VW.path, file: VW.path }));
      if (VW.mode !== "diff") return;
      $("vw-body").querySelector(".vw-diff").innerHTML = (VW.dirty ? `<div class="tiny">${t("还有没保存的修改；这里对比的是磁盘上的版本和上次提交。")}</div>` : "") + diffHtml(r.diff);
    } catch (e) { $("vw-body").querySelector(".vw-diff").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; }
  }

  // ── HTML 预览：网关另起的只读小服务里渲染（和界面不同站点，网页脚本碰不到网关），文件一改自动刷新 ──
  async function vwHtml() {
    vwDropEd();
    vwHtmlStop();
    VW.mode = "html";
    vwRenderActs();
    const p = VW.path;
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let r;
    try { r = await post("/api/preview", { path: p }); }
    catch (e) { if (p === VW.path) $("vw-body").innerHTML = `<div class="vw-empty">${t("预览打不开")}: ${esc(e.message)}</div>`; return; }
    if (p !== VW.path || VW.mode !== "html") return;
    VW.pv = { url: r.url, mtime: r.mtime };
    $("vw-body").innerHTML = `<iframe class="vw-html" src="${esc(r.url)}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock" allow="autoplay; fullscreen; clipboard-write" referrerpolicy="same-origin"></iframe>`;
    // Claude 一边改、你一边看：每 1.5 秒看一眼修改时间，变了就重新载入
    VW.pvTimer = setInterval(async () => {
      if (viewerEl.classList.contains("hidden") || VW.mode !== "html" || VW.path !== p) return vwHtmlStop();
      if (document.hidden) return;
      let s; try { s = await api("/api/file/stat?path=" + encodeURIComponent(p)); } catch { return; }
      if (VW.pv && s && s.mtime && s.mtime !== VW.pv.mtime) { VW.pv.mtime = s.mtime; VW.size = s.size; $("vw-info").textContent = fmtSize(s.size); vwHtmlReload(); }
    }, 1500);
  }
  function vwHtmlReload() {
    const f = $("vw-body").querySelector(".vw-html");
    if (f && VW.pv) f.src = VW.pv.url + (VW.pv.url.includes("?") ? "&" : "?") + "_r=" + Date.now();
  }
  function vwHtmlStop() { clearInterval(VW.pvTimer); VW.pvTimer = 0; VW.pv = null; }

  function vwRenderText(mode) {
    vwDropEd();
    VW.mode = mode;
    if (mode === "edit" && isMd(VW.path) && !VW.plainMd) { vwRenderActs(); return vwMdEditor(); }
    if (mode === "md") {
      $("vw-body").innerHTML = `<div class="vw-md bubble">${renderMd(VW.text, mdImgSrc)}</div>`;
    } else {
      $("vw-body").innerHTML = `<div class="vw-edwrap"><div class="vw-gut"><div class="vw-gut-in"></div></div><textarea id="vw-text" class="mono ${VW.wrap ? "" : "nowrap"}" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>`;
      const ta = $("vw-text");
      ta.value = VW.text;
      gutAttach(ta);
      ta.addEventListener("input", () => { if (!VW.dirty) { VW.dirty = true; vwRenderActs(); } draftSave(); gutSchedule(); });
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); vwSave(false); }
        else if (e.key === "Tab" && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand("insertText", false, "\t"); }
      });
    }
    vwRenderActs();
  }

  // ── Markdown 编辑器（CodeMirror 6，按需加载，见 claude-apk/mdedit/） ──
  let mdeditP = null;
  const loadMdEdit = () => mdeditP || (mdeditP = import("/mdedit/mdedit.js").catch((e) => { mdeditP = null; throw e; }));
  const MI = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const MDBAR = [
    ["undo", tk("撤销"), MI('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>')],
    ["redo", tk("重做"), MI('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>')],
    0,
    ["heading", tk("标题"), "H"],
    ["bold", tk("粗体"), "<b>B</b>"],
    ["italic", tk("斜体"), '<i style="font-family:Georgia,serif">I</i>'],
    ["strike", tk("删除线"), "<s>S</s>"],
    0,
    ["quote", tk("引用"), MI('<path d="M5 5v14M10 7h9M10 12h9M10 17h6"/>')],
    ["ul", tk("无序列表"), MI('<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="5" cy="6" r=".9"/><circle cx="5" cy="12" r=".9"/><circle cx="5" cy="18" r=".9"/>')],
    ["ol", tk("有序列表"), MI('<path d="M11 6h9M11 12h9M11 18h9M4 4.5h1.5V9M4 9h3M4 14.6c.6-.8 3-.9 3 .6 0 1.1-3 2-3 3.3h3.2"/>')],
    ["task", tk("任务列表"), MI('<path d="M3.5 4h7v7h-7zM5.3 7.6l1.4 1.4 2.3-2.7M13.5 7.5h7M3.5 14h7v7h-7zM13.5 17.5h7"/>')],
    0,
    ["link", tk("链接"), MI('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>')],
    ["image", tk("图片"), MI('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/>')],
    ["code", tk("代码"), MI('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>')],
    ["hr", tk("分割线"), MI('<path d="M3 12h18"/>')],
    0,
    ["search", tk("查找替换"), MI('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>')],
  ];
  /** md 里的图片地址 → 能加载的地址（相对路径按这个文件所在目录算） */
  function mdImgSrc(u) {
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    try { u = decodeURI(u); } catch {}
    let p = u.startsWith("/") ? u : VW.path.replace(/\/[^/]*$/, "") + "/" + u;
    const out = [];
    for (const seg of p.split("/")) { if (seg === "..") out.pop(); else if (seg !== "." && seg !== "") out.push(seg); }
    return fileUrl("/" + out.join("/"));
  }
  async function vwMdEditor() {
    const path = VW.path, body = $("vw-body");
    body.innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let m;
    try { m = await loadMdEdit(); } catch (e) {
      toast(t("编辑器加载失败，改用纯文本：{msg}", { msg: e.message || String(e) }), true);
      VW.plainMd = true;
      return vwRenderText("edit");
    }
    if (VW.path !== path || VW.mode !== "edit" || VW.ed) return;
    body.innerHTML = `<div class="vw-mded"></div><div class="vw-mdbar">${MDBAR.map((b) => b
      ? `<button type="button" data-md="${b[0]}" title="${esc(t(b[1]))}" aria-label="${esc(t(b[1]))}">${b[2]}</button>`
      : '<span class="sep"></span>').join("")}</div>`;
    VW.ed = m.createMdEditor(body.querySelector(".vw-mded"), {
      doc: VW.text,
      onChange: () => { if (!VW.dirty) { VW.dirty = true; vwRenderActs(); } draftSave(); },
      onSelect: () => { clearTimeout(VW.wt); VW.wt = setTimeout(vwInfo, 200); },
      onSave: () => vwSave(false),
      resolveSrc: mdImgSrc,
      placeholder: t("开始写…"),
      phrases: {
        "Find": t("查找"), "Replace": t("替换"), "next": t("下一个"), "previous": t("上一个"), "all": t("全部"),
        "match case": t("区分大小写"), "regexp": t("正则"), "by word": t("整词"),
        "replace": t("替换"), "replace all": t("全部替换"), "close": t("关闭"),
      },
      ph: {
        bold: t("粗体"), italic: t("斜体"), strike: t("删除线"), code: t("代码"),
        link: { text: t("链接文字"), url: "https://" }, image: { text: t("图片说明"), url: t("图片路径") },
      },
    });
    const bar = body.querySelector(".vw-mdbar");
    bar.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });   // 点按钮不收键盘
    bar.addEventListener("click", (e) => { const b = e.target.closest("[data-md]"); if (b && VW.ed) VW.ed.run(b.dataset.md); });
    vwInfo();
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
      draftClear();
      return vwLoadText("edit");
    }
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) return toast(t("保存失败：{msg}", { msg: j.error || r.status }), true);
    VW.text = text; VW.mtime = j.mtime; VW.size = j.size; VW.dirty = false;
    draftClear();
    vwInfo();
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

  // ── Office 文档 ──────────────────────────────────────────────────
  // docx：mammoth 转成网页（看文字、标题、表格、图片，不追求版式）；表格：SheetJS 读出来画成网格。
  // 两者都可以切到「原版式」—— 和 ppt / doc 等一样交给 LibreOffice 转成 PDF（网关缓存结果）。
  const scriptP = {};
  function loadScript(src) {
    return scriptP[src] || (scriptP[src] = new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok;
      s.onerror = () => { delete scriptP[src]; s.remove(); no(new Error(t("加载失败：{src}", { src }))); };
      document.head.appendChild(s);
    }));
  }
  async function vwFetchBuf() {
    const r = await fetch(fileUrl(VW.path));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.arrayBuffer();
  }
  const vwStill = (p0) => VW.path === p0 && !viewerEl.classList.contains("hidden");
  const vwLoading = (msg) => { $("vw-body").innerHTML = `<div class="vw-empty">${msg || t("读取中…")}</div>`; };
  function vwFail(msg, withPdf) {
    $("vw-body").innerHTML = `<div class="vw-empty"><div>${esc(msg)}</div>
      ${withPdf ? `<button class="btn ghost sm" data-a="aspdf">${t("用 LibreOffice 转成 PDF 看")}</button>` : ""}
      <a class="btn ghost sm" href="${fileUrl(VW.path, true)}" download>${t("下载")}</a></div>`;
    $("vw-body").querySelector('[data-a="aspdf"]')?.addEventListener("click", () => vwOffice());
  }

  // 文档里的东西只留看得的：去掉脚本一类元素和事件属性，链接只留 http(s) / mailto / 页内，图片只留 data:
  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button,textarea,select,base,svg,math").forEach((n) => n.remove());
    for (const el of doc.body.querySelectorAll("*")) {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith("on") || n === "style" || n === "srcset" || n === "formaction") el.removeAttribute(a.name);
      }
      if (el.hasAttribute("href")) {
        const h = el.getAttribute("href").trim();
        if (/^(https?:|mailto:)/i.test(h)) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
        else if (!h.startsWith("#")) el.removeAttribute("href");
      }
      if (el.hasAttribute("src") && !/^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i.test(el.getAttribute("src"))) el.removeAttribute("src");
    }
    return doc.body.innerHTML;
  }

  async function vwDocx() {
    const p0 = VW.path;
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let r;
    try {
      await loadScript("/office/mammoth.browser.min.js");
      r = await window.mammoth.convertToHtml({ arrayBuffer: await vwFetchBuf() });
    } catch (e) {
      if (vwStill(p0)) vwFail(t("这个文档读不出来：{msg}", { msg: e.message || String(e) }), true);
      return;
    }
    if (!vwStill(p0)) return;
    const html = cleanHtml(r.value || "");
    $("vw-body").innerHTML = `<div class="vw-doc"><article class="vw-docx bubble">${html || `<p class="dim">${t("（文档是空的）")}</p>`}</article></div>`;
    // 目录之类的页内链接：在查看器里滚过去，别去改页面地址
    $("vw-body").querySelector(".vw-docx").addEventListener("click", (e) => {
      const l = e.target.closest("a[href^=\"#\"]"); if (!l) return;
      e.preventDefault();
      const id = decodeURIComponent(l.getAttribute("href").slice(1));
      const to = id && [...$("vw-body").querySelectorAll("[id],a[name]")].find((n) => n.id === id || n.getAttribute("name") === id);
      if (to) to.scrollIntoView({ block: "start" });
    });
    const words = ($("vw-body").textContent || "").replace(/\s+/g, "").length;
    $("vw-info").textContent = `${fmtSize(VW.size)} · ${t("{n} 字", { n: words.toLocaleString() })}`;
  }

  const SHEET_MAX_R = 5000, SHEET_MAX_C = 200;
  async function vwSheet() {
    const p0 = VW.path;
    vwActs([[t("原版式"), "aspdf"]]);
    vwLoading();
    let wb;
    try {
      await loadScript("/office/xlsx.full.min.js");
      wb = window.XLSX.read(await vwFetchBuf(), { type: "array", cellStyles: false, cellNF: true });
    } catch (e) {
      if (vwStill(p0)) vwFail(t("这个表格读不出来：{msg}", { msg: e.message || String(e) }), true);
      return;
    }
    if (!vwStill(p0)) return;
    const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
    const names = wb.SheetNames.filter((n, i) => !(meta[i] && meta[i].Hidden));
    VW.wb = wb; VW.sheets = names.length ? names : wb.SheetNames;
    $("vw-body").innerHTML = `<div class="vw-sheet"><div class="vw-grid-wrap"></div>
      <div class="vw-cellbar tiny"></div>
      <div class="vw-tabs">${VW.sheets.map((n, i) => `<button class="vw-tab" data-i="${i}">${esc(n)}</button>`).join("")}</div></div>`;
    const box = $("vw-body").querySelector(".vw-sheet");
    box.querySelector(".vw-tabs").addEventListener("click", (e) => {
      const b = e.target.closest(".vw-tab"); if (b) vwSheetShow(Number(b.dataset.i));
    });
    box.querySelector(".vw-grid-wrap").addEventListener("click", (e) => {
      const td = e.target.closest("td[data-c]"); if (!td) return;
      box.querySelectorAll("td.sel").forEach((x) => x.classList.remove("sel"));
      td.classList.add("sel");
      const X = window.XLSX, ws = wb.Sheets[VW.sheets[VW.sheetI]];
      const addr = X.utils.encode_cell({ r: Number(td.parentNode.dataset.r), c: Number(td.dataset.c) });
      const cell = ws[addr];
      const val = sheetText(cell);
      box.querySelector(".vw-cellbar").textContent = `${addr}  ${val}${cell && cell.f ? `   =${cell.f}` : ""}`;
    });
    vwSheetShow(0);
  }
  // Excel 的默认日期格式（编号 14）各地显示不同，SheetJS 一律写成美式 m/d/yy —— 这种按年-月-日显示
  function sheetText(cell) {
    if (!cell) return "";
    const w = cell.w != null ? cell.w : String(cell.v ?? "");
    if (cell.t === "n" && cell.z && /^\d{1,2}\/\d{1,2}\/\d{2,4}( |$)/.test(w) && window.XLSX.SSF.is_date(cell.z)) {
      const d = window.XLSX.SSF.parse_date_code(cell.v), p = (n) => String(n).padStart(2, "0");
      if (!d) return w;
      const time = /[hs]/i.test(cell.z.replace(/"[^"]*"/g, ""));   // 格式里没有时分秒就只显示日期
      return `${d.y}-${p(d.m)}-${p(d.d)}${time ? ` ${p(d.H)}:${p(d.M)}${d.S ? ":" + p(d.S) : ""}` : ""}`;
    }
    return w;
  }
  function vwSheetShow(i) {
    const X = window.XLSX, wb = VW.wb, name = VW.sheets[i], ws = wb.Sheets[name];
    VW.sheetI = i;
    const box = $("vw-body").querySelector(".vw-sheet");
    box.querySelectorAll(".vw-tab").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
    box.querySelector(".vw-cellbar").textContent = "";
    const wrap = box.querySelector(".vw-grid-wrap");
    if (!ws || !ws["!ref"]) { wrap.innerHTML = `<div class="vw-empty">${t("（这张表是空的）")}</div>`; return; }
    const rg = X.utils.decode_range(ws["!ref"]);
    const r1 = Math.min(rg.e.r, rg.s.r + SHEET_MAX_R - 1), c1 = Math.min(rg.e.c, rg.s.c + SHEET_MAX_C - 1);
    // 合并单元格：左上角那格带 rowspan/colspan，被盖住的格子不画
    const span = new Map(), covered = new Set();
    for (const m of ws["!merges"] || []) {
      span.set(m.s.r + "," + m.s.c, [m.e.r - m.s.r + 1, m.e.c - m.s.c + 1]);
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + "," + c);
    }
    const cols = ws["!cols"] || [], rows = ws["!rows"] || [];
    let h = `<table class="vw-grid"><colgroup><col class="rh">`;
    for (let c = rg.s.c; c <= c1; c++) {
      const w = cols[c] ? (cols[c].hidden ? 0 : cols[c].wpx || (cols[c].wch ? cols[c].wch * 7 + 5 : 0)) : 0;
      h += `<col style="width:${w ? Math.max(24, Math.min(400, Math.round(w))) : 80}px">`;
    }
    h += `</colgroup><thead><tr><th class="corner"></th>`;
    for (let c = rg.s.c; c <= c1; c++) h += `<th>${X.utils.encode_col(c)}</th>`;
    h += `</tr></thead><tbody>`;
    for (let r = rg.s.r; r <= r1; r++) {
      if (rows[r] && rows[r].hidden) continue;
      h += `<tr data-r="${r}"><th>${r + 1}</th>`;
      for (let c = rg.s.c; c <= c1; c++) {
        const k = r + "," + c;
        if (covered.has(k)) continue;
        const cell = ws[X.utils.encode_cell({ r, c })];
        const sp = span.get(k);
        const txt = sheetText(cell);
        const num = cell && (cell.t === "n" || cell.t === "d");
        h += `<td data-c="${c}"${sp ? ` rowspan="${sp[0]}" colspan="${sp[1]}"` : ""}${num ? ` class="n"` : cell && cell.t === "e" ? ` class="err"` : ""}>${esc(txt)}</td>`;
      }
      h += `</tr>`;
    }
    h += `</tbody></table>`;
    const cut = rg.e.r > r1 || rg.e.c > c1;
    if (cut) h += `<div class="vw-cut tiny">${t("表太大，只显示了前 {r} 行、{c} 列；完整内容请用「原版式」或下载后用别的应用看", { r: r1 - rg.s.r + 1, c: c1 - rg.s.c + 1 })}</div>`;
    wrap.innerHTML = h;
    wrap.scrollTop = 0; wrap.scrollLeft = 0;
    $("vw-info").textContent = `${fmtSize(VW.size)} · ${name} · ${X.utils.encode_range({ s: rg.s, e: rg.e })}`;
  }

  // ppt / doc / … 以及 docx、表格的「原版式」：网关用 LibreOffice 转成 PDF（第一次要等，之后读缓存）
  async function vwOffice() {
    const p0 = VW.path, back = VW.kind === "docx" || VW.kind === "sheet";
    closeViewerPdf();
    vwActs(back ? [[t("网页版式"), "native"]] : []);
    vwLoading(`<div>${t("正在用 LibreOffice 转成 PDF…")}</div><div class="tiny dim">${t("第一次打开会慢一些，转好的会缓存起来")}</div>`);
    let r;
    try {
      r = await api("/api/office/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: VW.path }) });
    } catch (e) { if (vwStill(p0)) vwFail(e.message, false); return; }
    if (!vwStill(p0)) return;
    if (r.missing) return vwOfficeMissing(r.can);
    if (!r.ok) return vwFail(r.message || t("转换失败"), false);
    return vwPdf(r.url, back ? [[t("网页版式"), "native"]] : []);
  }
  function vwOfficeMissing(can) {
    if (!can) return vwFail(t("这种文件要用 LibreOffice 转换后才能看，这里没有 LibreOffice。"), false);
    $("vw-body").innerHTML = `<div class="vw-empty">
      <div>${t("看这类文件要先装 LibreOffice（下载约 190 MB，装好约 830 MB）。装一次，以后 PPT、Word、Excel 都能直接看。")}</div>
      <button class="btn sm" data-a="lo-install">${t("安装 LibreOffice")}</button>
      <a class="btn ghost sm" href="${fileUrl(VW.path, true)}" download>${t("下载")}</a></div>`;
    $("vw-body").querySelector('[data-a="lo-install"]').addEventListener("click", vwOfficeInstall);
    api("/api/office/info").then((j) => { if (j.install && j.install.running) vwOfficeInstall(); }).catch(() => {});
  }
  async function vwOfficeInstall() {
    const p0 = VW.path;
    $("vw-body").innerHTML = `<div class="vw-empty"><div>${t("正在安装 LibreOffice…可以先去干别的，装好回来再打开。")}</div>
      <div class="tiny dim vw-lo-line"></div></div>`;
    let j;
    try { j = await api("/api/office/install", { method: "POST" }); } catch (e) { return vwFail(e.message, false); }
    while (!j.have && j.install && j.install.running) {
      if (!vwStill(p0)) return;
      const el = $("vw-body").querySelector(".vw-lo-line");
      if (el) el.textContent = j.install.line || "";
      await new Promise((ok) => setTimeout(ok, 1500));
      try { j = await api("/api/office/info"); } catch {}
    }
    if (!vwStill(p0)) return;
    if (j.have) { toast(t("LibreOffice 装好了")); return vwOffice(); }
    vwFail(t("LibreOffice 没装上：{msg}", { msg: (j.install && j.install.line) || "?" }), false);
    $("vw-body").querySelector(".vw-empty").insertAdjacentHTML("beforeend", `<button class="btn ghost sm" data-a="lo-retry">${t("重试")}</button>`);
    $("vw-body").querySelector('[data-a="lo-retry"]').addEventListener("click", vwOfficeInstall);
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

  async function vwPdf(url, extra) {
    const p0 = VW.path;
    vwActs([["−", "zoom-"], ["+", "zoom+"]].concat(extra || []));
    $("vw-body").innerHTML = `<div class="vw-empty">${t("读取中…")}</div>`;
    let lib, doc;
    try {
      lib = await loadPdfjs();
      const task = lib.getDocument({
        url: url || fileUrl(VW.path), cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, wasmUrl: "/pdfjs/wasm/",
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
    if (!vwStill(p0) || VW.pdf) { doc.destroy(); return; }
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
    if (VW.dirty) draftClear();
    VW.dirty = false;
    closeViewerPdf();
    vwDropEd();
    vwHtmlStop();
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
    try { r = await api("/api/term/new", { method: "POST", body: JSON.stringify({ cols, rows, ...(opts.login ? { login: opts.login } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }) }); }
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
    ["\u0000clip", "paste"], ["A−", "font-"], ["A+", "font+"],
  ];

  function renderTermKeys() {
    $("term-keys").innerHTML = TERM_KEYS.map(([l, k], i) =>
      `<button class="tk ${(k === "ctrl" && TERM.ctrl) || (k === "alt" && TERM.alt) ? "on" : ""}" data-i="${i}">${l === "\u0000clip" ? uiI("clip") : esc(l)}</button>`).join("");
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

  // 截屏当附件（经 priv / Shizuku）。立刻截：分屏时连另一半一起截；延时截：先切到要截的应用，截完自动回来
  async function screenshot(delay) {
    // 立刻截：不弹提示（会被截进去），等面板收起、动画走完再截
    if (delay) toast(t("{n} 秒后截屏，现在可以切到要截的应用", { n: delay }));
    else await new Promise((r) => setTimeout(r, 450));
    try {
      const j = await api("/api/screenshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delay }) });
      state.attachments.push(j);
      renderAttachments();
      toast(t("已附加截屏"));
    } catch (e) { toast(e.message, true); }
  }

  // ＋ 快捷面板
  const sheetEl = $("sheet");
  // 宽屏：浮在 ＋ 上方的小卡片（宽 360，高不过 宽×φ 和上方剩余空间）；窄屏：底部弹层
  function openSheet() {
    const p = sheetEl.querySelector(".sheet-panel"), wide = innerWidth >= 700;
    sheetEl.classList.toggle("pop", wide);
    p.style.cssText = "";
    sheetEl.classList.remove("hidden");
    if (!wide) return;
    const ar = $("btn-plus").getBoundingClientRect(), w = Math.min(360, innerWidth - 32);
    p.style.width = w + "px";
    p.style.left = Math.max(16, Math.min(ar.left - 6, innerWidth - w - 16)) + "px";
    p.style.bottom = (innerHeight - ar.top + 10) + "px";
    p.style.maxHeight = Math.min(Math.round(w * 1.618), ar.top - 10 - 16) + "px";
  }
  $("btn-plus").addEventListener("click", openSheet);
  addEventListener("resize", () => { if (!sheetEl.classList.contains("hidden") && sheetEl.classList.contains("pop")) sheetEl.classList.add("hidden"); });
  sheetEl.addEventListener("click", (e) => {
    if (e.target === sheetEl) { sheetEl.classList.add("hidden"); return; }
    const it = e.target.closest(".sheet-item, .sheet-tile");
    if (!it) return;
    sheetEl.classList.add("hidden");
    const a = it.dataset.act;
    if (a === "new") return $("btn-new").click();
    if (a === "caps") return openPage("caps");
    if (a === "attach") return pickFiles();
    if (a === "shot" || a === "shot5") return screenshot(a === "shot5" ? 5 : 0);
    if (a === "browse") return openFiles();
    if (a === "model" || a === "effort") return openModelPicker();
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
      if (s.product && document.title !== s.product) document.title = s.product;
      state.serverStatus = s;
      paintAcct(s);
      paintSafeMode(s.safeMode);
      // 日志分享靠安卓壳（cccodroid）打包、弹分享面板；旧版应用没有
      // 打包诊断、到 GitHub 反馈只有 cccodroid 有：整行藏起来
      $("btn-share-logs").closest(".srow").classList.toggle("hidden", s.product !== "cccodroid");
      $("btn-issue").closest(".srow").classList.toggle("hidden", s.product !== "cccodroid");
      $("btn-ledger").classList.toggle("hidden", !s.hasLedger);
      paintModel(s.model || "—");
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
        // keepalive：紧接着就跳走了，普通请求会被掐掉
        fetch("/api/freeze", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ why, touch: log[log.length - 1].touch }) }).catch(() => {});
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
      if ((dy > 0 ? s.top : max - s.top) < 40) return;           // 到头了或只剩一点能滚（内容刚好比屏幕长一丁点），滚不动不算冻住
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
    if (document.querySelector(".pop-menu")) { closeMenu(); return true; }
    const ov = document.querySelector(".pj-ov"); if (ov) { ov.remove(); return true; }
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
      ["set-ov", setBack],
      ["drawer", closeDrawer],
      // 项目 / 定时任务的详情：先回列表，再关整页
      ["pages", () => { if (curPage === "projects" && PJ.cur) { PJ.cur = null; PJ.detail = null; renderProjects(); } else if (curPage === "sched" && SC.cur) { SC.cur = null; SC.detail = null; renderSched(); } else closePage(); }],
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
  window.__cc = { view, srv, state, send, abort, openSession, newConversation, openPage,
    openGit, openViewer, openFiles, openDrawer, showWhatsNew, mdEd: () => VW.ed, provCard: (id) => { state.provView = id; renderProvCard(); } };

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
    // 设置里有几类（设备与权限、更新、通知、用量……）要等接口回话才显示：开机空下来先拉一遍，
    // 打开设置时就是现成的，不再一项项往外冒（打开时照旧再刷一次）
    setTimeout(() => { if (!setOpen) { loadProviders(); loadPriv(); loadUpd(); loadNotify(); loadDev(); loadQuota().catch(() => {}); } }, 2500);
    if (showWhatsNew()) noticeHold = true;     // 刚弹了更新说明：通知等下一次打开 / 切回来
    else loadNotices();
  })();

  /** 更新说明：更新后第一次打开时，主窗口正中弹一张卡片（外壳决定显示哪几版，见 WhatsNew.java；
   *  全新安装、开发端外壳没有这个接口时什么都不做）。显示出来就记为看过 */
  function showWhatsNew() {
    const A = window.CCApp;
    if (!A || typeof A.whatsNew !== "function") return false;
    let list = [];
    try { list = JSON.parse(A.whatsNew(isZh() ? "zh" : ((window.I18N && I18N.lang) || "en")) || "[]"); } catch { return false; }
    if (!Array.isArray(list) || !list.length) return false;
    const el = document.createElement("div");
    el.id = "whatsnew";
    el.innerHTML = `<div class="wn-card" role="dialog" aria-modal="true" aria-labelledby="wn-title">
      <div class="wn-head" id="wn-title">${esc(t("更新说明"))}</div>
      <div class="wn-body">${list.map((x) => `<section><div class="wn-ver">v${esc(x.v)}</div><div class="bubble wn-md">${renderMd(x.md)}</div></section>`).join("")}
        <section class="wn-cm"><div class="wn-ver">${esc(t("交流与反馈"))}</div>${communityHtml(true)}</section></div>
      <div class="wn-foot"><button class="btn" data-act="ok">${esc(t("知道了"))}</button></div></div>`;
    const close = () => el.remove();
    communityBind(el);
    el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-act=ok]")) close(); });
    el.querySelectorAll(".wn-md a[href]").forEach((a) => a.addEventListener("click", (e) => {
      const u = a.getAttribute("href") || "";
      if (/^https?:\/\//.test(u) && A.openUrl) { e.preventDefault(); A.openUrl(u); }
    }));
    document.body.appendChild(el);
    try { A.whatsNewSeen(); } catch {}
    return true;
  }
})();
