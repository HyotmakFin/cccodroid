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
  //   都只在对话这一栏里摆（右侧可能是浏览器 / 终端窗格）
  let sheetW = 0;
  function openSheet() {
    const p = sheetEl.querySelector(".sheet-panel"), col = colRect(), wide = col.width >= 560;
    sheetEl.classList.toggle("pop", wide);
    p.style.cssText = ""; sheetEl.style.left = sheetEl.style.right = "";
    sheetEl.classList.remove("hidden");
    sheetW = innerWidth;
    if (!wide) { sheetEl.style.left = col.left + "px"; sheetEl.style.right = (innerWidth - col.right) + "px"; return; }
    const ar = $("btn-plus").getBoundingClientRect(), w = Math.min(360, col.width - 32);
    p.style.width = w + "px";
    p.style.left = Math.max(col.left + 16, Math.min(ar.left - 6, col.right - w - 16)) + "px";
    p.style.bottom = (fixedH() - ar.top + 10) + "px";
    p.style.maxHeight = Math.min(Math.round(w * 1.618), ar.top - 10 - 16) + "px";
  }
  $("btn-plus").addEventListener("click", openSheet);
  // 布局（layout.js）在浮层开合后会补发一次 resize，窗口其实没变 —— 只有宽度真变了才收，不然一开就闪没
  addEventListener("resize", () => { if (!sheetEl.classList.contains("hidden") && sheetEl.classList.contains("pop") && innerWidth !== sheetW) sheetEl.classList.add("hidden"); });
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
      // 接口换了（或第一次拿到状态）：顶栏的额度 / 余额跟着换
      if (!QB.cur || QB.cur.id !== s.provider || QB.cur.login !== (s.keyMode === "login")) {
        if ((QB.cur ? QB.cur.id : qbLast && qbLast.id) !== s.provider) qbPaint({ text: "", lvl: 0 });   // 先画的是别家的：撤掉，等新的
        state.serverStatus = s; qbLoad(false).catch(() => {});
      }
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
        `${t("厂商")}     ${provName(s)}\n` +
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
  window.__ccBack = guardHook("__ccBack", () => {
    const open = (id) => !$(id).classList.contains("hidden");
    if (OV.back()) return true;     // 菜单、速览卡、弹层：关最上面那个
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
  });
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
      <div class="wn-foot"><button class="btn ghost" data-act="log">${esc(t("更新日志"))}</button><button class="btn" data-act="ok">${esc(t("知道了"))}</button></div></div>`;
    const close = () => OV.close(el);
    communityBind(el);
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-act=log]")) { close(); openPage("changelog"); }
      else if (e.target === el || e.target.closest("[data-act=ok]")) close();
    });
    el.querySelectorAll(".wn-md a[href]").forEach((a) => a.addEventListener("click", (e) => {
      const u = a.getAttribute("href") || "";
      if (/^https?:\/\//.test(u) && A.openUrl) { e.preventDefault(); A.openUrl(u); }
    }));
    OV.open(el, { kind: "modal", keep: true, cover: true });
    try { A.whatsNewSeen(); } catch {}
    return true;
  }
})();
