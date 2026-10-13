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
  const queueStrip = document.createElement("div");
  queueStrip.id = "queue-strip";
  queueStrip.className = "hidden";
  $("composer").insertBefore(queueStrip, $("composer-inner"));

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
  function scrollDown(force) {
    const near = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
    if (force || near) chatEl.scrollTop = chatEl.scrollHeight;
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
  function inlineMd(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
  chatEl.addEventListener("click", (e) => {
    const b = e.target.closest(".copy-btn");
    if (!b) return;
    const code = b.parentElement.querySelector("code");
    if (code) navigator.clipboard?.writeText(code.textContent).then(() => {
      b.textContent = t("已复制"); setTimeout(() => (b.textContent = t("复制")), 1400);
    });
  });

  // ── 对话视图 ──────────────────────────────────────────────────────
  //  v3：照 Claude Desktop 的路子 —— 生成归网关管，界面只是订阅者。
  //   · 一条 EventSource（/api/events）收所有进度；断线自动续传，续不上就整轮重放
  //   · 发消息只是 POST 一下拿个号，排队也在网关那边（刷新不丢、两个窗口看到同一份）
  //   · 历史从文件尾倒着按页取，往上滚再取更早的
  //  #chat 里分三层：#older（加载更早）/ #hist（历史页）/ #live（本次打开后实时跑的）
  chatEl.innerHTML = `<button id="older" class="hidden">${t("加载更早的消息")}</button><div id="hist"></div><div id="live"></div>`;
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
  const srv = { run: null, queue: [], connected: false };
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
  function renderUser(text, parent) {
    const b = mkMsg("user", null, parent);
    setHtml(b, renderMd(text));
    const acts = document.createElement("div");
    acts.className = "msg-acts";
    acts.innerHTML = `<button data-a="copy">${t("复制")}</button><button data-a="resend">${t("重发")}</button>`;
    acts.addEventListener("click", (e) => {
      const a = e.target.dataset.a;
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
        tail.innerHTML = renderMd(text.slice(fz)) + '<span class="cursor"></span>';
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
    card.querySelector(".tool-head").addEventListener("click", () => {
      card.classList.toggle("open");
      if (card.classList.contains("open")) build();
    });
    const api = {
      kind: "tool",
      result(ok, text) {
        result = { ok, text: String(text || "") };
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
      },
      stop() { if (!result) { st.className = "tool-state err"; st.textContent = t("中断"); } },
      finish() { if (!result && !live) { st.textContent = "—"; } },
    };
    if (id) {
      TOOL_CARDS.set(id, api);
      const pend = PENDING_RESULTS.get(id);
      if (pend) { PENDING_RESULTS.delete(id); api.result(pend.ok, pend.text); }
    }
    return api;
  }
  function toolResult(id, ok, text) {
    const c = TOOL_CARDS.get(id);
    if (c) c.result(ok, text);
    else if (id) PENDING_RESULTS.set(id, { ok, text });   // 卡片在更早的一页里，翻到了再贴上
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
    const push = (b) => { undot(); blocks.push(b); last = b; any = true; return b; };
    const textB = () => (last && last.kind === "text" ? last : push(TextBlock(bubble, live)));
    const thinkB = () => (last && last.kind === "think" ? last : push(ThinkBlock(bubble)));
    return {
      msgEl, bubble,
      delta(t) { textB().append(t); },
      text(t) { push(TextBlock(bubble, live)).set(t); },
      thinkDelta(t) { thinkB().append(t); },
      thinking(t) { push(ThinkBlock(bubble)).set(t); },
      tool(id, name, input) { push(ToolBlock(bubble, id, name, input, live)); scrollDown(); },
      error(msg) {
        undot(); any = true; last = null;
        bubble.insertAdjacentHTML("beforeend", `<div class="err-box">${esc(msg)}</div>`);
        scrollDown();
      },
      note(t, solid) { undot(); last = null; if (solid) any = true; bubble.insertAdjacentHTML("beforeend", `<p class="run-note">${esc(t)}</p>`); },
      finish(aborted) {
        if (ended) return;
        ended = true;
        for (const b of blocks) { b.finish && b.finish(); if (aborted && b.stop) b.stop(); }
        undot();
        if (!any && live && !aborted) bubble.innerHTML = '<p class="muted">' + t("（无输出）") + '</p>';
      },
      get empty() { return !any; },
      get ended() { return ended; },
      remove() { msgEl.remove(); },
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
    runViews.clear();
    TOOL_CARDS.clear();
    PENDING_RESULTS.clear();
    olderEl.classList.add("hidden");
    statEl.textContent = "";
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
        addNote(t("找不到这个会话的记录（可能已删除）—— 下一条消息会开新会话。"), histEl);
        view.sessionId = null;
        saveUiState();
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
  chatEl.addEventListener("scroll", () => {
    if (chatEl.scrollTop < 240 && view.cursor && !view.loading && histEl.childElementCount) loadOlder(false);
  }, { passive: true });

  function showWelcome() {
    const b = mkMsg("bot", null, histEl);
    b.innerHTML =
            t("<p>你好，我是跑在这台设备上的 <strong>Claude Code CLI</strong>。</p>") +
      `<ul style="color:var(--fg2);font-size:13.5px">
         <li><strong>📎</strong> ${t("附加图片或文件（也可以直接粘贴、拖放）")}</li>
         <li><code>/</code> ${t("唤起斜杠命令，")}<code>@</code> ${t("引用文件路径")}</li>
         <li>${t("顶栏")} <strong>📁</strong> ${t("打开文件浏览器（可预览图片、插入路径）")}</li>
         <li>${t("左上角")} <strong>☰</strong> ${t("管理历史会话 / 设置 / 查看能力清单")}</li>
         <li>${t("生成中可以接着发：消息会排队；")}<strong>⚡</strong> ${t("插话（不打断，并进当前这一轮）")}</li>
       </ul>`;
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
        runViews.set(ev.runId, { av, startedAt: ev.startedAt });
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
        scrollDown(true);
        return;
      }
      case "init": {
        if (!view.runIds.has(ev.runId)) return;
        if (!view.sessionId && ev.sessionId) { view.sessionId = ev.sessionId; saveUiState(); }
        if (ev.model) { state.model = ev.model; modelEl.textContent = ev.model; }
        if (ev.permissionMode) { state.permissionMode = ev.permissionMode; permEl.textContent = ev.permissionMode; }
        return;
      }
      case "run_end": return onRunEnd(ev);
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
    }
    const keepRuns = new Set(view.runIds), keepCids = new Set(view.cids);
    const sid = view.sessionId;
    resetView(sid);
    view.runIds = keepRuns; view.cids = keepCids;
    renderSessions();
    if (sid) loadOlder(true);
    else if (!(ev.run && keepRuns.has(ev.run.id))) showWelcome();
    setStatus(t("已连接"), "ok");
  }

  function onRunEnd(ev) {
    const rv = runViews.get(ev.runId);
    if (!rv) { if (belongs(ev)) loadSessions(); return; }
    const av = rv.av;
    if (ev.sessionId && !view.sessionId && view.runIds.has(ev.runId)) { view.sessionId = ev.sessionId; saveUiState(); }
    if (ev.usage?.context_tokens) updateCtx(ev.usage.context_tokens, ev.usage.context_window || state.ctxTotal);

    if (ev.localCommand && ev.resultText) {
      av.finish();
      if (av.empty) av.remove();
            const b = mkMsg("sys", t("命令"), liveEl);
      setHtml(b, `<div class="cmd-card"><div class="cmd-name">${esc("/" + ev.localCommand)}</div>${renderMd(ev.resultText)}</div>`);
      if (ev.localCommand === "context") parseContextText(ev.resultText);
      if (ev.localCommand === "model" || ev.localCommand === "effort") loadSettings();
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
    srv.run = s.run || null;
    srv.queue = s.queue || [];
    const busy = !!srv.run;
    sendEl.classList.toggle("busy", busy && !inputEl.value.trim());
    inputEl.placeholder = busy
      ? t("生成中 · 回车 = 排队 · ⚡ = 插话（不打断）")
      : t("给 Claude 发消息，/ 命令，@ 引用文件…");
    syncInterject();
    renderQueue();
    if (busy) setStatus(srv.run.sessionId === view.sessionId || view.runIds.has(srv.run.id)
      ? t("生成中…") : t("另一个会话正在生成…"), "warn");
  }
  const isBusy = () => !!srv.run;

  /** 插话键只在「正在跑 + 输入框里有字」时露头 */
  function syncInterject() {
    const has = !!inputEl.value.trim();
    interjectEl.classList.toggle("hidden", !(isBusy() && has));
    sendEl.classList.toggle("busy", isBusy() && !has);
  }

  function renderQueue() {
    const q = srv.queue;
    queueStrip.classList.toggle("hidden", !q.length);
    queueStrip.innerHTML = q.length ? `
      <div class="q-head">
        <span>${q.some((it) => it.held)
          ? t("点了停止，{n} 条已挂起，不会自动发出 · 点 ⚡ 发出", { n: q.filter((it) => it.held).length })
          : t("待发 {n} 条 · 当前这一轮结束后依次发出", { n: q.length })}</span>
        <button class="q-clear">${t("全部清除")}</button>
      </div>
      ${q.map((it) => `
        <div class="qitem${it.held ? " held" : ""}" data-id="${esc(it.id)}">
          <button class="q-now" title="${it.held ? t("发出这条") : t("插话：递进正在跑的这一轮，不打断")}">⚡</button>
          <span class="q-text">${esc(it.text)}</span>
          <button class="q-x" title="${t("撤销这条")}">✕</button>
        </div>`).join("")}` : "";
  }
  queueStrip.addEventListener("click", async (e) => {
    const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .catch((err) => toast(err.message, true));
    if (e.target.closest(".q-clear")) return post("/api/queue/clear");
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
    // 官方账户登录：OAuth 全程由 claude 自己完成，网关只转递授权页地址和用户贴回的码
    if (text === "/login" || text === "/login console" || text.startsWith("/login ")) {
      if (fromInput) { inputEl.value = ""; autoGrow(); }
      const arg = text.slice(6).trim();
      const post = (p, body) => api(p, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      try {
        if (!arg || arg === "console") {
          addNote(t("正在启动登录…"));
          const j = await post("/api/login/start", { method: arg === "console" ? "console" : "claudeai" });
          if (!j.ok) throw new Error(j.message || t("启动登录失败"));
          addSysMsg(t("在浏览器打开下面的地址完成授权，然后把页面给出的授权码用 {cmd} 发回来：", { cmd: "`/login " + t("授权码") + "`" }) + `\n\n[${j.url}](${j.url})`, "/login");
        } else {
          addNote(t("正在提交授权码…"));
          const j = await post("/api/login/code", { code: arg });
          addSysMsg(j.ok ? t("✓ 已登录，可以开始对话了") : t("✗ 登录失败：") + "\n\n```\n" + (j.output || j.message || "") + "\n```", "/login");
        }
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
      else if (!r.started) toast(mode === "inject" ? t("这一轮正在收尾，插不进去 —— 已排到最前，马上发出") : t("已排队，这一轮结束后发出"));
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
    try { await api("/api/abort", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }
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
    });

    $("fs-insert").disabled = !state.fs.sel;
    renderFsPreview();
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
        const t = await fetch(fileUrl(full)).then((r) => r.text());
        body = `<pre class="fs-pre">${esc(t.slice(0, 12000))}${t.length > 12000 ? "\n" + t("…（已截断）") : ""}</pre>`;
      } catch { body = '<div class="tiny">' + t("读取失败") + '</div>'; }
    } else {
      body = `<div class="tiny">${e.kind} · ${fmtSize(e.size)} · ${t("无可内嵌预览")}</div>`;
    }

    box.innerHTML =
      `<div class="fs-prev-head">
         <span class="mono">${esc(e.name)}</span>
         <span class="tiny">${fmtSize(e.size)}</span>
         <button class="btn ghost sm" data-a="insert">${t("插入 @路径")}</button>
         <a class="btn ghost sm" href="${fileUrl(full, true)}" download>${t("下载")}</a>
       </div>
       <div class="fs-prev-body">${body}</div>`;
    box.querySelector('[data-a="insert"]')?.addEventListener("click", () => insertFile(e));
    box.querySelector("img")?.addEventListener("click", () => openLightbox(full));
  }

  function insertFile(e) {
    const full = e.dir ? fullPathOf(e) + "/" : fullPathOf(e);
    insertAtCursor("@" + full);
    toast(e.dir ? t("已插入目录路径") : t("已插入文件路径"));
    closeFiles();
    inputEl.focus();
  }

  function closeFiles() { filesEl.classList.add("hidden"); }

  $("fs-close").addEventListener("click", closeFiles);
  $("fs-reload").addEventListener("click", () => fsLoad(state.fs.path, { keepSel: true }));
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

  function renderSessions() {
    const box = $("session-list");
    if (!state.sessions.length) {
      box.innerHTML = '<div class="tiny">' + t("还没有历史会话。") + '</div>';
      return;
    }
    const liveSid = srv.run && srv.run.sessionId;
    box.innerHTML = state.sessions.map((s) => `
      <div class="item ${s.id === view.sessionId ? "active" : ""}" data-id="${esc(s.id)}">
        <div class="it-title">${esc(s.title)}</div>
        <div class="it-meta">
          <span>${relTime(s.mtime)}</span>
          <span>${s.sizeKb} KB</span>
          ${s.id === liveSid ? `<span class="badge cur">${t("生成中")}</span>` : ""}
          ${s.currentProject ? `<span class="badge cur">${t("当前项目")}</span>` : ""}
          ${s.renamed ? `<span class="badge">${t("已命名")}</span>` : ""}
        </div>
        <div class="it-acts">
          <button data-a="open">${t("切换到此会话")}</button>
          <button data-a="rename">${t("重命名")}</button>
          <button data-a="del">${t("删除")}</button>
        </div>
      </div>`).join("");
  }
  $("session-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    const el = e.target.closest(".item");
    if (!b || !el) return;
    e.stopPropagation();
    const id = el.dataset.id, a = b.dataset.a;
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
      if (!confirm(t("删除这个会话的记录？不可恢复。"))) return;
      try { await api(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }); }
      catch (err) { return toast(err.message, true); }
      if (view.sessionId === id) newConversation();
      loadSessions();
      toast(t("已删除"));
    }
  });

  // ── 设置 ──────────────────────────────────────────────────────────
  let MODELS = [];

  // ── 接口（厂商）────────────────────────────────────────────────────
  // 下拉框只决定"看哪一家的配置卡"；真正切换要在卡上点「使用这个接口」——
  // 配置和切换分开，免得填密钥填到一半就把正在用的接口换掉了。
  const GROUP_NAME = { claude: "Claude", third: t("第三方（填 Key 即用）"), custom: t("自定义接口") };
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
        const st = p.login ? "" : (p.hasKey ? "" : t(" · 未配 Key"));
        return `<option value="${esc(p.id)}">${tag}${esc(p.label)}${st}</option>`;
      };
      sel.innerHTML = ["claude", "third", "custom"].map((g) =>
        `<optgroup label="${GROUP_NAME[g]}">` + (groups[g] || []).map(opt).join("") +
        (g === "custom" ? `<option value="__new__">${t("＋ 新增自定义接口…")}</option>` : "") + `</optgroup>`).join("");
      sel.value = state.provView;
      $("provider-count").textContent = t("{n} 个", { n: state.providers.length });
      const cur = state.providers.find((p) => p.id === r.active) || {};
      $("provider-info").innerHTML = t("当前在用：<b>{name}</b>　<code>{url}</code>", { name: esc(cur.label || r.active), url: esc(cur.baseUrl || "") });
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
    box.innerHTML = `<div class="sub">${esc(p.label)}</div>
      <div class="prov-state" id="login-state">${t("查询登录状态…")}</div>
      <div class="row-actions" id="login-actions"></div>
      <div id="login-flow"></div>
      <div class="tiny">${esc(p.hint || "")}</div>`;
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
        (st.plan ? ` · ${esc(st.plan)}` : "") + (st.org ? `<br><span class="tiny">${esc(st.org)}</span>` : "");
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
        <div class="tiny">${t("浏览器没跳回来（或在别的设备上授权）？打开下面这个地址，把页面给出的授权码贴回来：")}</div>
        <div class="mono"><a href="${esc(r.manualUrl || r.url)}" target="_blank" rel="noopener">${esc(r.manualUrl || r.url)}</a></div>
        <input id="login-code" placeholder="${t("粘贴授权码（形如 xxxx#yyyy）")}" autocomplete="off">
        <button class="btn sm" id="btn-login-code">${t("提交授权码")}</button>
      </div>`;
    $("btn-login-code").onclick = async () => {
      const code = $("login-code").value.trim();
      if (!code) return toast(t("先粘贴授权码"), true);
      const j = await post("/api/login/code", { code }).catch((e) => ({ ok: false, output: e.message }));
      if (!j.ok) toast(t("登录失败：{msg}", { msg: (j.output || "").slice(-120) }), true);
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
  function renderKeyCard(box, p) {
    box.innerHTML = `<div class="sub">${esc(p.label)}</div>
      ${p.endpoints.length > 1 ? `<div class="tiny" style="margin:0 0 4px">${t("线路")}</div>
        <select id="pc-endpoint">${p.endpoints.map((e) =>
          `<option value="${esc(e.id)}" ${e.id === p.endpoint ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select>` : ""}
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
        <br>${esc(p.hint || t("Key 只存在本机应用私有目录，运行时以环境变量交给 claude，直连厂商的 Anthropic 兼容端点。"))}</div>`;
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
    if (st.bootMissed) {
      se.classList.remove("hidden");
      se.className = "prov-state warn";
            se.textContent = t("这次开机系统没通知 cccodroid（被系统的「自启动」管理拦了），所以开机没能自动激活；打开 cccodroid 时会补上。") +
        t("想开机就激活：在应用详情里允许 cccodroid 自启动 / 后台启动。");
      $("priv-actions").insertAdjacentHTML("beforeend", `<button class="btn sm ghost" data-act="appsettings">${t("去允许自启动")}</button>`);
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
    const UPD_TEXT = { uptodate: t("已是最新"), available: t("有新版本"), downloading: t("下载中"), ready: t("已下载，待安装"), installing: t("安装中"), error: t("出错"), unknown: t("未检查") };
  let updPoll = null;
  async function loadUpd() {
    let st;
    try { st = await api("/api/app/upd_status"); } catch { return; }
    if (!st.ok || !st.items) return;                 // 旧版 / 开发端：没有这项
    $("upd-field").classList.remove("hidden");
    $("upd-auto").checked = !!st.auto;
    $("upd-channel").value = st.channel || "stable";
    let moving = st.checking;
    $("upd-items").innerHTML = st.items.map((it) => {
      const busy = it.state === "downloading" || it.state === "installing";
      moving ||= busy;
      const ver = esc(it.current || "?") + (it.latest && it.latest !== it.current && it.state !== "uptodate" ? " → " + esc(it.latest) : "");
      const prog = it.state === "downloading" && it.total ? `（${fmtSize(it.done)} / ${fmtSize(it.total)} · ${Math.floor(it.done * 100 / it.total)}%）`
        : it.state === "installing" && it.total ? `（${Math.floor(it.done * 100 / it.total)}%）` : "";
      const cls = it.state === "error" ? "err" : it.state === "uptodate" ? "ok" : it.state === "unknown" ? "" : "warn";
      const btn = it.state === "available" ? (it.id === "claude" ? t("更新") : t("下载并安装"))
        : it.state === "ready" ? t("安装") : it.state === "error" && it.latest ? t("重试") : "";
      return `<div class="row-actions" style="justify-content:space-between">
        <div><b>${esc(it.name)}</b> <span class="tiny">${ver}</span><br>
          <span class="prov-state ${cls}" style="margin:0">${UPD_TEXT[it.state] || esc(it.state)}${prog}${it.message ? " · " + esc(it.message) : ""}</span></div>
        ${btn ? `<button class="btn sm" data-item="${esc(it.id)}">${btn}</button>` : ""}</div>`;
    }).join("");
    $("upd-last").textContent = st.checking ? t("检查中…") : st.error ? "✗ " + st.error
      : st.lastCheck ? t("上次检查：{at}", { at: new Date(st.lastCheck).toLocaleString() }) : t("还没检查过");
    clearTimeout(updPoll);
    if (moving && !$("tab-settings").classList.contains("hidden")) updPoll = setTimeout(loadUpd, 1500);
  }
  $("upd-items").addEventListener("click", async (e) => {
    const item = e.target.dataset && e.target.dataset.item;
    if (!item) return;
    if (item === "devkit" && !confirm(t("更新开发工具包？\n\n下载约 600 MB（断点续传），装的时候会暂停服务 1–2 分钟。\n你用 pip / npm -g 装进工具包的东西会被保留。"))) return;
    const r = await post("/api/app/upd_apply", { item }).catch((e2) => ({ ok: false, message: e2.message }));
    toast(r.message || (r.ok ? t("开始") : t("失败")), !r.ok);
    setTimeout(loadUpd, 500);
  });
  $("upd-check").addEventListener("click", async () => {
    await post("/api/app/upd_check").catch((e2) => toast(e2.message, true));
    setTimeout(loadUpd, 300);
  });
  $("upd-auto").addEventListener("change", (e) => post("/api/app/upd_set", { auto: e.target.checked }).then(loadUpd).catch(() => {}));
  $("upd-channel").addEventListener("change", (e) => post("/api/app/upd_set", { channel: e.target.value }).then(loadUpd).catch(() => {}));
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

  // ── 自定义接口卡（任何讲 Anthropic Messages 协议的端点）──
  function renderCustomCard(box, p) {
    const v = p || { label: "", baseUrl: "", authStyle: "bearer", modelsUrl: "", defaultModel: "", fastModel: "" };
    box.innerHTML = `<div class="sub">${p ? esc(p.label) : t("新增自定义接口")}</div>
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
      if (r.current) sel.value = r.current;
      else if (r.nativeModels) sel.value = "";
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
      $("set-perm").value = state.settings.permissionMode || "bypassPermissions";
      // 输出风格清单由网关列（内置 + 自定义 .md），不再写死 —— 以前写死的 concise 根本不存在
      $("set-style").innerHTML = '<option value="">' + t("（默认）") + '</option>' +
        (state.settings.outputStyles || []).map((o) =>
          `<option value="${esc(o.id)}">${esc(o.id)}${o.desc ? " · " + esc(o.desc) : ""}</option>`).join("");
      $("set-style").value = state.settings.outputStyle || "";
      // 没指定模型时别把顶栏写成 "—"：init 报过的真实模型更有用
      modelEl.textContent = state.settings.model || state.model || t("默认");
      permEl.textContent = state.settings.permissionMode || "";
      renderDirs();
      await loadProviders();
      await loadModels();
      $("set-model").value = state.settings.model || "";
      $("set-effort").value = state.settings.effort || "";
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
      permEl.textContent = state.settings.permissionMode || "";
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
  $("set-perm").addEventListener("change", (e) => saveSettings({ permissionMode: e.target.value }));
  $("set-style").addEventListener("change", (e) => saveSettings({ outputStyle: e.target.value }));
  $("set-effort").addEventListener("change", (e) => saveSettings({ effort: e.target.value }));

  $("set-autocompact").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    saveSettings({ autoCompactWindow: v ? Number(v) : null });
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
  function closeDrawer() { drawerEl.classList.add("hidden"); }
  // 切到哪个标签就加载哪个的数据 —— 点标签和 openDrawer 都走这里
  // （以前加载只写在 openDrawer 里，点"设置"标签进去 Shizuku / 更新几块永远不出来）
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + name));
    if (name === "sessions") loadSessions();
    if (name === "caps") loadCaps();
    if (name === "settings") { loadProviders(); loadPriv(); loadUpd(); }
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("btn-menu").addEventListener("click", () => openDrawer("sessions"));
  $("btn-files").addEventListener("click", () => openFiles());
  $("btn-palette").addEventListener("click", () => { openCmdPalette(""); inputEl.focus(); });
  $("btn-close-drawer").addEventListener("click", closeDrawer);
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
  window.__cc = { view, srv, state, send, abort, openSession, newConversation };

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
