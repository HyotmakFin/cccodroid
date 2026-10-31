// Dependency-free UI integration: only synthetic fetch replies and a minimal DOM, never a live gateway.
// Design provenance (not the obsolete motion snapshots): openai-bridge-ui-design at base e0311e2.
// DESIGN.zh-CN.md sha256 22a8011fbbd459be1581d2ccb4db2cce012d15e8de8c5d56547a6152e07289c3
// BRIEF.zh-CN.md sha256 17e648516e42bfc376c1d3107f69c11dbdfee7e81b47f31c83ceea57e6783f4a
// preview.html sha256 255d2e2259881302bf6987b1c9aa9b7e6ee3e080d10aa3e5d1c5bd302de35e1e
// Only the three-field Extensions flow is adapted; baseline themes/fonts/layout/HMAC/capacity stay intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app/bridge-config.js", import.meta.url), "utf8");
const sessionSource = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const modelSource = fs.readFileSync(new URL("../web/app/12-model-caps.js", import.meta.url), "utf8");
const saved = (extra = {}) => ({ installed: true, configured: true, hasKey: true, endpoint: "https://api.example.com/v1", model: "synthetic-model", providerId: "synthetic-bridge", local: { state: "ready" }, ...extra });
const fresh = () => saved({ configured: false, hasKey: false, endpoint: "", model: "", providerId: "", local: { state: "stopped" } });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

function ui(initial = fresh()) {
  const nodes = new Map(), listeners = new Map(), observers = [], calls = [], confirms = [];
  class Node {
    constructor(id = "", tag = "div") {
      this.id = id; this.tagName = tag.toUpperCase(); this.value = ""; this.type = ""; this.textContent = "";
      this.attributes = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.disabled = false; this.scrollTop = 0; this.isConnected = true;
      const classes = new Set();
      this.classList = { add: (...a) => a.forEach((c) => classes.add(c)), remove: (...a) => a.forEach((c) => classes.delete(c)), contains: (c) => classes.has(c), toggle(c, force) { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; } };
    }
    set innerHTML(html) {
      this.html = html; if (this.id) nodes.set(this.id, this);
      for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const el = new Node(match[3], match[1]);
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(attr[1], attr[2]);
        this.appendChild(el); nodes.set(el.id, el);
      }
      const eye = new Node("bc-eye", "button"); eye.dataset.bc = "eye"; this.appendChild(eye); nodes.set("bc-eye", eye);
      for (const action of ["back", "use", "edit"]) {
        const button = new Node("bc-action-" + action, "button"); button.dataset.bc = action; this.appendChild(button); nodes.set(button.id, button);
      }
    }
    get innerHTML() { return this.html || ""; }
    appendChild(el) { this.children.push(el); el.parentElement = this; return el; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.classList.add(...value.split(/\s+/).filter(Boolean)); if (name === "type") this.type = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelector(selector) { if (selector === '[data-bc="eye"]') return nodes.get("bc-eye"); return null; }
    querySelectorAll(selector) { return selector === "input, button" ? this.children.filter((el) => ["INPUT", "BUTTON"].includes(el.tagName)) : []; }
    getClientRects() { return this.closest(".hidden") ? [] : [{}]; }
    closest(selector) { if (selector === "[data-bc]" && this.dataset.bc) return this; if (selector === ".hidden") { for (let el = this; el; el = el.parentElement) if (el.classList.contains("hidden")) return el; } return null; }
    focus() { document.activeElement = this; }
    reset() { for (const el of nodes.values()) if (el.tagName === "INPUT") el.value = ""; }
  }
  const get = (id) => nodes.get(id);
  for (const id of ["tab-ext", "pages", "page-body", "anchor"]) nodes.set(id, new Node(id));
  const document = {
    activeElement: get("anchor"), hidden: false, getElementById: get,
    createElement: (tag) => new Node("", tag), querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners.get("doc:" + type) || listeners.set("doc:" + type, []).get("doc:" + type)).push(fn); },
  };
  let response = initial, nextPost = null, backCount = 0, acceptConsent = true;
  const sandbox = {
    URL, document, MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    __ccBack() { backCount++; return false; },
    confirm(message) { confirms.push(message); return acceptConsent; },
    localStorage: { getItem() { assert.fail("bridge form must not read storage"); }, setItem() { assert.fail("bridge form must not persist secrets"); } },
    sessionStorage: { getItem() { assert.fail("bridge form must not read storage"); }, setItem() { assert.fail("bridge form must not persist secrets"); } },
    fetch: async (url, opts) => {
      assert.equal(url, "/api/components/openai-bridge/config", "only the real same-origin component configuration route is allowed");
      assert.equal(opts.cache, "no-store"); assert.equal(opts.credentials, "same-origin");
      calls.push({ method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      if (opts.method === "POST" && nextPost) return nextPost();
      return { ok: true, status: 200, json: async () => structuredClone(response) };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "bridge-config.js" });
  return {
    get, calls, document, confirms,
    consent(value) { acceptConsent = value; },
    open: (opts = {}) => sandbox.CCBridgeConfig.open({ anchor: get("anchor"), ...opts }),
    close: () => sandbox.CCBridgeConfig.close(),
    response(value) { response = value; }, post(fn) { nextPost = fn; },
    async submit() { await get("bc-form").listeners.submit[0]({ preventDefault() {} }); },
    async click(action) {
      const node = action === "eye" ? get("bc-eye") : get("bc-action-" + action);
      for (const fn of get("bridge-config-panel").listeners.click) fn({ target: node });
      await new Promise((r) => setImmediate(r));
    },
    input(name, value) { const el = get("bc-" + name); el.value = value; for (const fn of el.listeners.input || []) fn(); },
    back: () => sandbox.__ccBack(), backCount: () => backCount,
    blur() { for (const fn of listeners.get("blur") || []) fn(); },
    leavePage() { get("tab-ext").classList.add("hidden"); observers.forEach((fn) => fn([])); },
  };
}

const fill = (u, key = "synthetic-test-key") => { u.input("endpoint", "https://api.example.com/v1"); u.input("key", key); u.input("model", "synthetic-model"); };
const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });

test("bridge session handoff: real onHello preserves a new-session pin before model refresh, explicit switches still clear it", async () => {
  const take = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
  const nodes = () => ({ classList: { add() {}, remove() {} }, querySelector() { return null; }, childElementCount: 0, innerHTML: "" });
  const modelQueries = [], refreshes = [], state = { pendingModel: null }, view = { sessionId: "existing-session", runIds: new Set(), cids: new Set(), gen: 0 };
  const box = {
    URL, state, view, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount: 1, busReplay: false, welKeep: null,
    WROTE: new Map(), TOOL_CARDS: new Map(), PENDING_RESULTS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(),
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {},
    paintModel() {}, chipName: () => "synthetic-model", loadCtxModel() {}, provChanged() {},
    api: async (url) => {
      modelQueries.push(url);
      const u = new URL(url, "https://synthetic.invalid");
      return { provider: u.searchParams.get("provider") || "global-provider", model: u.searchParams.get("model") || "global-model" };
    },
    refreshObserved() { refreshes.push(state.pendingModel && { ...state.pendingModel }); },
  };
  // Run the production query / refresh and hello / reset functions, not a reimplementation of their ordering.
  vm.runInNewContext(
    take(modelSource, "  const sidQ =", "  // 会话用的那家变了") +
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nconst actualRefresh = refreshSessModel; refreshSessModel = () => { refreshObserved(); return actualRefresh(); }; globalThis.handoff = { onHello, resetView };", box,
  );
  box.handoff.resetView(null);
  const pin = { provider: "custom-openai-bridge", model: "synthetic-bridge-model", effort: "high" };
  state.pendingModel = pin; view.projectId = "synthetic-project"; view.pendingMerge = [{ session: "synthetic-source" }];
  box.handoff.onHello({ uiTag: "synthetic-ui", runs: [], run: null, resume: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.pendingModel, pin, "the selection survives the fresh SSE hello");
  assert.deepEqual(refreshes.at(-1), pin, "refresh sees the pin immediately, never the global default");
  assert.match(modelQueries.at(-1), /provider=custom-openai-bridge/);
  assert.match(modelQueries.at(-1), /model=synthetic-bridge-model/);
  assert.equal(state.sessEff.provider, "custom-openai-bridge");
  assert.equal(view.projectId, "synthetic-project");
  assert.deepEqual(view.pendingMerge, [{ session: "synthetic-source" }]);
  box.handoff.onHello({ uiTag: "synthetic-ui", runs: [], resume: false });
  await Promise.resolve();
  assert.equal(state.pendingModel, pin, "a later non-resumable reconnect also keeps the same draft selection");
  box.handoff.resetView(null);
  assert.equal(state.pendingModel, null, "explicitly opening a new conversation starts with a clean selection");
  state.pendingModel = pin;
  box.handoff.resetView("different-session", true);
  assert.equal(state.pendingModel, null, "an existing session can never inherit a new-session pin");
});

test("bridge form: card stays inside Extensions, old key is not echoed and save is not inference or session switching", async () => {
  const u = ui(saved({ apiKey: "do-not-display-synthetic-old-key" })); let used = 0;
  await u.open({ useNew: async () => { used++; } });
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), true);
  assert.equal(u.get("bridge-config-panel").parentElement.id, "tab-ext");
  assert.equal(u.document.activeElement.id, "bridge-config-title", "opening does not auto-open the keyboard");
  assert.equal(u.get("bc-key").value, "");
  await u.click("edit");
  assert.equal(u.get("bc-endpoint").value, "https://api.example.com/v1");
  assert.equal(u.get("bc-key").value, "");
  assert.equal(u.get("bc-key").required, false);
  await u.submit();
  assert.deepEqual(u.calls.map((c) => c.method), ["GET", "POST"]);
  assert.deepEqual(u.calls[1].body, { endpoint: "https://api.example.com/v1", model: "synthetic-model", consent: true });
  assert.equal(used, 0);
  assert.equal(u.get("bc-local-state").textContent, "本地已准备好");
  assert.match(u.get("bridge-config-panel").innerHTML, /远端尚未测试/);
  await u.click("use");
  assert.equal(used, 1);
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
});

test("bridge form: first save needs three fields; replacement key is sent once, cleared and never stored", async () => {
  const u = ui(); await u.open(); await u.submit();
  assert.equal(u.calls.length, 1); assert.equal(u.get("bc-endpoint").getAttribute("aria-invalid"), "true");
  fill(u); u.response(saved()); await u.submit();
  assert.equal(u.calls.length, 2);
  assert.equal(u.calls[1].body.apiKey, "synthetic-test-key");
  assert.equal(u.get("bc-key").value, "");
  assert.equal(u.get("bc-key").type, "password");
  assert.equal(u.get("bc-saved").classList.contains("hidden"), false);
});

test("bridge form: cancelled explicit data-sharing consent never posts configuration", async () => {
  const u = ui(); await u.open(); fill(u); u.consent(false); await u.submit();
  assert.equal(u.calls.length, 1);
  assert.equal(u.confirms.length, 1);
  assert.match(u.confirms[0], /https:\/\/api\.example\.com/);
  assert.match(u.confirms[0], /对话、工具结果和图片/);
  assert.match(u.confirms[0], /不调用远端模型/);
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  u.consent(true); u.response(saved()); await u.submit();
  assert.equal(u.calls[1].body.consent, true);
});

test("bridge form: a different origin or port requires a replacement key, with no request on invalid fields", async () => {
  for (const endpoint of ["https://other.example.com/v1", "https://api.example.com:444/v1"]) {
    const u = ui(saved()); await u.open(); await u.click("edit");
    u.input("endpoint", endpoint); await u.submit();
    assert.equal(u.calls.length, 1); assert.equal(u.get("bc-key").getAttribute("aria-invalid"), "true");
    assert.match(u.get("bc-key-hint").textContent, /旧密钥不会/);
    u.input("key", "replacement-synthetic-key"); u.response(saved({ endpoint })); await u.submit();
    assert.equal(u.calls[1].body.apiKey, "replacement-synthetic-key");
  }
});

test("bridge form: rejects unsafe URLs, unsupported paths and invalid model IDs without remote discovery", async () => {
  for (const endpoint of ["http://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?key=synthetic", "https://api.example.com/v1#x", "https://api.example.com/v1/responses", "https://api.example.com/private", "https://api.example.com\\\\private/chat/completions", "https://api.example.com/a b/chat/completions", "https://api.example.com/v1/cha\nt/completions", "javascript:alert(1)"]) {
    const u = ui(); await u.open(); fill(u); u.input("endpoint", endpoint); await u.submit();
    assert.equal(u.calls.length, 1, endpoint); assert.equal(u.get("bc-endpoint").getAttribute("aria-invalid"), "true");
  }
  const u = ui(); await u.open(); fill(u); u.input("model", "one,two"); await u.submit();
  assert.equal(u.calls.length, 1); assert.equal(u.get("bc-model").getAttribute("aria-invalid"), "true");
  u.input("model", "one"); u.input("key", "line\nbreak"); await u.submit();
  assert.equal(u.calls.length, 1); assert.equal(u.get("bc-key").getAttribute("aria-invalid"), "true");
});

test("bridge form: displays exact normalization only for root, v1 or full Chat Completions paths", async () => {
  const u = ui(); await u.open();
  for (const endpoint of ["https://api.example.com", "https://api.example.com/v1/", "https://api.example.com/v1/chat/completions"]) {
    u.input("endpoint", endpoint);
    assert.equal(u.get("bc-endpoint-preview").textContent, "请求地址：https://api.example.com/v1/chat/completions");
  }
  u.input("endpoint", "https://api.example.com/custom/chat/completions");
  assert.equal(u.get("bc-endpoint-preview").textContent, "请求地址：https://api.example.com/custom/chat/completions");
});

test("bridge form: local readiness is independent of saved configuration; errors retain inputs and never echo server secrets", async () => {
  const u = ui(); await u.open(); fill(u); u.response(saved({ local: { state: "error" } })); await u.submit();
  assert.equal(u.get("bc-use").disabled, true);
  assert.equal(u.get("bc-local-state").textContent, "配置已保存，但本地桥尚未就绪");
  assert.match(u.get("bc-notice").textContent, /不会切换接口/);
  await u.click("edit"); u.input("key", "synthetic-new-key");
  u.post(async () => reply({ field: "apiKey", message: "secret-token-must-not-render", apiKey: "synthetic-new-key" }, 400));
  await u.submit();
  assert.equal(u.get("bc-key").value, "synthetic-new-key");
  assert.equal(u.get("bc-key").type, "password");
  assert.equal(u.get("bc-key").getAttribute("aria-invalid"), "true");
  assert.ok(!u.get("bc-notice").textContent.includes("secret-token"));
  assert.equal(u.get("bc-form").classList.contains("hidden"), false);
});

test("bridge form: absent or malformed component status never enables configuration or a new session", async () => {
  for (const data of [fresh(), { configured: true, hasKey: true }, saved({ installed: false })]) {
    const u = ui(data); await u.open();
    if (!data.installed) {
      assert.equal(u.get("bc-form").classList.contains("hidden"), true);
      assert.match(u.get("bc-notice").textContent, /先安装或更新/);
    }
    assert.equal(u.calls.length, 1);
  }
  const u = ui(saved({ providerId: "", local: { state: "ready" } })); await u.open({ useNew: async () => assert.fail("must not create without a provider") });
  assert.equal(u.get("bc-use").disabled, true);
});

test("bridge form: partial save failure reports saved versus readiness without losing replacement input", async () => {
  const u = ui(); await u.open(); fill(u);
  u.post(async () => reply({ ok: false, saved: true, localReady: false, code: "RUNTIME_CONFLICT", message: "untrusted-secret-synthetic" }, 409));
  await u.submit();
  assert.match(u.get("bc-notice").textContent, /配置已保存，但本地桥尚未就绪/);
  assert.equal(u.get("bc-form").classList.contains("hidden"), false);
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  assert.equal(u.get("bc-key").type, "password");
  assert.ok(!u.get("bc-notice").textContent.includes("untrusted-secret"));
});

test("bridge form: in-flight save is single-shot; leaving clears key and late success cannot reopen the panel", async () => {
  const u = ui(), pending = deferred(); await u.open(); fill(u);
  u.post(() => pending.promise);
  const save = u.submit(); await Promise.resolve();
  await u.submit(); assert.equal(u.calls.length, 2);
  assert.equal(u.get("bc-save").disabled, true);
  assert.equal(u.close(), false, "back is held while saving");
  u.leavePage(); assert.equal(u.get("bc-key").value, "");
  pending.resolve(reply(saved())); await save;
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
});

test("bridge form: hide/show applies only to newly entered key, blur remasks it, back restores extension view", async () => {
  const u = ui(); await u.open(); u.input("key", "synthetic-key"); await u.click("eye");
  assert.equal(u.get("bc-key").type, "text"); u.blur(); assert.equal(u.get("bc-key").type, "password");
  assert.equal(u.back(), true); assert.equal(u.get("bc-key").value, "");
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
  assert.equal(u.backCount(), 0); assert.equal(u.back(), false); assert.equal(u.backCount(), 1);
});
