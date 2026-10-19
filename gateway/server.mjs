#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  server.mjs —— Claude CLI 的 HTTP + SSE 网关
//
//  把本机的 Claude Code CLI（走 DeepSeek API）包成完整的图形化入口：
//
//    · 会话管理   读 claude 自己的 transcript（~/.claude/projects/*.jsonl），
//                 可以列表 / 恢复 / 删除 / 重命名 —— 多上下文并存
//    · 斜杠命令   /context /cost /model /status /mcp … 在 -p 模式下能直接执行，
//                 原样转发即可拿到 CLI 的本地命令输出
//    · 能力清单   工具 / 技能 / 代理 / 斜杠命令 / MCP / 插件，全部可见
//    · 设置       模型、权限模式、附加目录、输出风格、思考强度
//
//  用法: node server.mjs [port]
// ─────────────────────────────────────────────────────────────────────

import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 路径与配置 ────────────────────────────────────────────────────────
const CFG = {
  runtime: process.env.CCAPP_RUNTIME || path.join(HERE, "..", "runtime"),
  home: process.env.CCAPP_HOME || process.env.HOME || HERE,
  workspace: process.env.CCAPP_WORKSPACE || path.join(HERE, "..", "workspace"),
  port: Number(process.argv[2] || process.env.CCAPP_PORT || 8790),
  bridgePort: Number(process.env.CCAPP_BRIDGE_PORT || 8788),
  upstream: process.env.CCAPP_UPSTREAM || "https://api.deepseek.com/anthropic",
  model: process.env.CCAPP_MODEL || "deepseek-flash",
};

// 前缀布局（cccodroid）：工具链是原生 Termux 前缀，claude 是官方原版二进制，
// 由宿主 App 用环境变量告诉我们位置；没设就按旧布局（runtime/ 下）找。
const PREFIX = process.env.CCAPP_PREFIX || "";
const NO_BRIDGE = !!PREFIX || process.env.CCAPP_NO_BRIDGE === "1";
const PATHS = {
  loader: process.env.CCAPP_LOADER || path.join(CFG.runtime, "glibc", "lib", "ld-linux-aarch64.so.1"),
  glibcLib: process.env.CCAPP_GLIBC_LIB || path.join(CFG.runtime, "glibc", "lib"),
  claude: process.env.CCAPP_CLAUDE || path.join(CFG.runtime, "claude"),
  // cccodroid：给 claude 预加载的小库，把被安卓 seccomp 拦下的调用改成返回 ENOSYS
  // （Android 14 拦 epoll_pwait2，claude 不挂它一启动就被 SIGSYS 打死）
  preload: process.env.CCAPP_CLAUDE_PRELOAD || "",
  node: path.join(CFG.runtime, "node", "node"),
  nodeLib: path.join(CFG.runtime, "node", "lib"),
  web: path.join(HERE, "web"),
  toolchain: process.env.CCAPP_TOOLCHAIN || path.join(CFG.home, "..", "toolchain"),
  bridge: path.join(HERE, "localbridge.mjs"),
  config: path.join(CFG.home, "ccapp-config.json"),
  settings: path.join(CFG.home, "ccapp-settings.json"),
  names: path.join(CFG.home, "ccapp-session-names.json"),
  windows: path.join(CFG.home, "ccapp-model-windows.json"),
  projects: path.join(CFG.home, ".claude", "projects"),
};

// ── 工具函数 ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TS = () => new Date().toISOString().slice(11, 19);
const LOG_FILE = process.env.CCAPP_LOG || "/sdcard/DeepSeekHarness/claude-apk/gateway.log";
const log = (...a) => {
  const line = `[${TS()}] ${a.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
};

// ── 提示语的多语言 ────────────────────────────────────────────────────
// 源语言是中文、键就是中文原句，和界面共用 web/lang-*.js 的词典（回退：当前语言 → 英文 → 中文）。
// 要翻的提示语用 tz 包起来（第一个参数是带 {name} 占位的中文原句，第二个是变量）：它就是一个照常能拼接、能当 Error 消息的字符串，
// 同时登记「拼好的中文 → 键和变量」。所以提示语哪怕先变成 e.message、再转几手，
// sendJson 出门时（按请求头 X-CC-Lang）或推送时（按最近一次见到的语言）都还能认出来翻。
// gateway.log 不翻。新键照 i18n/HANDOFF.md 的流程进词典（scan.mjs 也扫这里 tz 包着的原句）
const TZ_SEEN = new Map();                      // 拼好的中文 → [键, 变量]，只留最近 300 条
const tzFill = (k, v) => (v ? k.replace(/\{(\w+)\}/g, (m, n) => (n in v ? String(v[n]) : m)) : k);
function tz(k, v) {
  const s = tzFill(k, v);
  TZ_SEEN.delete(s); TZ_SEEN.set(s, [k, v || null]);
  if (TZ_SEEN.size > 300) TZ_SEEN.delete(TZ_SEEN.keys().next().value);
  return s;
}
const LANG_DICTS = new Map();
let LAST_LANG = "zh";
function langDict(code) {
  if (!LANG_DICTS.has(code)) {
    let d = null;
    try {
      const sb = { window: {} };
      vm.runInNewContext(fs.readFileSync(path.join(HERE, "web", `lang-${code}.js`), "utf8"), sb);
      d = (sb.window.I18N_DICT || {})[code] || null;
    } catch {}
    LANG_DICTS.set(code, d);
  }
  return LANG_DICTS.get(code);
}
/** 请求带的界面语言；顺手记下来给推送和后台任务用 */
function reqLang(req) {
  const l = String((req && req.headers && req.headers["x-cc-lang"]) || "");
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(l)) LAST_LANG = l;
  return LAST_LANG;
}
function tr(lang, msg) {
  if (typeof msg !== "string" || !lang || lang === "zh") return msg;
  const hit = TZ_SEEN.get(msg) || [msg, null];
  for (const c of lang === "en" ? ["en"] : [lang, "en"]) {
    const d = langDict(c), x = d && d[hit[0]];
    if (x === undefined || x === null) continue;
    try { return typeof x === "function" ? String(x(hit[1] || {})) : tzFill(String(x), hit[1]); } catch {}
  }
  return msg;
}

// ── 厂商配置（不写死任何一家）─────────────────────────────────────────
// 端点 / 认证风格 / 模型清单来源 全部来自 ccapp-providers.json。
// 只要对端讲 Anthropic Messages 协议，就能在配置里加一条即可切换。
const PROVIDERS_FILE = path.join(CFG.home, "ccapp-providers.json");
const SEED_FILE = process.env.CCAPP_SEED || "/sdcard/DeepSeekHarness/claude-apk/config.json";

// 配置文件缺失时的最小兜底：等价于历史行为（DeepSeek）
const BUILTIN_PROVIDER = {
  id: "deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  modelsUrl: "https://api.deepseek.com/models",
  modelsAuth: "bearer",      // 拉清单时的认证风格: bearer | x-api-key | none
  authStyle: "bearer",       // 给 claude 的变量: bearer→AUTH_TOKEN, x-api-key→API_KEY
  apiKey: "",
  nativeModels: false,       // true = claude 原生认识的厂商，不覆盖模型
  defaultModel: "deepseek-flash",
  fallbackModels: [],
};

// ── 内置厂商目录 ──────────────────────────────────────────────────────
// 都是各家**官方文档**给 Claude Code 用的 Anthropic 兼容端点（2026-10 逐个核对，并实测路由存在）：
//   DeepSeek  api-docs.deepseek.com/guides/agent_integrations/claude_code
//   智谱 GLM   docs.bigmodel.cn/cn/guide/develop/claude
//   通义千问   help.aliyun.com/zh/model-studio/claude-code
//   Kimi      platform.kimi.com/docs/guide/agent-support
// claude 直连这些端点（ANTHROPIC_BASE_URL + 密钥变量），不需要协议转换。
// 配置文件只存用户自己的东西（密钥、选的线路、改过的默认模型）；目录本身随版本更新。
const PRESETS = {
  anthropic: {
    label: "Claude 账户登录", labelEn: "Claude account sign-in", group: "claude", login: true, nativeModels: true,
    baseUrl: "https://api.anthropic.com", authStyle: "x-api-key", defaultModel: null,
    hint: "用 Claude 订阅账户（Pro / Max / Team）。登录由 Claude Code 自己完成，网关不碰凭据。",
    hintEn: "Use a Claude subscription (Pro / Max / Team). Claude Code signs in by itself; the gateway never touches your credentials.",
  },
  "anthropic-key": {
    label: "Claude API Key", group: "claude", nativeModels: true,
    baseUrl: "https://api.anthropic.com", authStyle: "x-api-key",
    modelsUrl: "https://api.anthropic.com/v1/models", modelsAuth: "x-api-key", defaultModel: null,
    keyUrl: "https://platform.claude.com/settings/keys",
    hint: "Claude 开发者平台的 API Key，按量计费。",
    hintEn: "An API key from the Claude Developer Platform, billed per use.",
  },
  deepseek: {
    label: "DeepSeek", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://api.deepseek.com/anthropic", modelsUrl: "https://api.deepseek.com/models",
    defaultModel: "deepseek-flash", fastModel: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    fallbackModels: [
      { id: "deepseek-flash", name: "DeepSeek Flash", context_window: 1048576 },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", context_window: 1048576 },
    ],
  },
  glm: {
    label: "智谱 GLM", labelEn: "Zhipu GLM", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "glm-5.2", fastModel: "glm-4.7",
    extraEnv: { API_TIMEOUT_MS: "3000000" },
    endpoints: [
      { id: "cn", label: "国内 · open.bigmodel.cn", labelEn: "China · open.bigmodel.cn", baseUrl: "https://open.bigmodel.cn/api/anthropic",
        modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models", keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys" },
      { id: "intl", label: "国际 · z.ai", labelEn: "International · z.ai", baseUrl: "https://api.z.ai/api/anthropic",
        modelsUrl: "https://api.z.ai/api/paas/v4/models", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
    ],
    fallbackModels: [
      { id: "glm-5.2", name: "GLM-5.2", context_window: 1000000 },
      { id: "glm-4.7", name: "GLM-4.7" },
    ],
  },
  qwen: {
    label: "通义千问 Qwen", labelEn: "Alibaba Qwen", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    endpoints: [
      { id: "payg", label: "按量计费 · dashscope", labelEn: "Pay as you go · dashscope", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
        modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models", defaultModel: "qwen3.7-max", fastModel: "qwen3.6-flash" },
      { id: "coding", label: "Coding Plan", baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
        defaultModel: "qwen3.7-plus", fastModel: "qwen3.7-plus" },
      { id: "token", label: "Token Plan", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
        defaultModel: "qwen3.8-max", fastModel: "qwen3.8-flash" },
    ],
    fallbackModels: [
      { id: "qwen3.7-max", name: "Qwen3.7 Max" }, { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
      { id: "qwen3.8-max", name: "Qwen3.8 Max" }, { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
      { id: "qwen3.6-flash", name: "Qwen3.6 Flash" },
    ],
  },
  kimi: {
    label: "Kimi", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "kimi-k3", fastModel: "kimi-k2.7-code-highspeed",
    endpoints: [
      { id: "cn", label: "国内 · moonshot.cn", labelEn: "China · moonshot.cn", baseUrl: "https://api.moonshot.cn/anthropic",
        modelsUrl: "https://api.moonshot.cn/v1/models", keyUrl: "https://platform.kimi.com/console/api-keys" },
      { id: "intl", label: "国际 · moonshot.ai", labelEn: "International · moonshot.ai", baseUrl: "https://api.moonshot.ai/anthropic",
        modelsUrl: "https://api.moonshot.ai/v1/models", keyUrl: "https://platform.moonshot.ai/console/api-keys" },
    ],
    fallbackModels: [
      { id: "kimi-k3", name: "Kimi K3", context_window: 1048576 },
      { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code 高速" },
      { id: "kimi-k2.6", name: "Kimi K2.6", context_window: 262144 },
    ],
  },
};
// 端侧小模型（cccodroid）：llama.cpp 的 llama-server 自带 Anthropic Messages 端点（/v1/messages），claude 直连本机。
// 不要密钥（给个占位值，llama-server 不校验）；模型清单就是模型目录里的 .gguf，服务由网关按需拉起，见「端侧小模型」一节
const LLAMA_PORT = Number(process.env.CCAPP_LLAMA_PORT) || 8811;
if (PREFIX) PRESETS.local = {
  label: "端侧小模型（本机）", labelEn: "On-device model", group: "local", local: true,
  baseUrl: `http://127.0.0.1:${LLAMA_PORT}`, authStyle: "x-api-key", apiKey: "local", defaultModel: null,
  // 手机上读一万多 token 的提示要几分钟：别让 claude 等两分钟就当超时。
  // 重试只给两次：本机服务挂了就是挂了，默认十次退避要白等三分钟
  extraEnv: { API_TIMEOUT_MS: "3000000", CLAUDE_CODE_MAX_RETRIES: "2" },
  hint: "用本机的 llama.cpp 跑小模型聊天，不联网、不花钱。手机算力有限，干活请用云端模型。",
  hintEn: "Chat with a small model running on this device via llama.cpp — offline and free. Phone hardware is limited; use a cloud model for real work.",
};
// 预置条目只从配置文件里取这些"属于用户"的字段；其余（名字、线路表、端点）以目录为准，
// 这样旧配置里抄死的 label/baseUrl 不会把目录更新挡住。自定义条目则整条都是用户的。
const USER_FIELDS = ["apiKey", "apiKeyEnv", "endpoint", "defaultModel", "fastModel", "extraEnv"];

/** 合成一条生效配置：目录 + 用户字段 + 所选线路 */
function composeProvider(id, raw) {
  const pre = PRESETS[id];
  let v;
  if (pre) {
    v = { ...pre };
    for (const k of USER_FIELDS) if (raw && raw[k] != null && raw[k] !== "") v[k] = raw[k];
    // 旧配置里自己攒的模型清单（带真实窗口）比目录里的全，留着
    if (raw && Array.isArray(raw.fallbackModels) && raw.fallbackModels.length) v.fallbackModels = raw.fallbackModels;
  } else {
    v = { group: "custom", authStyle: "bearer", modelsAuth: "bearer", ...raw, custom: true };
  }
  if (v.endpoints && v.endpoints.length) {
    const ep = v.endpoints.find((e) => e.id === v.endpoint) || v.endpoints[0];
    v.endpoint = ep.id;
    v.baseUrl = ep.baseUrl;
    v.modelsUrl = ep.modelsUrl || "";
    if (ep.keyUrl) v.keyUrl = ep.keyUrl;
    // 线路自带的默认模型只在用户没改过时生效
    if (!(raw && raw.defaultModel) && ep.defaultModel) v.defaultModel = ep.defaultModel;
    if (!(raw && raw.fastModel) && ep.fastModel) v.fastModel = ep.fastModel;
  }
  return v;
}

let PROVIDERS_RAW = { active: null, providers: {} };   // 配置文件原样（只含用户字段与自定义条目）
function loadProviders() {
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    if (j && typeof j === "object") PROVIDERS_RAW = { ...j, providers: (j.providers && typeof j.providers === "object") ? j.providers : {} };
  } catch {}
  const providers = {};
  for (const id of Object.keys(PRESETS)) providers[id] = composeProvider(id, PROVIDERS_RAW.providers[id]);
  for (const [id, raw] of Object.entries(PROVIDERS_RAW.providers)) {
    if (!PRESETS[id] && raw && raw.baseUrl) providers[id] = composeProvider(id, raw);
  }
  const active = providers[PROVIDERS_RAW.active] ? PROVIDERS_RAW.active : (PREFIX ? "anthropic" : "deepseek");
  return { active, providers };
}
function saveProvidersRaw() {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(PROVIDERS_RAW, null, 2), { mode: 0o600 });
  PROVIDERS_CFG = loadProviders();
}
let PROVIDERS_CFG = loadProviders();

/** 给界面看的一家：密钥只露末四位 */
function providerView(id, v) {
  const key = String(v.apiKey || "").trim();
  return {
    id, label: v.label || id, labelEn: v.labelEn || "", group: v.group || "custom", custom: !!v.custom,
    login: !!v.login, nativeModels: !!v.nativeModels, local: !!v.local,
    baseUrl: v.baseUrl || "", modelsUrl: v.modelsUrl || "", authStyle: v.authStyle || "bearer",
    endpoints: (v.endpoints || []).map((e) => ({ id: e.id, label: e.label, labelEn: e.labelEn || "" })), endpoint: v.endpoint || null,
    defaultModel: v.defaultModel || null, fastModel: v.fastModel || null,
    keyUrl: v.keyUrl || null, hint: v.hint || "", hintEn: v.hintEn || "",
    hasKey: !!key, keyTail: key ? key.slice(-4) : "",
    active: id === PROVIDER.id,
  };
}

function upsertProvider(id, b) {
  const isNew = !id;
  if (isNew) {
    if (!b.baseUrl) return { error: "need_baseUrl", message: tz("自定义接口至少要填端点地址") };
    let n = 1; while (PROVIDERS_RAW.providers["custom-" + n] || PRESETS["custom-" + n]) n++;
    id = "custom-" + n;
  }
  if (!PRESETS[id] && !PROVIDERS_RAW.providers[id] && !isNew) return { error: "unknown provider" };
  const cur = { ...(PROVIDERS_RAW.providers[id] || {}) };
  const str = (v) => String(v == null ? "" : v).trim();
  if ("apiKey" in b && str(b.apiKey)) cur.apiKey = str(b.apiKey);   // 空串 = 不改（界面上不回显旧密钥）
  if (b.clearKey) delete cur.apiKey;
  for (const k of ["endpoint", "defaultModel", "fastModel"]) if (k in b) { if (str(b[k])) cur[k] = str(b[k]); else delete cur[k]; }
  if (!PRESETS[id]) {
    for (const k of ["label", "baseUrl", "modelsUrl"]) if (k in b) cur[k] = str(b[k]);
    if ("authStyle" in b) cur.authStyle = b.authStyle === "x-api-key" ? "x-api-key" : "bearer";
    cur.modelsAuth = cur.authStyle || "bearer";
    if (!cur.label) cur.label = id;
    if (!/^https?:\/\//.test(cur.baseUrl || "")) return { error: "bad_baseUrl", message: tz("端点地址要以 http:// 或 https:// 开头") };
    cur.baseUrl = cur.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");   // claude 自己会补 /v1/messages
  }
  PROVIDERS_RAW.providers[id] = cur;
  saveProvidersRaw();
  if (id === PROVIDER.id) { applyProvider(); MODELS = null; MODELS_AT = 0; MODELS_FOR = null; }
  log(`[provider] 已保存 ${id}${"apiKey" in b && str(b.apiKey) ? "（含密钥）" : ""}`);
  return { ok: true, id, provider: providerView(id, PROVIDERS_CFG.providers[id]) };
}

/** 验密钥：有模型清单接口就拉清单（不花钱）；没有就发一条 max_tokens=1 的消息 */
async function testProvider(id) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { ok: false, message: tz("没有这家厂商") };
  if (v.login) return { ok: false, message: tz("账户登录不用测密钥，看登录状态即可") };
  const key = String(v.apiKey || "").trim();
  if (!key) return { ok: false, message: tz("还没填密钥") };
  const auth = v.authStyle === "x-api-key"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" };
  try {
    let r, how;
    if (v.modelsUrl) {
      how = "模型清单";
      r = await fetch(v.modelsUrl, { headers: auth, signal: AbortSignal.timeout(15000) });
    } else {
      how = "试发一条消息";
      r = await fetch(v.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ model: v.defaultModel || "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
    }
    const text = await r.text();
    if (r.ok) {
      let n = 0; try { n = normalizeModels(JSON.parse(text)).length; } catch {}
      return { ok: true, message: n ? tz("密钥有效（{how}，{n} 个模型）", { how, n }) : tz("密钥有效（{how}）", { how }) };
    }
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.msg || msg; } catch {}
    const why = r.status === 401 || r.status === 403 ? "密钥无效或与线路不匹配" : `HTTP ${r.status}`;
    return { ok: false, status: r.status, message: `${why}：${msg}` };
  } catch (e) {
    return { ok: false, message: tz("连不上：{err}", { err: e.message }) };
  }
}
// ── 余额与消费（设置页的厂商卡片）────────────────────────────────────
// 余额：问平台（各家接口不一样，没开放的就没有）。
// 消费：没有一家给 API Key 开放账单接口，只能自己记 —— 每次查到余额记一笔，比上次少了就是花掉的，
//       多了是充值（不算消费）。算的是整个账号的真实花费，同一把 Key 在别处用掉的也算。
// token：每轮结束按 claude 报的用量记一笔，所有厂商都有（查不了余额的平台就看这个）。
const BILL_FILE = path.join(CFG.home, "ccapp-billing.json");
let BILL = (() => { try { return JSON.parse(fs.readFileSync(BILL_FILE, "utf8")) || {}; } catch { return {}; } })();
let billSaveT = null;
const saveBill = () => { clearTimeout(billSaveT); billSaveT = setTimeout(() => { try { fs.writeFileSync(BILL_FILE, JSON.stringify(BILL), { mode: 0o600 }); } catch {} }, 500); };
const billOf = (id) => (BILL[id] ||= { since: Date.now(), spends: [], spentOld: 0, tok: [], tokOld: { in: 0, out: 0, cache: 0 } });
const KEEP_MS = 92 * 86400e3;   // 明细留三个月，更早的并进累计

/** 按端点认平台。认不出的（含自定义）就只记 token */
function billKind(v) {
  const u = String(v.baseUrl || "");
  if (/\/\/api\.deepseek\.com/.test(u)) return { kind: "deepseek" };
  if (/\/\/api\.moonshot\.cn/.test(u)) return { kind: "kimi", host: "https://api.moonshot.cn", currency: "CNY" };
  if (/\/\/api\.moonshot\.ai/.test(u)) return { kind: "kimi", host: "https://api.moonshot.ai", currency: "USD" };
  if (/\/\/open\.bigmodel\.cn/.test(u)) return { kind: "glm", host: "https://open.bigmodel.cn" };
  if (/\/\/api\.z\.ai/.test(u)) return { kind: "glm", host: "https://api.z.ai" };
  if (/\/\/openrouter\.ai/.test(u)) return { kind: "openrouter", currency: "USD" };
  return { kind: "none" };
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(j && (j.error?.message || j.message || j.msg)) || text.slice(0, 120)}`);
  return j;
}

/** 问平台要余额 → { currency, balance, parts:[{k,v}] } 或套餐额度 { plan:[...] } */
async function queryBalance(v, k) {
  const key = String(v.apiKey || "").trim();
  if (k.kind === "deepseek") {
    const j = await fetchJson("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` });
    const b = (j.balance_infos || [])[0];
    if (!b) throw new Error("no balance_infos");
    return { currency: b.currency, balance: +b.total_balance, parts: [{ k: "granted", v: +b.granted_balance }, { k: "topped", v: +b.topped_up_balance }], available: j.is_available !== false };
  }
  if (k.kind === "kimi") {
    const j = await fetchJson(k.host + "/v1/users/me/balance", { Authorization: `Bearer ${key}` });
    if (j.code !== 0 || !j.data) throw new Error(j.error?.message || j.message || "code " + j.code);
    return { currency: k.currency, balance: +j.data.available_balance, parts: [{ k: "voucher", v: +j.data.voucher_balance }, { k: "cash", v: +j.data.cash_balance }] };
  }
  if (k.kind === "openrouter") {
    const j = await fetchJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` });
    const d = j.data || {};
    if (d.limit_remaining == null) return { currency: "USD", balance: null, usage: +d.usage || 0 };
    return { currency: "USD", balance: +d.limit_remaining, usage: +d.usage || 0 };
  }
  if (k.kind === "glm") {
    // 智谱没有公开的余额接口；这是官方用量插件用的 Coding Plan 额度接口（非公开，可能变）。按量计费的 Key 查不到
    let j, err;
    for (const auth of [key, `Bearer ${key}`]) {
      try { j = await fetchJson(k.host + "/api/monitor/usage/quota/limit", { Authorization: auth, "Accept-Language": "zh-CN,zh" }); break; } catch (e) { err = e; }
    }
    if (!j) throw err;
    const lim = (j.data && j.data.limits) || [];
    if (!lim.length) return { plan: [], level: j.data && j.data.level };
    return {
      level: j.data.level || null,
      plan: lim.map((x) => ({
        window: x.unit === 3 ? "5h" : x.unit === 6 ? "week" : x.unit === 5 ? "month" : String(x.unit || ""),
        type: x.type || "", pct: Number(x.percentage) || 0, resetsAt: Number(x.nextResetTime) || 0,
        used: x.usage != null ? +x.usage : null, remaining: x.remaining != null ? +x.remaining : null,
      })),
    };
  }
  return null;
}

/** 记一次余额：比上次少 → 消费；多 → 充值（只更新基准） */
function noteBalance(id, cur, bal) {
  if (!Number.isFinite(bal)) return;
  const b = billOf(id);
  if (b.currency && b.currency !== cur) { b.last = null; }      // 换了币种（换了线路）：重新起算
  b.currency = cur;
  const now = Date.now();
  if (b.last && Number.isFinite(b.last.bal)) {
    const d = +(b.last.bal - bal).toFixed(6);
    if (d > 0) b.spends.push([now, d]);
    else if (d < 0) b.topups = (b.topups || 0) + 1;
  }
  b.last = { at: now, bal };
  const cut = now - KEEP_MS;
  while (b.spends.length && b.spends[0][0] < cut) b.spentOld += b.spends.shift()[1];
  saveBill();
}

/** 一轮结束记 token（按小时合并） */
function noteTokens(id, u) {
  if (!id || !u) return;
  const b = billOf(id);
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
  const add = [u.input_tokens || 0, u.output_tokens || 0, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)];
  const last = b.tok[b.tok.length - 1];
  if (last && last[0] === hour) for (let i = 0; i < 3; i++) last[i + 1] += add[i];
  else b.tok.push([hour, ...add]);
  const cut = Date.now() - KEEP_MS;
  while (b.tok.length && b.tok[0][0] < cut) { const x = b.tok.shift(); b.tokOld.in += x[1]; b.tokOld.out += x[2]; b.tokOld.cache += x[3]; }
  saveBill();
}

// 汇率：界面货币跟语言走（中文显示人民币，其余显示美元），账户币种不同时按汇率换算并标「≈」。半天取一次
let FX = null;
async function usdCny() {
  if (FX && Date.now() - FX.at < 12 * 3600e3) return FX;
  try {
    const j = await fetchJson("https://open.er-api.com/v6/latest/USD", {});
    if (j.result === "success" && j.rates && j.rates.CNY) FX = { rate: +j.rates.CNY, at: Date.now(), src: "open.er-api.com" };
  } catch (e) { log(`汇率获取失败：${e.message}`); }
  return FX;
}

const BAL_CACHE = new Map();   // id → { at, data }
async function billingInfo(id, force) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { error: tz("没有这家厂商") };
  const k = billKind(v);
  const out = { id, kind: k.kind, hasKey: !!String(v.apiKey || "").trim() };
  if (k.kind !== "none" && out.hasKey) {
    const c = BAL_CACHE.get(id);
    if (!force && c && Date.now() - c.at < 60000) Object.assign(out, c.data);
    else {
      try {
        const d = await queryBalance(v, k);
        if (d && d.currency && Number.isFinite(d.balance)) noteBalance(id, d.currency, d.balance);
        BAL_CACHE.set(id, { at: Date.now(), data: { ...(d || {}), balanceAt: Date.now() } });
        Object.assign(out, d || {}, { balanceAt: Date.now() });
      } catch (e) { out.balanceError = e.message; }
    }
  }
  const b = BILL[id];
  if (b) Object.assign(out, { since: b.since, spends: b.spends, spentOld: b.spentOld, ledgerCurrency: b.currency || null, tok: b.tok, tokOld: b.tokOld, checkedAt: b.last ? b.last.at : null });
  out.fx = await usdCny();
  return out;
}

/** 一轮跑完补查余额（能查的平台），消费记录才连得上。
 *  平台扣费有延迟（DeepSeek 实测跑完 20 秒还没扣、几分钟后才扣），所以分几次查：30 秒、3 分钟、10 分钟。
 *  又跑了一轮就重新排，连续干活时不会越堆越多 */
const billPending = new Map();
function billAfterRun(id) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v || billKind(v).kind === "none" || !String(v.apiKey || "").trim()) return;
  for (const t of billPending.get(id) || []) clearTimeout(t);
  billPending.set(id, [30e3, 180e3, 600e3].map((ms) => { const t = setTimeout(() => billingInfo(id, true).catch(() => {}), ms); t.unref?.(); return t; }));
}

let PROVIDER = BUILTIN_PROVIDER;

/** 逐级回落取密钥：生效厂商自带 → 环境变量 → 历史配置文件 */
function loadApiKey(p) {
  if (p && p.apiKey) return String(p.apiKey).trim();

  // 显式配置过的厂商（ccapp-providers.json 里有它一条），密钥就只认它自己那一条。
  // ⚠️ 这里的"留空"是**故意的**，不是"没配"：官方账户条目留空 = 不注入任何密钥，
  //    让 claude 用 ~/.claude/.credentials.json 里的登录态。
  //    以前没有这道闸，留空会一路回落到 ccapp-config.json —— 那里面躺的是 DeepSeek 的钥匙，
  //    于是切到官方账户时被注成 ANTHROPIC_API_KEY（它优先级高于登录态），
  //    拿 DeepSeek 钥匙打 api.anthropic.com，全网 401。
  if (p && p.explicit) {
    if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return String(process.env[p.apiKeyEnv]).trim();
    return null;                     // 不注入 = 登录态原样透传
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  for (const f of [PATHS.config, path.join(CFG.home, "ccapp-seed.json")]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const k = j.apiKey || j.API_KEY || j.token || j.DEEPSEEK_API_KEY;
      if (k) return k;
    } catch {}
  }
  try {
    const j = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const k = j.apiKey || j.API_KEY || j.token || j.DEEPSEEK_API_KEY;
    if (k) {
      try {
        fs.mkdirSync(path.dirname(PATHS.config), { recursive: true });
        fs.writeFileSync(PATHS.config, JSON.stringify({ apiKey: k }, null, 2), { mode: 0o600 });
        log(`[key] 已从共享位置导入密钥到私有目录`);
        // 导完立刻把共享区那份清空 —— 明文密钥不该在 /sdcard 上多留一秒，
        // 那是任何有存储权限的应用都读得到的地方。密钥已进私有目录，清空不影响使用。
        try {
          fs.writeFileSync(SEED_FILE, "{}");
          log(`[key] 已清空共享区的 seed 文件 ${SEED_FILE}`);
        } catch (e) { log(`[key] 共享区清空失败（不影响使用）: ${e.message}`); }
      } catch (e) { log(`[key] 私有目录写入失败: ${e.message}`); }
      return k;
    }
  } catch {}
  return null;
}

let API_KEY = null;   // 在 SETTINGS 载入后按「生效厂商」解析

/** claude 认的权限模式（2026-10 版二进制）。没有 manual */
const PERM_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

// ── 设置（模型 / 权限模式 / 目录 …）──────────────────────────────────
const SETTINGS = {
  // 不预填：CFG.model 是内置第三方厂商的兜底，预填进来会被带给官方账户（新装无设置文件时实测 400）
  model: null,
  // 和官方一致：逐项确认。前端的确认卡片接的是 stream-json 控制协议（见 startRun 里的 can_use_tool）
  permissionMode: "default",
  addDirs: [],
  outputStyle: null,
  effort: null,
  appendSystemPrompt: null,
  allowedTools: null,
  disallowedTools: null,
  // 自动压缩窗口（token）。留空 = 交给 claude 自己按模型窗口决定；填了就用你的值。
  autoCompactWindow: null,
  // 生效厂商（ccapp-providers.json 里的 id）。留空 = 用配置文件里的 active。
  provider: null,
  // 内存管家（cc-mem）：默认关。开了才允许停别的应用；白名单是用户额外保护的包名
  memGuard: { enabled: false, whitelist: [] },
  // 最多同时跑几个会话（1 = 和以前一样一次只跑一轮）
  maxParallel: 3,
  // 静态程序兼容：claude 外面套 seccomp-enosys-run -f，它拉起的整棵进程树里撞 seccomp 的静态二进制
  // （CGO_ENABLED=0 的 Go 程序之类）拿到 ENOSYS 而不是被 SIGSYS 打死。出问题时可关，回到不套的老样子
  staticCompat: true,
  // 空闲压缩：长会话闲置快一小时、1 小时提示缓存快过期时先压缩，下一条消息不用把整段历史重算一遍（见 idleArm）
  idleCompaction: true,
  // 端侧小模型：chat = 纯聊天（不给工具，提示只有几十 token）；custom = 用户自己的 ~/.cccodroid/local-mode.json
  localMode: "chat",
};

function loadSettings() {
  let had = false;
  try {
    Object.assign(SETTINGS, JSON.parse(fs.readFileSync(PATHS.settings, "utf8")));
    had = true;
  } catch {}
  // 权限模式一次性迁移：以前界面没法点「允许」，默认只能全部放行。设置里的 bypassPermissions
  // 分不清是用户选的还是当年的默认值 —— 一律改回逐项确认，界面给一条可关的提示；之后再选回去就尊重用户。
  // manual 是旧下拉里的无效值（claude 不认），同样改掉。
  if (!SETTINGS.permMigrated) {
    if (had && (!SETTINGS.permissionMode || SETTINGS.permissionMode === "bypassPermissions" || SETTINGS.permissionMode === "manual")) {
      if (SETTINGS.permissionMode === "bypassPermissions") SETTINGS.permNotice = true;
      SETTINGS.permissionMode = "default";
    }
    SETTINGS.permMigrated = 1;
    if (had) setImmediate(saveSettings);
  }
  if (!PERM_MODES.includes(SETTINGS.permissionMode)) SETTINGS.permissionMode = "default";
  // 旧版面板存的是小写 explanatory / 不存在的 concise —— claude 只认 Explanatory、Learning 和自定义的
  if (SETTINGS.outputStyle === "explanatory") SETTINGS.outputStyle = "Explanatory";
  if (SETTINGS.outputStyle === "concise") SETTINGS.outputStyle = null;
}

/** claude 认的输出风格：内置两种 + ~/.claude/output-styles 与工作区 .claude/output-styles 里的 .md（名字取 frontmatter 的 name） */
function outputStyles() {
  const out = [
    { id: "Explanatory", desc: "边做边解释实现取舍" },
    { id: "Learning", desc: "留 TODO 让你亲手写一部分" },
  ];
  for (const dir of [path.join(CFG.home, ".claude/output-styles"), path.join(CFG.workspace, ".claude/output-styles")]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      let name = f.slice(0, -3), desc = "";
      try {
        const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 2000);
        const fm = head.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          name = (fm[1].match(/^name:s*(.+)$/m) || [, name])[1].trim();
          desc = (fm[1].match(/^description:s*(.+)$/m) || [, ""])[1].trim();
        }
      } catch {}
      if (!out.some((o) => o.id === name)) out.push({ id: name, desc });
    }
  }
  return out;
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
    fs.writeFileSync(PATHS.settings, JSON.stringify(SETTINGS, null, 2), { mode: 0o600 });
  } catch (e) { log(`保存设置失败: ${e.message}`); }
}
loadSettings();

/** 生效厂商：设置里的 provider 优先，其次配置文件 active，最后内置兜底 */
function resolveProvider() {
  const want = SETTINGS.provider;
  if (PROVIDERS_CFG) {
    // explicit=true：这个厂商是配置文件里显式写着的 —— 它的密钥只认自己那一条，
    // 不再往历史配置回落（见 loadApiKey 里那段血泪注释）。
    // explicit：密钥只认这条自己的，不往历史配置回落。唯一例外是老版 DeepSeek ——
    // 它的密钥可能还躺在 ccapp-config.json 里、配置文件里没它这一条。
    // （官方账户条目绝不能回落：那会把 DeepSeek 的钥匙注成 ANTHROPIC_API_KEY，见 loadApiKey）
    const pick = (id) => ({ id, explicit: !!PROVIDERS_RAW.providers[id] || id !== BUILTIN_PROVIDER.id, ...PROVIDERS_CFG.providers[id] });
    if (want && PROVIDERS_CFG.providers[want]) return pick(want);
    const a = PROVIDERS_CFG.active;
    if (a && PROVIDERS_CFG.providers[a]) return pick(a);
  }
  return BUILTIN_PROVIDER;
}

/** 应用当前厂商：更新上游与密钥。
 *  模型清单缓存无需在此清除 —— fetchModels 以 MODELS_FOR===PROVIDER.id 为键，
 *  换厂商自然失效。（且 MODELS 声明在下方，此处提前赋值会触发 TDZ） */
function applyProvider() {
  PROVIDER = resolveProvider();
  CFG.upstream = PROVIDER.baseUrl || BUILTIN_PROVIDER.baseUrl;
  API_KEY = loadApiKey(PROVIDER);
}
applyProvider();

// ── 模型清单（按厂商拉，10 分钟缓存，失败用该厂商的 fallback）─────────
let MODELS = null, MODELS_AT = 0, MODELS_FOR = null;

/** 把不同厂商的 /models 响应归一成同一种形状。
 *  两家形状不同：DeepSeek 用 context_window/max_output_tokens/effort.supported_levels，
 *  官方 /v1/models 用 max_input_tokens/max_tokens/capabilities.*（能力位里带 supported 标记）。 */
function normalizeModels(j) {
  const raw = Array.isArray(j && j.data) ? j.data
            : Array.isArray(j && j.models) ? j.models : [];
  return raw.filter((m) => m && m.id).map((m) => {
    const caps = m.capabilities || {};
    // 官方形状：effort 档位散在 capabilities.effort 底下，键名就是档位名
    let effort = m.effort || null;
    if (!effort && caps.effort && typeof caps.effort === "object") {
      const lv = ["low", "medium", "high", "xhigh", "max"]
        .filter((k) => caps.effort[k] && caps.effort[k].supported);
      if (lv.length) effort = { supported_levels: lv, default_level: "high" };
    }
    let mods = m.input_modalities;
    if (!mods) {
      const img = caps.image_input && caps.image_input.supported;
      mods = img ? ["text", "image"] : ["text"];
    }
    return {
      id: m.id,
      name: m.name || m.display_name || m.id,
      context_window: m.context_window || m.contextWindow || m.max_input_tokens || 0,
      max_output_tokens: m.max_output_tokens || m.maxOutputTokens || m.max_tokens || 0,
      input_modalities: mods,
      effort,
    };
  });
}

/** 走官方账户登录（且没填密钥）时：凭据只归 claude 自己管。
 *  Anthropic 条款：第三方不得收集、保存或中转 claude.ai 凭据/会话令牌，登录须走官方流程。
 *  所以这种情况下网关既不读 .credentials.json，也不让请求经过本地桥 —— claude 直连官方。 */
function isLoginMode(p = PROVIDER) { return !!(p && p.login && !API_KEY); }

// 登录态拉不了清单（那要用令牌，我们不碰），给一份静态的；厂商配置里写了 fallbackModels 就用那份。
// 别名排前面：claude 自己把它解析成该系列的最新版，最不容易过时。
// 窗口一开始不知道（官方清单要令牌才能拉），跑过一轮后从 result.modelUsage 学到，见 learnWindow。
const LOGIN_MODELS = [
  ["opus", "Opus（最新）"], ["sonnet", "Sonnet（最新）"], ["haiku", "Haiku（最新）"], ["fable", "Fable（最新）"],
  ["claude-opus-5-5", "Opus 5.5"], ["claude-fable-5-1", "Fable 5.1"],
  ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-sonnet-5", "Sonnet 5"],
  ["claude-haiku-5-5", "Haiku 5.5"], ["claude-haiku-4-5-20251001", "Haiku 4.5"],
].map(([id, name]) => ({ id, name, context_window: 0, max_output_tokens: 0, input_modalities: ["text", "image"] }));

// claude --effort 认的全部档位（claude --help 原文：low, medium, high, xhigh, max）。
// 原生厂商的模型不带档位信息时就用这一套 —— 以前回落成 DeepSeek 的三档，medium/xhigh 凭空消失。
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"];
function effortLevelsOf(model) {
  return (model && model.effort && model.effort.supported_levels) ||
         (PROVIDER.nativeModels ? CLAUDE_EFFORT : ["low", "high", "max"]);
}

// 从 result.modelUsage 学到的真实窗口（按模型 id 记，落盘）—— 官方账户拿不到 /models，只能这样补
let WINDOWS = {};
try { WINDOWS = JSON.parse(fs.readFileSync(PATHS.windows, "utf8")); } catch {}
function learnWindow(result) {
  if (!PROVIDER.nativeModels) return;
  let changed = false;
  for (const [id, u] of Object.entries((result && result.modelUsage) || {})) {
    const w = { context_window: Number(u && u.contextWindow) || 0, max_output_tokens: Number(u && u.maxOutputTokens) || 0 };
    if (!w.context_window) continue;
    // 别名也记一份（opus → claude-opus-5-5 是 init 里看到的），下次列表里别名那项也有窗口
    for (const k of [id, ...Object.keys(ALIAS_SEEN).filter((a) => ALIAS_SEEN[a] === id)]) {
      if (JSON.stringify(WINDOWS[k]) !== JSON.stringify(w)) { WINDOWS[k] = w; changed = true; }
    }
  }
  if (changed) try { fs.writeFileSync(PATHS.windows, JSON.stringify(WINDOWS, null, 2)); } catch {}
}
/** 别名（opus）学不到窗口 —— modelUsage 里记的是全名；别名就借 init 报过的那个全名 */
const ALIAS_SEEN = {};
function withWindows(list) {
  return list.map((m) => {
    const w = WINDOWS[m.id];
    return w && !m.context_window ? { ...m, ...w } : m;
  });
}

async function fetchModels(force) {
  const p = PROVIDER;
  if (!force && MODELS && MODELS_FOR === p.id && Date.now() - MODELS_AT < 600000) return MODELS;

  if (p.local) {   // 端侧：模型目录里有什么就是什么（每次现扫，刚放进去的文件马上能选）
    MODELS = localModels(); MODELS_AT = 0; MODELS_FOR = p.id;
    return MODELS;
  }
  if (isLoginMode(p)) {
    MODELS = (p.fallbackModels && p.fallbackModels.length) ? p.fallbackModels : LOGIN_MODELS;
    MODELS_AT = Date.now(); MODELS_FOR = p.id;
    return MODELS;
  }

  if (p.modelsUrl && (API_KEY || p.modelsAuth === "none")) {
    try {
      const headers = {};
      if (API_KEY) {
        if (p.modelsAuth === "x-api-key") {
          headers["x-api-key"] = API_KEY;
          headers["anthropic-version"] = "2023-06-01";
        } else if (p.modelsAuth !== "none") {
          headers.Authorization = `Bearer ${API_KEY}`;
        }
      }
      const r = await fetch(p.modelsUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const list = mergeKnown(normalizeModels(await r.json()), p.fallbackModels);
        if (list.length) {
          MODELS = list; MODELS_AT = Date.now(); MODELS_FOR = p.id;
          log(`[${p.id}] 模型清单：${MODELS.map((m) => m.id).join(", ")}`);
          return MODELS;
        }
      }
      log(`[${p.id}] 拉模型清单失败 HTTP ${r.status}`);
    } catch (e) {
      log(`[${p.id}] 拉模型清单出错: ${e.message}`);
    }
  }
  MODELS = (MODELS_FOR === p.id && MODELS) ? MODELS
    : (p.fallbackModels || []).map((m) => ({ context_window: 0, max_output_tokens: 0, input_modalities: ["text"], effort: null, ...m }));
  MODELS_AT = Date.now(); MODELS_FOR = p.id;
  return MODELS;
}

/** 厂商的 /models 多是 OpenAI 形状：不报窗口，还混着向量、语音、画图模型。
 *  去掉明显不能对话的，窗口拿目录里已知的补上（不知道就留 0，不瞎编） */
function mergeKnown(list, known) {
  const byId = new Map((known || []).map((m) => [m.id, m]));
  return list
    .filter((m) => !/embed|rerank|tts|asr|whisper|speech|audio|wanx|cogview|cogvideo|image-|moderation/i.test(m.id))
    .map((m) => {
      const k = byId.get(m.id);
      if (!k) return m;
      return { ...m, name: m.name && m.name !== m.id ? m.name : (k.name || m.id),
        context_window: m.context_window || k.context_window || 0,
        max_output_tokens: m.max_output_tokens || k.max_output_tokens || 0,
        effort: m.effort || k.effort || null };
    });
}

/** claude 的 --effort 档位比 DeepSeek 多，收敛到该模型真正支持的档位。
 *  没设过（want 为空）就保持不设 —— 由模型自己决定，别替用户做主。 */
function normEffort(model, want) {
  if (!want) return null;
  const ok = effortLevelsOf(model);
  if (ok.includes(want)) return want;
  return (model && model.effort && model.effort.default_level) || null;
}

// ── 会话重命名表 ──────────────────────────────────────────────────────
let NAMES = {};
try { NAMES = JSON.parse(fs.readFileSync(PATHS.names, "utf8")); } catch {}
function saveNames() {
  try { fs.writeFileSync(PATHS.names, JSON.stringify(NAMES, null, 2), { mode: 0o600 }); } catch {}
}
// 置顶表：会话号 → 置顶时刻
const PINS_FILE = path.join(CFG.home, "ccapp-session-pins.json");
let PINS = {};
try { PINS = JSON.parse(fs.readFileSync(PINS_FILE, "utf8")); } catch {}
function savePins() {
  try { fs.writeFileSync(PINS_FILE, JSON.stringify(PINS, null, 2), { mode: 0o600 }); } catch {}
}

// ── 给 claude 造一个它认得的 shell ────────────────────────────────────
// 安卓既没有 /bin/sh 也没有 bash：claude 扫 /bin、/usr/bin 找 bash/zsh，
// 找不到就抛 "No suitable shell found"。它认 CLAUDE_CODE_SHELL 覆盖，
// 但会校验路径形态必须是 bash/zsh —— 于是造个名叫 bash 的包装转发给 mksh。
let SHELL_PATH = null;
function ensureShell() {
  if (SHELL_PATH) return SHELL_PATH;
  // 开发端（旧布局）没有 CCAPP_SHELL：有 files/cbash/bash（glibc 版真 bash）就用它。
  // /system/bin/sh 是 mksh —— claude 的 shell 快照开头 unalias -a，会把 mksh 靠别名实现的 local 一起删掉，
  // 快照里的 grep/find/pkill 函数于是每次都报 "local: inaccessible or not found"。
  const cbash = path.join(CFG.runtime, "..", "cbash", "bash");
  const want = process.env.CCAPP_SHELL || (!PREFIX && fs.existsSync(cbash) ? cbash : "");
  const real = want && fs.existsSync(want) ? want : "/system/bin/sh";

  // 包一层再交给 claude，顺手卸掉 CLAUDE_CODE_EXECPATH：
  // claude 的 shell 快照把 grep/find 换成内置 ugrep/bfs，调法是 exec -a ugrep "$CLAUDE_CODE_EXECPATH" -G …，
  // 而这个变量 claude 填的是 process.execPath —— 我们经 glibc 加载器启动它，那就是 ld-linux-aarch64.so.1。
  // 加载器把 -G 当成程序名，于是 grep/find 全挂（"-G: cannot open shared object file"），
  // 模型就会退而用 env 之类的命令乱试。变量没了，快照里的函数自己会回落到 command grep / command find。
  const dir = PREFIX ? path.join(CFG.home, ".cache", "ccapp-shell") : path.join(CFG.runtime, "bin");
  const sh = path.join(dir, "bash");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 前缀布局再加一层：termux-exec。安卓没有 /usr/bin/env、/bin/bash，
    // 凡是 #!/usr/bin/env node|python3、#!/bin/bash 的脚本（npm 装的命令行、./configure、用户自己写的）
    // 直接执行都是 bad interpreter。termux-exec 在 execve 时把这些解释器改指到 $PREFIX/bin。
    // 必须在 bash 启动前就设上 —— 已经在跑的 bash 后来再 export 也救不了它自己的 exec（实测）。
    // 代价：glibc 程序继承到它会起不来（claude 本体就是），所以 app/bin/claude 包装里会先清掉。
    const tx = PREFIX ? path.join(PREFIX, "lib", "libtermux-exec-ld-preload.so") : "";
    const pre = tx && fs.existsSync(tx) ? 'export LD_PRELOAD="' + tx + '"\n' : "";
    const body = '#!/system/bin/sh\nunset CLAUDE_CODE_EXECPATH\n' + pre + 'exec "' + real + '" "$@"\n';
    let need = true;
    try { need = fs.readFileSync(sh, "utf8") !== body; } catch {}
    if (need) fs.writeFileSync(sh, body, { mode: 0o755 });
    fs.chmodSync(sh, 0o755);
    SHELL_PATH = sh;
  } catch (e) {
    log(`造 shell 包装失败: ${e.message}`);
    SHELL_PATH = "/system/bin/sh";
  }
  return SHELL_PATH;
}

// ── 本地 DNS 桥 ───────────────────────────────────────────────────────
// glibc 读不到安卓的 DNS 配置，域名解析必须由 bionic node 代劳。
let bridgeProc = null, bridgeStarting = null;    // bridgeStarting：并发拉桥时共用同一次
function bridgeAlive() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: CFG.bridgePort, path: "/__ping", method: "GET", timeout: 800 },
      () => resolve(true)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function ensureBridge() {
  if (NO_BRIDGE) return true;
  if (await bridgeAlive()) return true;
  // 并发拉桥会撞端口（第二个 EADDRINUSE 起来就死，还留下个指着死进程的 bridgeProc）。
  // 一条在拉，其余的都等同一条。
  if (bridgeStarting) return bridgeStarting;
  bridgeStarting = doStartBridge().finally(() => { bridgeStarting = null; });
  return bridgeStarting;
}

async function doStartBridge() {
  if (!fs.existsSync(PATHS.bridge)) { log(`桥脚本缺失: ${PATHS.bridge}`); return false; }
  log(`拉起本地桥 127.0.0.1:${CFG.bridgePort} → ${CFG.upstream}`);
  const proc = spawn(PATHS.node, [PATHS.bridge, CFG.upstream, String(CFG.bridgePort)], {
    env: { ...process.env, LD_LIBRARY_PATH: PATHS.nodeLib },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProc = proc;
  proc.stdout.on("data", (d) => log(`[bridge] ${String(d).trim()}`));
  proc.stderr.on("data", (d) => log(`[bridge!] ${String(d).trim()}`));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await bridgeAlive()) { log("桥已就绪"); return true; }
    if (proc.exitCode !== null) break;      // 起崩了（多为端口占用）就别再白等 10 秒
  }
  log("桥启动超时/崩溃");
  return false;
}

/** 谁在占着桥端口？—— 用于处理不是我们拉起来的孤儿桥 */
function findBridgePids() {
  const out = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      let c = "";
      try { c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (c.includes("localbridge.mjs") && c.includes(String(CFG.bridgePort))) out.push(Number(d));
    }
  } catch {}
  return out;
}

/** 换上游：**优先热切**，不重启桥。
 *  桥的上游原本是启动参数，所以换厂商必须重启桥 —— 而重启会掐断正在传输的流。
 *  新版桥开了个控制面 POST /__upstream，运行中改目标，正在跑的请求各自持有旧目标跑完。
 *  老桥不认这个面，就退回"杀掉重起"的老办法。 */
async function setBridgeUpstream(url) {
  if (!url) return false;
  const ok = await new Promise((resolve) => {
    const body = JSON.stringify({ url });
    const req = http.request({
      host: "127.0.0.1", port: CFG.bridgePort, path: "/__upstream", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 1500,
    }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode === 200)); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end(body);
  });
  if (ok) { log(`桥上游已热切 → ${url}`); return true; }

  log(`桥不支持热切换（老版本），改为重启桥 → ${url}`);
  try { if (bridgeProc) bridgeProc.kill(); } catch {}
  bridgeProc = null;
  // 端口上那个可能不是我们拉起来的（上一代网关被杀时留下的孤儿桥）。
  // 不认控制面的老桥只能靠杀，从 /proc 里把它揪出来。
  for (const pid of findBridgePids()) {
    log(`杀掉端口上的旧桥 pid=${pid}`);
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  // 等端口真的腾出来再拉新的，否则新桥一碰 8788 就 EADDRINUSE 自杀
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (!(await bridgeAlive())) break;
  }
  return ensureBridge();
}

// ── claude 进程 ───────────────────────────────────────────────────────
/** 当前模型在【当前厂商】那边的真实参数（窗口 / 输出上限 / effort 档位） */
function currentModelInfo() {
  const list = withWindows(MODELS || PROVIDER.fallbackModels || []);
  if (!Array.isArray(list) || !list.length) return {};
  if (!SETTINGS.model) return list[0] || {};
  return list.find((m) => m.id === SETTINGS.model) || list[0] || {};
}

function claudeEnv() {
  const info = currentModelInfo();
  const p = PROVIDER;
  const env = {
    ...process.env,
    HOME: CFG.home,
    // 显式钉死临时目录。安卓上 /tmp 写不进（shell 属主 + SELinux），而工具链是从
    // Termux 搬来的，很多二进制里编译期写死了 /data/data/com.termux/files/usr/tmp
    // —— 那个目录在这台设备上根本不存在，回落过去就是一句 ENOENT。
    // 之前只靠从网关继承，网关怎么起的（MainActivity 还是 gw-swap.sh）就决定了有没有，
    // 太脆；这里自己钉死，claude 及其所有工具子进程就都有可写临时目录了。
    // cccodroid：用 $PREFIX/tmp —— 等长改写后，二进制里写死的默认临时目录正好就是它
    TMPDIR: PREFIX ? (fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true }), path.join(PREFIX, "tmp")) : CFG.home,
    // 文件检查点：-p 模式默认不记，打开后每条用户消息前给 Edit/Write 要动的文件留底，「回退到这里」靠它（见 rewindFiles）
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
    // 同理：把 ncurses 的 terminal database 指到我们自己的 prefix。
    // 死引用原本指向不存在的 Termux share/terminfo，TUI 程序（hx、gdb -tui…）拿不到
    // 终端能力；我们 prefix 里那份是齐的（221K），指过去就活了。
    TERMINFO_DIRS: PREFIX ? path.join(PREFIX, "share", "terminfo") : path.join(PATHS.toolchain, "dshtc", "prefix", "share", "terminfo"),
    // 工具链在前：这样 claude 调 git/gcc/rg/magick… 命中的是我们搬过来的包装脚本。
    // 最前面的 app/pre 只放 pkg / apt：工具包里有同名的旧说明替身，改它会被完整性校验判成"改动"，只能靠 PATH 顺序压过去
    PATH: PREFIX ? [process.env.CCAPP_BIN && path.join(process.env.CCAPP_BIN, "..", "pre"), path.join(PREFIX, "bin"), path.join(CFG.home, ".cccodroid", "bin"), process.env.CCAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean).join(":") : [
      path.join(PATHS.toolchain, "payload", "bin"),
      // 开发端自己加的工具（python3/pip、java/javac/d8/apksigner、strace、adb…）：放在 tc.tar 之外，启动重新部署时不会被冲掉
      path.join(CFG.runtime, "..", "devbin"),
      path.join(CFG.runtime, "node"),
      "/system/bin", "/system/xbin",
    ].join(":"),
    CCAPP_TOOLCHAIN: PATHS.toolchain,
    CCAPP_PROVIDER: p.id,
    // 标记：这棵进程树是网关拉起的 claude 运行（子孙都继承）。网关重启时据此认出上一任留下的孤儿，见 reapOrphans
    CCAPP_RUN: "1",
    LD_LIBRARY_PATH: PREFIX ? "" : PATHS.nodeLib,   // 只给 node 用；glibc 走 --library-path
    // 前缀布局下 glibc 的 resolv.conf 是齐的，不需要本地桥：直连厂商
    ANTHROPIC_BASE_URL: NO_BRIDGE ? (p.baseUrl || "") : `http://127.0.0.1:${CFG.bridgePort}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SHELL: ensureShell(),
    SHELL: ensureShell(),
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  };

  for (const k of ["LD_LIBRARY_PATH", "ANTHROPIC_BASE_URL"]) if (!env[k]) delete env[k];

  // 认证：按厂商声明的风格选变量，别把 key 塞进对方不认的 header。
  //   bearer    → ANTHROPIC_AUTH_TOKEN（Authorization: Bearer …）
  //   x-api-key → ANTHROPIC_API_KEY  （x-api-key: …，Anthropic 官方用这个）
  // 只有在确实要注入时才清掉继承来的冲突变量；没配 key 就原样透传
  // （这样 CLAUDE_CODE_OAUTH_TOKEN / 已有登录态仍然能用）。
  //
  // ⚠️ 密钥不进环境变量：claude 的每个 Bash 子进程都继承环境，模型跑一句 env 就整个打印出来
  // （实测发生过：grep 坏了，模型退而用裸 env，DeepSeek 的 key 原样进了会话记录）。
  // 改走 claude 自己的 apiKeyHelper：它要用时执行一条命令从 0600 的私有文件里读，见 settingsArgs()。
  if (API_KEY) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  } else if (p.login) {
    // 登录态直连官方：令牌不许经过我们的本地桥（条款：不得中转会话令牌）。
    // 桥本来只为 glibc 的 DNS 存在，claude（Bun）自己解析，用不着它。
    delete env.ANTHROPIC_BASE_URL;
    // 官方账户（登录态）厂商：这两个变量一个都不能留。
    // 它们优先级高于 ~/.claude/.credentials.json 里的登录凭据 —— 只要沾上一个，
    // claude 就不走订阅登录了（连接器原话：ANTHROPIC_API_KEY takes precedence
    // over your claude.ai login）。这里主动清干净，逼它去读凭据文件。
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }

  // 模型：原生厂商（claude 自己就认识其模型的，如 Anthropic 官方）不覆盖 ——
  // 交给 claude 自己决定默认模型；只有第三方才需要显式指定。
  const m = SETTINGS.model || p.defaultModel;
  const TIER_VARS = ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
  if (!p.nativeModels && m) {
    env.ANTHROPIC_MODEL = m;
    // 档位映射：claude 内部会按 opus/sonnet/haiku 叫模型（子代理 Explore 用 haiku、/model opus 之类）。
    // 不映射的话这些请求带着 claude-haiku-… 打到第三方，直接 400。
    // haiku 档给厂商的快模型（目录里的 fastModel），其余都给当前选的模型。
    const fast = p.fastModel || m;
    env.ANTHROPIC_SMALL_FAST_MODEL = fast;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = m;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = m;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
    delete env.CLAUDE_CODE_SUBAGENT_MODEL;   // 子代理按它自己声明的档位走上面的映射
  } else {
    for (const k of TIER_VARS) delete env[k];
    // 不由我们定模型的场合，把继承来的模型变量擦掉。
    // 跟密钥是同一个坑：网关自己要是被一个"身上带着 ANTHROPIC_MODEL"的进程拉起来
    // （比如从某个 deepseek 会话里起，或包装脚本 exports 过），这个值会一路传进
    // 官方账户的 claude —— 拿着 deepseek-flash 去敲 api.anthropic.com。
    // 实测就是这么炸的：model=<synthetic> 400 "issue with the selected model (deepseek-flash)"。
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_SMALL_FAST_MODEL;
  }

  // 第三方厂商：claude 不认识这些模型名，需放宽窗口识别，并把真实窗口告诉它。
  // 不设窗口的话 claude 一律按 200k 算 —— 1M 的模型会被白白砍掉 80%，
  // 而且 /autocompact 也会被卡在 200k。值从 /models 动态取，不写死。
  if (!p.nativeModels) {
    env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
    // 模型名不是 Claude 型号时，claude 默认不给清单工具（TaskCreate/TaskUpdate 一个都不挂），得显式打开；
    // 光打开还不够，第三方模型不会主动用 —— 配合 TASKS_HINT 提醒一句才用（DeepSeek 实测）
    if (!p.local) env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
    const ctx = Number(info && info.context_window) || 0;
    if (ctx > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
  }
  // 注意：不注入 CLAUDE_CODE_MAX_OUTPUT_TOKENS —— 那是「单次输出上限」，
  // 不是上下文，claude 自己有合理默认，硬塞只会带来副作用。

  // 自动压缩窗口：用户设了才插，没设就让 claude 自己按窗口比例决定
  // 端侧小模型不传：窗口只有几万 token 时，claude 同时看到窗口和压缩线，每次发请求前都判定「已超线」先去压缩（实测）
  if (SETTINGS.autoCompactWindow && !p.local) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(SETTINGS.autoCompactWindow);
  }
  // 厂商文档要求的额外变量（如 GLM 的 API_TIMEOUT_MS）。只收字符串，且不许借道改密钥/端点
  for (const [k, v] of Object.entries(p.extraEnv || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !/^ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN)$/.test(k)) env[k] = String(v);
  }
  return env;
}

/** claude 是 glibc 程序，必须经 loader 启动 */
function claudeArgv(extra) {
  const pre = PATHS.preload && fs.existsSync(PATHS.preload) ? ["--preload", PATHS.preload] : [];
  return ["--library-path", PATHS.glibcLib, ...pre, PATHS.claude, ...extra];
}

/** seccomp 监督器：cccodroid 放在 seccomp-enosys.so 旁边（app/lib），开发端在 files/devbin */
let ENOSYS_RUN;
function enosysRun() {
  if (ENOSYS_RUN !== undefined) return ENOSYS_RUN;
  const cands = [process.env.CCAPP_ENOSYS_RUN,
    PATHS.preload && path.join(path.dirname(PATHS.preload), "seccomp-enosys-run"),
    path.join(CFG.home, "..", "devbin", "seccomp-enosys-run")].filter(Boolean);
  ENOSYS_RUN = cands.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "";
  return ENOSYS_RUN;
}
/** 拉起 claude 的 [程序, 参数]：开着「静态程序兼容」就外面套一层监督器（跟进模式） */
function claudeCmd(extra) {
  const argv = claudeArgv(extra);
  const er = SETTINGS.staticCompat !== false ? enosysRun() : "";
  return er ? [er, ["-f", PATHS.loader, ...argv]] : [PATHS.loader, argv];
}

/** 连 claude 带它拉起的整棵进程树一起杀。
 *
 *  为什么不能用 child.kill()：SIGKILL 不往下传。claude 起了 bash、bash 起了
 *  sleep/blender/godot…，只杀 claude 的话那些会被 init（PID 1）收养、继续跑 ——
 *  实测按 ⏹ 中断后，巡检循环的 shell 照样在后台转，PPID 变成 1。
 *
 *  所以 spawn 时加了 detached:true，让 claude 当进程组长；这里对负 pid 下刀，
 *  一次带走整组。取不到组就退回杀单进程，别什么都不做。 */
function killTree(child) {
  if (!child || !child.pid) return;
  // 光杀组不够：claude 的 Bash 工具会给子 shell 另开进程组（setsid），实测中断后
  // `sh -c … sleep 60` 留下来被 init 收养。所以先顺着 /proc 的父子关系把整棵树
  // 摘出来（得在杀之前摘，杀完父子关系就断了），再逐个连组带进程一起杀。
  const tree = descendants(child.pid);
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  for (const p of tree) {
    try { process.kill(-p, "SIGKILL"); } catch {}
    try { process.kill(p, "SIGKILL"); } catch {}
  }
}

/** 网关启动时清掉上一任留下的孤儿（v0.2.0 设计 A3）。
 *  上一任网关被杀 / 崩溃时，它拉起的 claude 和 claude 另开进程组的子 shell 会被 init 收养（PPID=1），
 *  没人读它们的输出却还在干活：推提交、跑构建、占内存。新网关接不回它们，只能清掉。
 *  认法：本 uid、PPID=1，且环境里带 CCAPP_RUN=1（claudeEnv 打的标记，子孙都继承），
 *  或命令行就是我们的 claude（打标记之前的版本留下的）。连子孙一起、按进程组杀（同 killTree）。
 *  只在 cccodroid 做：开发端换网关（gw-swap.sh）时上一任的运行还要接着用。 */
function reapOrphans() {
  if (!PREFIX) return;
  const uid = process.getuid(), victims = [];
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return; }
  for (const n of names) {
    if (!/^\d+$/.test(n) || +n === process.pid) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const st = fs.readFileSync("/proc/" + n + "/stat", "utf8");
      if (+st.slice(st.lastIndexOf(")") + 2).split(" ")[1] !== 1) continue;
      const env = "\0" + fs.readFileSync("/proc/" + n + "/environ", "latin1");
      const cmd = fs.readFileSync("/proc/" + n + "/cmdline", "utf8");
      if (env.includes("\0CCAPP_RUN=1\0") || cmd.includes(PATHS.claude)) victims.push([+n, cmd.replace(/\0/g, " ").trim().slice(0, 80)]);
    } catch {}
  }
  for (const [pid, cmd] of victims) {
    const tree = descendants(pid);
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) {
      try { process.kill(-p, "SIGKILL"); } catch {}
      try { process.kill(p, "SIGKILL"); } catch {}
    }
    log(`  清掉上一任留下的孤儿 pid=${pid}（连子孙 ${tree.length} 个）：${cmd}`);
  }
}

/** root 的全部子孙 pid（读 /proc/<pid>/stat 的第 4 列 ppid） */
function descendants(root) {
  const kids = new Map();
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let st;
    try { st = fs.readFileSync(`/proc/${n}/stat`, "utf8"); } catch { continue; }
    // comm 可能含空格和括号，从最后一个 ")" 往后数
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+n);
  }
  const out = [], stack = [root];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) || []) { out.push(k); stack.push(k); }
  }
  return out;
}

/** 每次起 claude 都带的 --settings：输出风格 + 密钥读取器。
 *  apiKeyHelper 的输出 claude 会同时放进 x-api-key 与 Authorization: Bearer，两种认证风格都覆盖。 */
const KEY_FILE = path.join(CFG.home, ".cache", "ccapp-key");

/** 安全模式：配置弄坏了（钩子、插件、MCP、CLAUDE.md…）跑不起来时，用 claude 自带的 --safe-mode 起：
 *  所有自定义项一概不加载，登录、密钥、会话、模型照旧。不挪、不改任何文件，关掉就恢复原样。
 *  开关是一个标记文件 —— 界面打不开时，安卓壳的启动页也能直接写它。 */
const SAFE_FILE = path.join(CFG.home, ".ccapp-safe-mode");
const safeMode = () => fs.existsSync(SAFE_FILE);
function setSafeMode(on) {
  if (on) fs.writeFileSync(SAFE_FILE, String(Date.now()));
  else try { fs.unlinkSync(SAFE_FILE); } catch {}
  ledger("safe-mode", true, on ? "进入安全模式（界面开启）" : "退出安全模式");
  log(on ? "进入安全模式" : "退出安全模式");
}

/** 修复账本（安卓壳记安装 / 校验 / 修复，网关记安全模式），一行一条 JSON。没给路径就不记 */
function ledger(kind, ok, msg, detail) {
  const f = process.env.CCAPP_LEDGER;
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ at: Date.now(), kind, ok, msg, ...(detail ? { detail } : {}) }) + "\n"); } catch {}
}
function readLedger(n = 100) {
  const f = process.env.CCAPP_LEDGER;
  if (!f) return null;
  try {
    return fs.readFileSync(f, "utf8").trim().split("\n").reverse().slice(0, n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function settingsArgs() {
  const st = {};
  const safe = safeMode();
  if (SETTINGS.outputStyle && !safe) st.outputStyle = SETTINGS.outputStyle;
  if (API_KEY) {
    try {
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
      fs.writeFileSync(KEY_FILE, API_KEY, { mode: 0o600 });
      fs.chmodSync(KEY_FILE, 0o600);
      st.apiKeyHelper = "cat '" + KEY_FILE + "'";
    } catch (e) { log("写密钥文件失败: " + e.message); }
  } else {
    try { fs.unlinkSync(KEY_FILE); } catch {}
  }
  return [...(safe ? ["--safe-mode"] : []), ...(Object.keys(st).length ? ["--settings", JSON.stringify(st)] : [])];
}

/** 跑一次 claude 并收集全部 stdout（用于取 CLI 状态类输出） */
function runClaude(args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const [cmd0, args0] = claudeCmd([...settingsArgs(), ...args]);   // mcp list 之类会拉起 MCP 服务器，也要罩住
    const child = spawn(cmd0, args0, {
      cwd: cwd || (fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home),
      env: claudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,          // 当进程组长，中断时好整组带走（见 killTree）
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; killTree(child); resolve({ out, err, timeout: true }); }
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve({ out, err: err + e.message, error: true });
    });
    child.on("close", (code, signal) => {
      if (done) return;
      // 被信号杀掉时 code 是 null：把信号名带出去，不然调用方只看到一片空白
      done = true; clearTimeout(timer); resolve({ out, err: err + (signal ? `（claude 被信号 ${signal} 终止）` : ""), code, signal });
    });
  });
}

// ── 会话（claude 的 transcript 文件）─────────────────────────────────
/** 项目目录名 → 真实 cwd（从 jsonl 里读，目录名本身不可逆） */
const PEEK_CACHE = new Map();   // 标题/cwd 取自文件开头，写进去就不变了，没必要每次列表都重读
function peekSession(file) {
  let hit = PEEK_CACHE.get(file);
  if (hit && hit.title !== "(无标题)") return hit;
  hit = peekSessionRaw(file);
  PEEK_CACHE.set(file, hit);
  return hit;
}
function peekSessionRaw(file) {
  let title = "", cwd = "", firstMsg = "", created = 0;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(196608);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.cwd && !cwd) cwd = ev.cwd;
      if (!created && ev.timestamp) created = Date.parse(ev.timestamp) || 0;
      if (ev.type === "attachment") continue;

      let text = "";
      const c = ev.message?.content;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === "text");
        if (t) text = t.text;
      }
      if (!text && typeof ev.content === "string" && ev.type === "queue-operation") text = ev.content;

      if (text && ev.type === "user" && !text.startsWith("<")) { firstMsg = text; break; }
      if (text && !firstMsg && !text.startsWith("<")) firstMsg = text;
    }
  } catch {}
  title = firstMsg.replace(/\s+/g, " ").trim().slice(0, 90);
  return { title: title || "(无标题)", cwd, created };
}

function listSessions(limit = 150) {
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return []; }

  for (const d of dirs) {
    const dir = path.join(PATHS.projects, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      found.push({
        id: f.replace(/\.jsonl$/, ""),
        file: full,
        project: d.name,
        mtime: st.mtimeMs,
        size: st.size,
      });
    }
  }

  found.sort((a, b) => b.mtime - a.mtime);
  const shown = found.filter((s, i) => i < limit || PINS[s.id]);
  return shown.map((s) => {
    const meta = peekSession(s.file);
    return {
      id: s.id,
      created: meta.created || 0,
      pinned: PINS[s.id] || 0,
      title: NAMES[s.id] || meta.title,
      renamed: !!NAMES[s.id],
      cwd: meta.cwd,
      mtime: s.mtime,
      sizeKb: Math.round(s.size / 1024),
      currentProject: meta.cwd === CFG.workspace || meta.cwd === realWorkspace(),
    };
  });
}

// ── 会话内容搜索 ──
// 每个 jsonl 只抽人和助手的正文（跳过工具结果、<…> 包起来的系统注入），按读到的字节偏移增量追加。
// 索引放内存：首次搜索要扫一遍全部会话，之后只读新追加的部分。
const SEARCH_IDX = new Map();   // file → { off, text, lower }
function searchText(line) {
  if (line.length > 4e6 || !(line.includes('"user"') || line.includes('"assistant"'))) return "";
  let ev; try { ev = JSON.parse(line); } catch { return ""; }
  if ((ev.type !== "user" && ev.type !== "assistant") || ev.isMeta) return "";
  const c = ev.message?.content, out = [];
  if (typeof c === "string") out.push(c);
  else if (Array.isArray(c)) for (const b of c) if (b && b.type === "text" && typeof b.text === "string") out.push(b.text);
  return out.filter((t) => t && !t.startsWith("<")).join(" ").replace(/\s+/g, " ").trim();
}
async function indexSessionFile(file, size) {
  let e = SEARCH_IDX.get(file);
  if (!e || size < e.off) e = { off: 0, text: "", lower: "" };
  if (size > e.off) {
    const fh = await fs.promises.open(file, "r");
    try {
      let pos = e.off, rest = Buffer.alloc(0);
      const parts = [];
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(4 << 20, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const nl = chunk.lastIndexOf(10);
        if (nl < 0) { rest = Buffer.from(chunk); continue; }
        rest = Buffer.from(chunk.subarray(nl + 1));
        for (const line of chunk.toString("utf8", 0, nl).split("\n")) { const t = searchText(line); if (t) parts.push(t); }
        await new Promise((r) => setImmediate(r));   // 别一口气把事件循环占住
      }
      e.off = pos - rest.length;   // 半行留到下次
      if (parts.length) {
        const add = (e.text ? "\n" : "") + parts.join("\n");
        e.text += add; e.lower += add.toLowerCase();
      }
    } finally { await fh.close(); }
  }
  SEARCH_IDX.set(file, e);
  return e;
}
let searchChain = Promise.resolve();
function searchSessions(q) {
  const run = searchChain.then(() => searchSessionsNow(q));
  searchChain = run.catch(() => {});
  return run;
}
async function searchSessionsNow(q) {
  const needle = q.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
  if (!needle) return { q, results: [] };
  const t0 = Date.now();
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PATHS.projects, d.name);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of names) {
      const full = path.join(dir, f);
      try { const st = fs.statSync(full); files.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set(files.map((f) => f.file));
  for (const k of SEARCH_IDX.keys()) if (!seen.has(k)) SEARCH_IDX.delete(k);

  const results = [];
  for (const f of files) {
    const meta = peekSession(f.file);
    const title = NAMES[f.id] || meta.title;
    let e;
    try { e = await indexSessionFile(f.file, f.size); } catch { continue; }
    let i = e.lower.indexOf(needle), count = 0, snippet = "";
    if (i >= 0) {
      const a = Math.max(0, i - 30), b = Math.min(e.text.length, i + needle.length + 60);
      snippet = (a > 0 ? "…" : "") + e.text.slice(a, b).replace(/\n/g, " ") + (b < e.text.length ? "…" : "");
      for (let j = i; j >= 0 && count < 99; j = e.lower.indexOf(needle, j + needle.length)) count++;
    }
    const inTitle = title.toLowerCase().includes(needle);
    if (!inTitle && i < 0) continue;
    results.push({
      id: f.id, title, renamed: !!NAMES[f.id], cwd: meta.cwd, mtime: f.mtime, created: meta.created || 0,
      pinned: PINS[f.id] || 0, sizeKb: Math.round(f.size / 1024), snippet, count, inTitle,
    });
  }
  const ms = Date.now() - t0;
  if (ms > 1500) log(`会话搜索 ${files.length} 个文件用了 ${ms}ms`);
  return { q, results: results.slice(0, 100), total: results.length, ms };
}

function findSessionFile(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;   // 防目录穿越
  let dirs = [];
  try {
    dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return null; }
  for (const d of dirs) {
    const full = path.join(PATHS.projects, d.name, id + ".jsonl");
    if (fs.existsSync(full)) return { file: full, project: d.name };
  }
  return null;
}

// ── 会话管理：回收站 / 导出 / 导入 ─────────────────────────────────────
// 回收站放在 claude 的 projects 目录之外（它看不见，--resume 也就找不回来），同一文件系统，挪进挪出都是 rename。
// 每个会话一格：<id>.jsonl + 同名目录（子代理、超长工具结果）+ meta.json（原项目目录、标题、删除时间）。
const TRASH_DIR = path.join(CFG.home, ".ccapp-trash");
const TRASH_KEEP_DAYS = 30;
const SID_RE = /^[A-Za-z0-9._-]+$/;

// ── 分叉：从某一轮之后另起一个会话 ──
// 把 transcript 从头抄到「这一轮的最后一行」（下一条用户消息之前），换个会话号写成新文件。
// 和 claude 自带的 --fork-session 是一回事，只是能挑从哪一轮分。原会话一个字节都不动。
// 定位那一轮：前端给出这一轮的用户消息原文 + 它后面还有几条用户消息（after）。
// 斜杠命令在界面上有气泡、在 transcript 里却是 <command-name> 行，单靠计数会错位，
// 所以先按原文找候选，再取倒数位置最接近 after 的那条；原文一条都对不上就拒绝，绝不切错地方。
const forkNorm = (t) => String(t || "").replace(/\[图片\]/g, "").replace(/\s+/g, " ").trim();
function forkUserText(ev) {
  if (!ev || ev.type !== "user" || ev.isSidechain || ev.isMeta || ev.isCompactSummary) return null;
  const c = ev.message?.content;
  if (typeof c === "string") return c && !c.startsWith("<") ? c : null;
  if (!Array.isArray(c)) return null;
  const texts = c.filter((x) => x.type === "text" && x.text && !x.text.startsWith("<")).map((x) => x.text);
  if (c.some((x) => x.type === "image")) texts.push("[图片]");
  return texts.length ? texts.join("\n") : null;
}
// ── /goal 目标（上游 2.1.x：设一个完成条件，Claude 跨轮一直干到满足为止）──
// -p 模式下目标状态不进事件流，只记在会话记录里：attachment.type === "goal_status"
//   设定 → {met:false, sentinel:true, condition}；没达成 → {met:false, condition, reason}；
//   达成 → {met:true, iterations, durationMs, tokens}；做不到 → {failed:true, reason}
// 「/goal clear」（stop/off/reset/none/cancel 同义）只留一条命令记录，没有 goal_status，要自己认。
const GOAL_CLEAR = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
function goalStateOf(file) {
  let txt = "";
  try {
    const st = fs.statSync(file), n = Math.min(st.size, 512 * 1024), fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); txt = b.toString("utf8"); } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = txt.split("\n");
  let last = null, lastAt = 0, setAt = null, checks = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes("goal")) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!last && e.type === "user" && typeof e.message?.content === "string") {
      const m = e.message.content.match(/<command-name>\/goal<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (m && GOAL_CLEAR.has(m[1].trim().toLowerCase())) return null;   // 最近一次是清除
    }
    const a = e.type === "attachment" && e.attachment?.type === "goal_status" ? e.attachment : null;
    if (!a) continue;
    if (!last) { last = a; lastAt = Date.parse(e.timestamp) || 0; if (a.met || a.failed) break; }
    if (a.condition !== last.condition) break;
    if (a.sentinel) { setAt = Date.parse(e.timestamp) || null; break; }
    if (!a.met) checks++;
  }
  if (!last) return null;
  const base = { condition: String(last.condition || "").slice(0, 600), at: lastAt };
  if (last.met || last.failed) return { ...base, done: true, met: !!last.met, failed: !!last.failed, reason: String(last.reason || "").slice(0, 600),
    iterations: last.iterations ?? null, durationMs: last.durationMs ?? null, tokens: last.tokens ?? null };
  return { ...base, active: true, setAt, checks, reason: last.sentinel ? "" : String(last.reason || "").slice(0, 600) };
}
// 跑着的时候每 4 秒看一眼（只看有会话号的轮），变了才推；每轮结束再补看一次（见 endRun），最后那次达成不会漏
const GOAL_SEEN = new Map();   // 会话号 → 上次推出去的 JSON
function goalCheck(sid) {
  const f = sid && findSessionFile(sid);
  if (!f) return;
  const g = goalStateOf(f.file), j = JSON.stringify(g);
  if (GOAL_SEEN.get(sid) === j) return;
  GOAL_SEEN.set(sid, j);
  if (GOAL_SEEN.size > 200) GOAL_SEEN.delete(GOAL_SEEN.keys().next().value);
  publish({ type: "goal", sessionId: sid, goal: g });
}
setInterval(() => { for (const r of RUNS.values()) { goalCheck(r.sessionId); tasksCheck(r.sessionId); } }, 4000).unref?.();

// 任务清单（TaskCreate / TaskUpdate）：claude 存在 ~/.claude/tasks/<会话号>/<编号>.json，--resume 沿用同一会话号，所以每轮换进程也接得上
const TASKS_DIR = path.join(CFG.home, ".claude", "tasks");
function tasksOf(sid) {
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) return null;
  const d = path.join(TASKS_DIR, sid);
  let names; try { names = fs.readdirSync(d).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  const list = [];
  for (const n of names) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(d, n), "utf8"));
      if (!t || t.status === "deleted") continue;
      list.push({ id: String(t.id || n.replace(".json", "")), subject: String(t.subject || "").slice(0, 200),
        status: t.status || "pending", active: t.activeForm ? String(t.activeForm).slice(0, 200) : "",
        blocked: Array.isArray(t.blockedBy) && t.blockedBy.length ? t.blockedBy.map(String) : undefined });
    } catch {}
  }
  if (!list.length) return null;
  list.sort((x, y) => (Number(x.id) || 0) - (Number(y.id) || 0));
  return list.slice(0, 60);
}
const TASKS_SEEN = new Map();
function tasksCheck(sid) {
  if (!sid) return;
  const t = tasksOf(sid), j = JSON.stringify(t);
  if ((TASKS_SEEN.get(sid) ?? "null") === j) return;
  TASKS_SEEN.set(sid, j);
  if (TASKS_SEEN.size > 200) TASKS_SEEN.delete(TASKS_SEEN.keys().next().value);
  publish({ type: "tasks", sessionId: sid, tasks: t });
}

function locateUserTurn(id, userText, after) {
  const found = findSessionFile(id);
  if (!found) return { ok: false, status: 404, message: tz("找不到这个会话。") };
  const lines = fs.readFileSync(found.file, "utf8").split("\n");
  const users = [];
  lines.forEach((line, i) => {
    if (!line.includes('"user"')) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    const t = forkUserText(ev);
    if (t != null) users.push({ i, t: forkNorm(t), uuid: ev.uuid || null });
  });
  const want = forkNorm(userText), head = want.slice(0, 80);
  const same = (t) => t === want || (head.length >= 8 && (t.startsWith(head) || want.startsWith(t.slice(0, 80))));
  let best = -1;
  users.forEach((u, j) => {
    if (!same(u.t)) return;
    const d = Math.abs(users.length - 1 - j - (Number(after) || 0));
    if (best < 0 || d < Math.abs(users.length - 1 - best - (Number(after) || 0))) best = j;
  });
  if (best < 0) return { ok: false, status: 409, message: tz("在会话记录里找不到这一轮，刷新后再试。") };
  return { ok: true, found, lines, users, best };
}

function forkSession(id, userText, after, { before = false } = {}) {
  const loc = locateUserTurn(id, userText, after);
  if (!loc.ok) return loc;
  const { found, lines, users } = loc;
  const best = before ? loc.best - 1 : loc.best;      // 回退：只留这条之前的
  const cut = best + 1 < users.length ? users[best + 1].i : lines.length;
  if (cut === lines.length && runOfSession(id)) return { ok: false, status: 409, message: tz("这一轮还在生成，等它答完再分叉。") };
  const nid = crypto.randomUUID();
  const out = [];
  for (const line of lines.slice(0, cut)) {
    if (!line.trim()) continue;
    if (!line.includes(id)) { out.push(line); continue; }
    try { const ev = JSON.parse(line); if (ev.sessionId === id) ev.sessionId = nid; out.push(JSON.stringify(ev)); }
    catch { out.push(line); }
  }
  const dir = path.dirname(found.file);
  fs.writeFileSync(path.join(dir, nid + ".jsonl"), out.join("\n") + "\n");
  // 同名目录里是子代理记录、超长工具结果：一起抄过去，引用它们的路径照旧有效
  const side = path.join(dir, id);
  try { if (fs.statSync(side).isDirectory()) fs.cpSync(side, path.join(dir, nid), { recursive: true }); } catch {}
  const title = (NAMES[id] || peekSession(found.file).title || "").slice(0, 100);
  NAMES[nid] = title + " · " + tr(LAST_LANG, before ? tz("回退") : tz("分叉")); saveNames();
  log(`会话分叉 ${id.slice(0, 8)} → ${nid.slice(0, 8)}（保留 ${best + 1}/${users.length} 轮）`);
  return { ok: true, id: nid, title: NAMES[nid], kept: best + 1, total: users.length };
}

/** 把 Claude 改过的文件退回到某条用户消息之前（claude 的文件检查点，只覆盖 Edit / Write / NotebookEdit，命令改的不算）。
 *  每轮一个进程也没关系：检查点记在会话记录里，--resume 起来就能用（2026-10-19 实测）。dryRun 只算会动哪些文件。 */
function rewindFiles(sid, userUuid, dryRun) {
  return new Promise((resolve) => {
    const [cmd0, args0] = claudeCmd(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", sid]);
    const child = spawn(cmd0, args0, { cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let buf = "", done = false, err = "", exited = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child.stdin.end(); } catch {} setTimeout(() => { if (!exited) killTree(child); }, 3000); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: tz("回退超时") }), 60000);
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(l); } catch { continue; }
        if (ev.type !== "control_response") continue;
        const r = ev.response || {};
        if (r.subtype === "error") finish({ ok: false, error: String(r.error || "rewind failed") });
        else finish({ ok: true, ...(r.response || {}) });
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.on("error", () => {});
    child.on("close", () => { exited = true; finish({ ok: false, error: err.trim().slice(-300) || "claude exited" }); });
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "rw-" + Date.now(), request: { subtype: "rewind_files", user_message_id: userUuid, dry_run: !!dryRun } }) + "\n");
  });
}

/** claude 自己的回退跨文件系统时会悄悄失败：备份在应用私有目录，工作区在 /sdcard（FUSE），
 *  改过的文件写不回去（新建的文件删得掉），响应照样说成功（2026-10-19 实测）。
 *  这里按会话记录里的快照逐个核对 files（试算给的清单），不对的自己从备份拷回去 / 删掉。
 *  目标状态：这条消息的快照里有 → 用它的备份（备份名为 null 表示那时文件不存在）；
 *  没有（之后才第一次改到）→ 用之后最早一份快照里的备份，那就是第一次改之前的样子。 */
function rewindFixup(sessionFile, sid, uuid, files) {
  const snaps = [];   // [{ id, backups }]，同一条消息的快照更新合并进去
  try {
    for (const l of fs.readFileSync(sessionFile, "utf8").split("\n")) {
      // 两种记录：每条用户消息一份快照（file-history-snapshot）；轮次中途第一次改到某个文件时补一条 file-history-delta，挂到它所属的快照上
      const snap = l.includes('"file-history-snapshot"'), delta = l.includes('"file-history-delta"');
      if (!snap && !delta) continue;
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      const sn = ev.snapshot || {}, id = delta ? ev.snapshotMessageId : (ev.messageId || sn.messageId);
      if (!id) continue;
      let cur = snaps.find((x) => x.id === id);
      if (!cur) snaps.push(cur = { id, backups: {} });
      if (delta) { if (ev.trackingPath && ev.backup) cur.backups[ev.trackingPath] = ev.backup; }
      else Object.assign(cur.backups, sn.trackedFileBackups || {});
    }
  } catch { return { fixed: 0, failed: 0 }; }
  const at = snaps.findIndex((x) => x.id === uuid);
  if (at < 0) return { fixed: 0, failed: 0 };
  const absOf = (k, b) => b && b.realParentDir ? path.join(b.realParentDir, path.basename(k)) : path.resolve(CFG.workspace, k);
  const hist = path.join(CFG.home, ".claude", "file-history", sid);
  let fixed = 0, failed = 0;
  for (const want of files || []) {
    let entry;
    for (let i = at; i < snaps.length && entry === undefined; i++) {
      for (const [k, b] of Object.entries(snaps[i].backups)) if (absOf(k, b) === want) { entry = b; break; }
    }
    if (entry === undefined) continue;                 // 快照里查不到：不碰
    try {
      if (!entry.backupFileName) {                     // 那时还不存在
        if (fs.existsSync(want)) { fs.unlinkSync(want); fixed++; }
        continue;
      }
      const src = path.join(hist, entry.backupFileName);
      const data = fs.readFileSync(src);
      let curr = null; try { curr = fs.readFileSync(want); } catch {}
      if (curr && curr.equals(data)) continue;
      fs.mkdirSync(path.dirname(want), { recursive: true });
      fs.writeFileSync(want, data);
      fixed++;
    } catch (e) { failed++; log(`回退补救失败 ${want}: ${e.message}`); }
  }
  return { fixed, failed };
}

function trashSession(id) {
  const found = findSessionFile(id);
  if (!found) return { ok: false, error: "not found" };
  const meta = peekSession(found.file);
  const slot = path.join(TRASH_DIR, id);
  fs.rmSync(slot, { recursive: true, force: true });
  fs.mkdirSync(slot, { recursive: true });
  const st = fs.statSync(found.file);
  fs.renameSync(found.file, path.join(slot, id + ".jsonl"));
  const side = path.join(PATHS.projects, found.project, id);
  if (fs.existsSync(side)) fs.renameSync(side, path.join(slot, "dir"));
  fs.writeFileSync(path.join(slot, "meta.json"), JSON.stringify({
    id, project: found.project, title: NAMES[id] || meta.title, renamed: !!NAMES[id], pinned: PINS[id] || 0,
    cwd: meta.cwd, mtime: st.mtimeMs, size: st.size, deletedAt: Date.now(),
  }));
  if (PINS[id]) { delete PINS[id]; savePins(); }
  PEEK_CACHE.delete(found.file);
  delete NAMES[id]; saveNames();
  // 删的正好是「最近跑过的那条」：别让前端下次打开时又指回去（会显示「找不到这个会话」而不是欢迎页）
  if (LAST_SESSION && LAST_SESSION.id === id) {
    LAST_SESSION = null;
    try { fs.rmSync(LAST_SESSION_FILE, { force: true }); } catch {}
  }
  return { ok: true };
}

function listTrash() {
  let ids = [];
  try { ids = fs.readdirSync(TRASH_DIR); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(TRASH_DIR, id, "meta.json"), "utf8"))); } catch {}
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

function restoreSession(id) {
  if (!SID_RE.test(id)) return { ok: false, error: "bad id" };
  const slot = path.join(TRASH_DIR, id);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(slot, "meta.json"), "utf8")); } catch { return { ok: false, error: "not found" }; }
  if (findSessionFile(id)) return { ok: false, error: "exists" };
  const dir = path.join(PATHS.projects, SID_RE.test(meta.project || "") ? meta.project : projectSlug(realWorkspace()));
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(path.join(slot, id + ".jsonl"), path.join(dir, id + ".jsonl"));
  if (fs.existsSync(path.join(slot, "dir"))) fs.renameSync(path.join(slot, "dir"), path.join(dir, id));
  if (meta.renamed && meta.title) { NAMES[id] = meta.title; saveNames(); }
  if (meta.pinned) { PINS[id] = meta.pinned; savePins(); }
  fs.rmSync(slot, { recursive: true, force: true });
  return { ok: true };
}

function purgeTrash(ids) {
  let n = 0;
  for (const id of ids) {
    if (!SID_RE.test(id)) continue;
    const slot = path.join(TRASH_DIR, id);
    if (fs.existsSync(slot)) { fs.rmSync(slot, { recursive: true, force: true }); n++; }
  }
  return n;
}

/** 回收站里放满 30 天的自动清掉（网关启动时跑一次） */
function expireTrash() {
  const cut = Date.now() - TRASH_KEEP_DAYS * 86400000;
  const old = listTrash().filter((m) => m.deletedAt < cut).map((m) => m.id);
  if (old.length) log(`回收站：清掉 ${purgeTrash(old)} 个放满 ${TRASH_KEEP_DAYS} 天的会话`);
}

/** claude 给 cwd 起项目目录名的规则：非字母数字一律换成 -。
 *  它拿的是解析过符号链接的真实路径（/sdcard → /storage/emulated/0），这边也得先 realpath，否则对不上 */
function realWorkspace() { try { return fs.realpathSync(CFG.workspace); } catch { return CFG.workspace; } }
function projectSlug(cwd) { return String(cwd).replace(/[^A-Za-z0-9]/g, "-"); }

// 极简 zip（只 deflate / store，够会话包用）。不引第三方包：网关是单文件分发的
function zipBuild(entries) {
  const locals = [], centrals = [];
  let off = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const store = comp.length >= raw.length;
    const body = store ? raw : comp;
    const crc = zlib.crc32(raw) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(store ? 0 : 8, 8); h.writeUInt16LE(dosTime(now), 10); h.writeUInt16LE(dosDate(now), 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(store ? 0 : 8, 10); c.writeUInt16LE(dosTime(now), 12); c.writeUInt16LE(dosDate(now), 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, name, body);
    centrals.push(c, name);
    off += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function zipRead(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error(tz("不是 zip 文件"));
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(tz("zip 目录损坏"));
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const body = buf.subarray(ds, ds + csize);
    if (method !== 0 && method !== 8) throw new Error(tz("不支持的压缩方式：{name}", { name }));
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body) });
  }
  return out;
}

/** 导出：manifest.json + sessions/<id>.jsonl + sessions/<id>/…（子代理等） */
function exportSessions(ids) {
  const entries = [], list = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, d.name);
      if (d.isDirectory()) walk(f, rel + "/" + d.name);
      else if (d.isFile()) entries.push({ name: rel + "/" + d.name, data: fs.readFileSync(f) });
    }
  };
  for (const id of ids) {
    const found = findSessionFile(id);
    if (!found) continue;
    const meta = peekSession(found.file);
    entries.push({ name: `sessions/${id}.jsonl`, data: fs.readFileSync(found.file) });
    const side = path.join(PATHS.projects, found.project, id);
    if (fs.existsSync(side)) walk(side, `sessions/${id}`);
    list.push({ id, title: NAMES[id] || meta.title, renamed: !!NAMES[id], cwd: meta.cwd, mtime: fs.statSync(found.file).mtimeMs });
  }
  if (!list.length) throw new Error(tz("没有可导出的会话"));
  entries.unshift({ name: "manifest.json", data: JSON.stringify({ format: "cccodroid-sessions", version: 1, exportedAt: Date.now(), sessions: list }, null, 1) });
  const base = process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED) ? process.env.CCAPP_SHARED : CFG.home;
  const dir = path.join(base, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(dir, `sessions-${stamp}.zip`);
  const zip = zipBuild(entries);
  fs.writeFileSync(file, zip);
  return { file, count: list.length, bytes: zip.length };
}

/** 导入：一律落进当前工作区（cwd 改写成本机工作区，--resume 才找得到）；同 id 已有的跳过 */
function importSessions(buf) {
  const files = zipRead(buf);
  const man = files.find((f) => f.name === "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(man.data.toString("utf8")); } catch { throw new Error(tz("缺少 manifest.json，不是会话包")); }
  if (manifest.format !== "cccodroid-sessions") throw new Error(tz("不是 cccodroid 会话包"));
  const ws = realWorkspace();
  const dir = path.join(PATHS.projects, projectSlug(ws));
  fs.mkdirSync(dir, { recursive: true });
  const res = { imported: [], skipped: [] };
  for (const s of manifest.sessions || []) {
    const id = String(s.id || "");
    if (!SID_RE.test(id)) continue;
    const main = files.find((f) => f.name === `sessions/${id}.jsonl`);
    if (!main) continue;
    if (findSessionFile(id) || fs.existsSync(path.join(TRASH_DIR, id))) { res.skipped.push(id); continue; }
    const lines = main.data.toString("utf8").split("\n").map((l) => {
      if (!l.includes('"cwd"')) return l;
      try { const ev = JSON.parse(l); if (ev.cwd) ev.cwd = ws; return JSON.stringify(ev); } catch { return l; }
    });
    fs.writeFileSync(path.join(dir, id + ".jsonl"), lines.join("\n"));
    if (s.mtime) try { fs.utimesSync(path.join(dir, id + ".jsonl"), new Date(), new Date(s.mtime)); } catch {}
    const pre = `sessions/${id}/`;
    for (const f of files) {
      if (!f.name.startsWith(pre)) continue;
      const rel = f.name.slice(pre.length);
      if (rel.split("/").some((x) => !x || x === "." || x === "..")) continue;   // 防目录穿越
      const dst = path.join(dir, id, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.data);
    }
    if (s.renamed && s.title) NAMES[id] = String(s.title).slice(0, 120);
    res.imported.push(id);
  }
  saveNames();
  return res;
}

/** 工具参数里的长字符串截短 —— 历史里一个 Write 工具能带几百 KB 的文件内容，
 *  原样回传只会把界面拖死；摘要（command / file_path …）用不到那么长。 */
function clipInput(v, depth = 0) {
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + `…（共 ${v.length} 字）` : v;
  if (!v || typeof v !== "object" || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipInput(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = clipInput(v[k], depth + 1);
  return o;
}

/** 会话的子代理记录：<会话>/subagents/agent-*.meta.json 里的 toolUseId → 对应 agent-*.jsonl */
function agentFilesOf(sessionFile) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ""), "subagents"), m = new Map();
  let names; try { names = fs.readdirSync(dir); } catch { return m; }
  for (const n of names) {
    if (!n.endsWith(".meta.json")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      const f = path.join(dir, n.replace(/\.meta\.json$/, ".jsonl"));
      if (j.toolUseId && fs.existsSync(f)) m.set(String(j.toolUseId), f);
    } catch {}
  }
  return m;
}

/** transcript 的一行 → 0..n 条可渲染的消息 */
function transcriptItems(ev) {
  const out = [];
  if (!ev || ev.isSidechain || ev.isMeta) return out;
  if (ev.type === "user") {
    if (ev.isCompactSummary) { out.push({ role: "note", text: tr(LAST_LANG, tz("（此前的对话已被压缩成摘要）")) }); return out; }
    const c = ev.message?.content;
    if (typeof c === "string") {
      if (c && !c.startsWith("<")) out.push({ role: "user", text: c });
    } else if (Array.isArray(c)) {
      const texts = c.filter((x) => x.type === "text" && x.text && !x.text.startsWith("<")).map((x) => x.text);
      if (c.some((x) => x.type === "image")) texts.push("[图片]");
      if (texts.length) out.push({ role: "user", text: texts.join("\n") });
      for (const r of c) {
        if (r.type !== "tool_result") continue;
        let t = "";
        if (typeof r.content === "string") t = r.content;
        else if (Array.isArray(r.content)) t = r.content.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
        out.push({ role: "tool_result", id: r.tool_use_id, ok: !r.is_error, text: String(t).slice(0, 4000) });
      }
    }
  } else if (ev.type === "assistant") {
    for (const c of ev.message?.content || []) {
      if (c.type === "text" && c.text) out.push({ role: "assistant", text: c.text });
      else if (c.type === "thinking" && c.thinking) out.push({ role: "thinking", text: c.thinking.slice(0, 60000) });
      else if (c.type === "tool_use") out.push({ role: "tool_use", id: c.id, name: c.name, input: clipInput(c.input) });
    }
  }
  return out;
}

/** 从 transcript **尾部倒着**读一页消息。
 *
 *  老办法是 readFileSync 整个文件再全量解析 —— 十几 MB 的会话会把网关的事件循环
 *  同步卡住好几秒，期间所有请求（包括正在推流的 SSE）一起排队，这就是"一恢复会话就卡半天"。
 *  现在：异步、按 256KB 块往回读，凑够 limit 条且停在一轮对话的开头（用户消息）就收手。
 *  cursor = 这一页最早那行的字节偏移，下次带 before=cursor 接着往前翻；0 表示到头了。
 *
 *  excludeFrom：正在生成的那一轮由事件总线实时推，这里按时间戳把它剔掉，免得画两遍。 */
async function readSessionPage(file, { before = null, limit = 40, excludeFrom = 0 } = {}) {
  const CH = 256 * 1024, MAX_SCAN = 12 * 1024 * 1024;
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    let cursor = before == null ? size : Math.max(0, Math.min(Number(before) || 0, size));
    let pos = cursor, tail = Buffer.alloc(0), scanned = 0;
    const items = [];
    let contextTokens = null;

    while (pos > 0) {
      const start = Math.max(0, pos - CH);
      const chunk = Buffer.alloc(pos - start);
      await fh.read(chunk, 0, chunk.length, start);
      const data = tail.length ? Buffer.concat([chunk, tail]) : chunk;   // 覆盖 [start, cursor)
      pos = start;
      scanned += chunk.length;
      let lineEnd = data.length;

      for (;;) {
        const from = lineEnd - 2;
        const nl = from >= 0 ? data.lastIndexOf(10, from) : -1;
        if (nl < 0 && start > 0) { tail = data.subarray(0, lineEnd); break; }   // 行头还在更前面
        const lineStart = nl < 0 ? 0 : nl + 1;
        const line = data.toString("utf8", lineStart, lineEnd).trim();
        lineEnd = lineStart;
        cursor = start + lineStart;

        let turnStart = false;
        if (line) {
          let ev = null; try { ev = JSON.parse(line); } catch {}
          if (ev && !(excludeFrom && ev.timestamp && Date.parse(ev.timestamp) >= excludeFrom)) {
            // 倒着读，碰到的第一条 assistant 用量就是"当前"上下文占用
            if (contextTokens == null && ev.type === "assistant" && ev.message?.usage && !ev.isSidechain) {
              contextTokens = promptTokens(ev.message.usage);
            }
            const its = transcriptItems(ev);
            if (its.length) {
              items.unshift(...its);
              turnStart = its[0].role === "user";
            }
          }
        }
        if (cursor === 0) break;
        if ((items.length >= limit && turnStart) || items.length >= limit * 4) {
          return { items, cursor, size, contextTokens };
        }
        if (nl < 0) break;
      }
      if (scanned >= MAX_SCAN && items.length) break;   // 极端大行：先交这一页，别无限往前扫
    }
    return { items, cursor: pos === 0 && !tail.length ? 0 : cursor, size, contextTokens };
  } finally {
    await fh.close();
  }
}

// ── 能力清单 ──────────────────────────────────────────────────────────
let LAST_INIT = null;          // 最近一次 init 事件（含 tools / slash_commands / skills / agents）

/** 各斜杠命令的分类与说明（用于 GUI 面板；未列出的按“转发给 claude”处理） */
const COMMAND_META = {
  context:   { cat: "上下文", desc: "查看上下文窗口占用与技能清单", local: true },
  compact:   { cat: "上下文", desc: "压缩对话历史，释放上下文空间", local: true },
  clear:     { cat: "上下文", desc: "清空当前会话上下文，另起一段", local: true },
  cost:      { cat: "状态",   desc: "本次会话的花费与时长", local: true },
  usage:     { cat: "状态",   desc: "订阅用量与限额", local: true },
  status:    { cat: "状态",   desc: "当前环境与配置状态", local: true },
  doctor:    { cat: "状态",   desc: "检查安装健康状况", local: true },
  model:     { cat: "配置",   desc: "查看或切换模型", local: true },
  config:    { cat: "配置",   desc: "查看或修改配置项", local: true },
  effort:    { cat: "配置",   desc: "调整思考强度", local: true },
  fast:      { cat: "配置",   desc: "切换快速模式", local: true },
  mcp:       { cat: "扩展",   desc: "管理 MCP 服务器", local: true },
  agents:    { cat: "扩展",   desc: "管理子代理", local: true },
  memory:    { cat: "上下文", desc: "编辑 CLAUDE.md 记忆文件", local: true },
  init:      { cat: "项目",   desc: "为当前项目生成 CLAUDE.md", local: false },
  review:    { cat: "项目",   desc: "审查当前改动", local: false },
  "security-review": { cat: "项目", desc: "安全审查", local: false },
  "code-review":     { cat: "项目", desc: "代码审查", local: false },
  rename:    { cat: "会话",   desc: "重命名当前会话", local: true },
  resume:    { cat: "会话",   desc: "恢复历史会话", local: true },
  recap:     { cat: "会话",   desc: "回顾本次会话要点", local: true },
  insights:  { cat: "状态",   desc: "使用洞察报告", local: true },
  goal:      { cat: "工作流", desc: "设定长期目标", local: false },
  loop:      { cat: "工作流", desc: "循环执行任务", local: false },
  batch:     { cat: "工作流", desc: "批量处理", local: false },
  verify:    { cat: "工作流", desc: "验证改动", local: false },
  debug:     { cat: "工作流", desc: "调试问题", local: false },
  simplify:  { cat: "工作流", desc: "简化代码", local: false },
  "deep-research": { cat: "工作流", desc: "深度研究", local: false },
  workflow:  { cat: "工作流", desc: "编排多代理工作流", local: false },
};

const FALLBACK_COMMANDS = Object.keys(COMMAND_META);

function capabilities() {
  const init = LAST_INIT || {};
  const cmds = (init.slash_commands || FALLBACK_COMMANDS).filter((c) => !c.startsWith("__"));
  return {
    ready: !!LAST_INIT,
    model: SETTINGS.model,
    permissionMode: SETTINGS.permissionMode,
    tools: init.tools || [],
    slashCommands: cmds.map((c) => ({
      name: c,
      ...(COMMAND_META[c] || { cat: "其他", desc: "", local: false }),
    })),
    skills: init.skills || [],
    agents: init.agents || [],
    plugins: (init.plugins || []).map((p) => (typeof p === "string" ? p : p.name || String(p))),
    mcpServers: init.mcp_servers || [],
    outputStyle: init.output_style || "default",
    version: init.claude_code_version || "",
    settings: SETTINGS,
  };
}

// ── 会话进程状态 ──────────────────────────────────────────────────────
const SESSIONS = new Map();   // 内存里记录本次运行见过的会话
// 正在跑的轮次（并行多会话）：runId → run。同一个会话同时只跑一轮，不同会话按设置里的上限同时跑
const RUNS = new Map();
const runList = () => [...RUNS.values()];
const latestRun = () => { let r = null; for (const x of RUNS.values()) if (!r || x.startedAt >= r.startedAt) r = x; return r; };
const runOfSession = (sid) => (sid && runList().find((r) => r.sessionId === sid)) || null;
// 同时跑几轮：每个 claude 进程要占几百 MB 内存，开多大由用户自己把握
const MAX_PARALLEL_CAP = 16;
const maxParallel = () => Math.max(1, Math.min(MAX_PARALLEL_CAP, Math.round(Number(SETTINGS.maxParallel)) || 3));
// 有任务在跑时落一个标记文件：cccodroid 的冻结检测只把「跑任务时被冻」算数 ——
// 空闲时被厂商冻结器冻住无害，以前每次都记，设置页的提醒就老是弹
const RUN_FLAG = path.join(CFG.home, ".run-active");
const runFlag = (on) => { try { on ? fs.writeFileSync(RUN_FLAG, String(process.pid)) : fs.rmSync(RUN_FLAG, { force: true }); } catch {} };
runFlag(false);

// 最近真正跑过的会话。落盘保存 —— 网关重启（热替换/重开 App）后前端还能接回原来的对话。
const LAST_SESSION_FILE = path.join(CFG.home, "ccapp-last-session.json");
let LAST_SESSION = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, "utf8"));
    if (j && j.id) return { id: String(j.id), at: Number(j.at) || 0 };
  } catch {}
  return null;
})();
function rememberSession(id) {
  if (!id) return;
  LAST_SESSION = { id: String(id), at: Date.now() };
  try { fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify(LAST_SESSION), { mode: 0o600 }); } catch {}
}

// ── HTTP ──────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff": "font/woff", ".woff2": "font/woff2",
  // 读图 / 读文件要用的类型
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  ".apk": "application/vnd.android.package-archive", ".zip": "application/zip",
  ".wasm": "application/wasm",
  // HTML 预览里网页会引用的
  ".htm": "text/html; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf", ".otf": "font/otf", ".gltf": "model/gltf+json", ".glb": "model/gltf-binary",
};

const EXT_KIND = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".heic"],
  video: [".mp4", ".webm", ".mkv", ".mov", ".3gp"],
  audio: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".opus"],
  // Office：docx、表格在前端渲染；其余交给 LibreOffice 转 PDF
  docx:  [".docx", ".docm", ".dotx"],
  sheet: [".xlsx", ".xlsm", ".xlsb", ".xls", ".ods"],
  office: [".pptx", ".ppt", ".ppsx", ".pps", ".potx", ".odp", ".doc", ".dot", ".odt", ".rtf", ".wps", ".dps", ".et", ".key", ".pages", ".numbers"],
  text:  [".txt", ".md", ".log", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".js", ".mjs",
          ".css", ".c", ".h", ".cpp", ".py", ".sh", ".java", ".kt", ".rs", ".go", ".ts", ".sql",
          ".toml", ".ini", ".conf", ".cfg", ".properties", ".gradle", ".kts", ".tsx", ".jsx", ".cjs",
          ".vue", ".svelte", ".scss", ".less", ".hpp", ".cc", ".cxx", ".rb", ".php", ".lua", ".pl",
          ".swift", ".dart", ".cs", ".zig", ".r", ".tex", ".typ", ".gd", ".tscn", ".tres", ".diff",
          ".patch", ".bash", ".zsh", ".fish", ".bat", ".ps1", ".rst", ".org", ".tsv", ".jsonl", ".svg"],
};
const KIND_OF = new Map();
for (const [k, list] of Object.entries(EXT_KIND)) for (const e of list) KIND_OF.set(e, k);

function fileKind(name, isDir) {
  if (isDir) return "dir";
  const e = path.extname(name).toLowerCase();
  if (e === ".pdf") return "pdf";
  return KIND_OF.get(e) || "other";
}
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || "application/octet-stream";

// ── 文件收发：读图 / 读文件 / 把东西递进来 ────────────────────────────
// /api/file   把磁盘上的文件流给界面（消息里的图片靠它显示）
// /api/upload 把界面拿到的东西（粘贴/拖放/选择）落盘成 claude 能读的路径
const UPLOAD_DIR = path.join(CFG.workspace, "uploads");

/** 绝不外发的路径：密钥所在的应用私有目录、运行时、以及几个具名的凭据文件。
 *  说明：这台网关本就只监听 127.0.0.1，且 /api/chat 等于本机任意命令执行 ——
 *  这一层是「别让取文件接口顺手把密钥递出去」的防呆，不是完整的鉴权边界。 */
const SECRET_NAMES = new Set([
  "ccapp-providers.json", "ccapp-config.json", "ccapp-seed.json",
  "keystore.json", "debug.keystore", "id_ed25519", "id_rsa", "id_ecdsa",
]);
const SECRET_RE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud)(\/|$)/;

/** 在不在工作区里（按真实路径）。cccodroid 的工作区就在 home 下面（files/home/workspace）——
 *  只按 home 拦，工作区里的文件（附件、Claude 生成的图）就全成了 403，缩略图和查看器都打不开 */
function inWorkspace(real) {
  let ws; try { ws = fs.realpathSync(CFG.workspace); } catch { ws = CFG.workspace; }
  return real === ws || real.startsWith(ws + path.sep);
}

function safeFilePath(p) {
  if (!p) return { error: "path required" };
  let full = String(p).trim();
  if (full.startsWith("file://")) { try { full = fileURLToPath(full); } catch {} }
  if (!path.isAbsolute(full)) full = path.join(CFG.workspace, full);

  let real;
  try { real = fs.realpathSync(full); } catch (e) { return { error: "not found", detail: e.message }; }

  for (const root of inWorkspace(real) ? [SEED_FILE] : [CFG.home, CFG.runtime, SEED_FILE]) {
    if (!root) continue;
    let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
    if (real === rr || real.startsWith(rr + path.sep)) return { error: "forbidden", status: 403 };
  }
  if (SECRET_NAMES.has(path.basename(real)) || SECRET_RE.test(real)) {
    return { error: "forbidden", status: 403 };
  }

  let st; try { st = fs.statSync(real); } catch (e) { return { error: e.message }; }
  if (st.isDirectory()) return { error: "is a directory", status: 400 };
  return { file: real, size: st.size, mtime: st.mtimeMs };
}

/** 写文件前的同一套防呆：已有文件走 safeFilePath；新文件看父目录 */
function safeWritePath(p) {
  if (!p || !path.isAbsolute(String(p))) return { error: "absolute path required", status: 400 };
  const full = String(p);
  if (fs.existsSync(full)) return safeFilePath(full);
  let dir;
  try { dir = fs.realpathSync(path.dirname(full)); } catch (e) { return { error: "no such directory", status: 400 }; }
  for (const root of inWorkspace(dir) ? [] : [CFG.home, CFG.runtime]) {
    let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
    if (dir === rr || dir.startsWith(rr + path.sep)) return { error: "forbidden", status: 403 };
  }
  const name = path.basename(full);
  if (SECRET_NAMES.has(name) || SECRET_RE.test(path.join(dir, name))) return { error: "forbidden", status: 403 };
  return { file: path.join(dir, name), size: 0, mtime: 0, fresh: true };
}

// ── HTML 预览 ─────────────────────────────────────────────────────────
// 查看器里渲染 HTML：另起一个只读的小服务（随机端口，地址用 localhost），和界面（127.0.0.1:端口）不同站点——
// 预览页里的脚本拿不到界面的 Cookie，也过不了 /api 的 Origin 校验，Claude 写的网页随便跑也碰不到网关。
// 每次预览发一张随机凭证，只能读那个 HTML 所在目录里的东西；路径照样过 safeFilePath（密钥、私有目录照旧拦）。
// 网址形如 http://localhost:<端口>/<凭证>/index.html，相对路径自然解析；"/assets/x.js" 这种站点绝对路径按 Referer 里的凭证找回来
const PREVIEW = { server: null, port: 0, starting: null, caps: new Map() };
function previewStart() {
  if (PREVIEW.port) return Promise.resolve(PREVIEW.port);
  if (PREVIEW.starting) return PREVIEW.starting;
  PREVIEW.starting = new Promise((resolve, reject) => {
    const srv = http.createServer(previewServe);
    srv.on("error", (e) => { PREVIEW.starting = null; reject(e); });
    srv.listen(0, "127.0.0.1", () => { PREVIEW.server = srv; PREVIEW.port = srv.address().port; resolve(PREVIEW.port); });
  });
  return PREVIEW.starting;
}
async function previewGrant(p) {
  const r = safeFilePath(p);
  if (r.error) return r;
  const port = await previewStart();
  const now = Date.now();
  for (const [k, v] of PREVIEW.caps) if (v.exp < now) PREVIEW.caps.delete(k);
  const root = path.dirname(r.file);
  let cap = [...PREVIEW.caps].find(([, v]) => v.root === root)?.[0];   // 同一目录复用，刷新不换网址
  if (!cap) { cap = crypto.randomBytes(12).toString("hex"); if (PREVIEW.caps.size >= 200) PREVIEW.caps.delete(PREVIEW.caps.keys().next().value); }
  PREVIEW.caps.set(cap, { root, exp: now + 12 * 3600e3 });
  return { url: `http://localhost:${port}/${cap}/${path.basename(r.file).split("/").map(encodeURIComponent).join("/")}`, mtime: r.mtime };
}
function previewServe(req, res) {
  const fail = (code, msg) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(msg); };
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "read only");
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `localhost:${PREVIEW.port}` && host !== `127.0.0.1:${PREVIEW.port}`) return fail(421, "bad host");
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return fail(400, "bad path"); }
  const segs = pathname.split("/").filter(Boolean);
  let cap = segs[0], rel = segs.slice(1);
  if (!PREVIEW.caps.has(cap)) {
    // 站点绝对路径（/assets/x.js）：从引用它的页面找回凭证
    let ref = ""; try { ref = new URL(String(req.headers.referer || "")).pathname.split("/")[1] || ""; } catch {}
    if (!PREVIEW.caps.has(ref)) return fail(404, "preview expired — reopen the file");
    cap = ref; rel = segs;
  }
  const g = PREVIEW.caps.get(cap);
  if (g.exp < Date.now()) { PREVIEW.caps.delete(cap); return fail(404, "preview expired — reopen the file"); }
  let full = path.resolve(g.root, ...rel);
  if (full !== g.root && !full.startsWith(g.root + path.sep)) return fail(403, "outside preview folder");
  try { if (fs.statSync(full).isDirectory()) full = path.join(full, "index.html"); } catch {}
  const r = safeFilePath(full);
  if (r.error) return fail(r.status || 404, r.error);
  const head = { "content-type": MIME[path.extname(r.file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
  // 音视频要 Range 才能拖进度
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  let start = 0, end = r.size - 1, code = 200;
  if (m && r.size) {
    start = m[1] ? +m[1] : Math.max(0, r.size - +m[2]); end = m[1] && m[2] ? Math.min(+m[2], r.size - 1) : r.size - 1;
    if (start > end || start >= r.size) { res.writeHead(416, { "content-range": `bytes */${r.size}` }); return res.end(); }
    code = 206; head["content-range"] = `bytes ${start}-${end}/${r.size}`;
  }
  head["content-length"] = r.size ? end - start + 1 : 0;
  res.writeHead(code, head);
  if (req.method === "HEAD" || !r.size) return res.end();
  const st = fs.createReadStream(r.file, { start, end });
  st.on("error", () => { try { res.destroy(); } catch {} });
  st.pipe(res);
}

/** 二进制安全的体读取（readBody 走 utf8，会把图片读坏） */
function readBodyBuf(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 供文件面板用的快捷入口 */
function fileRoots() {
  const out = [];
  const seen = new Set();
  const add = (x) => {
    if (!x || seen.has(x)) return;
    seen.add(x);
    try { if (fs.statSync(x).isDirectory()) out.push(x); } catch {}
  };
  add(UPLOAD_DIR);
  add(CFG.workspace);
  add(process.env.CCAPP_SHARED);
  add("/sdcard/DeepSeekHarness");
  add("/sdcard/Pictures"); add("/sdcard/DCIM/Camera"); add("/sdcard/Download"); add("/sdcard/Documents");
  add("/sdcard");
  for (const d of SETTINGS.addDirs || []) add(d);
  return out;
}

// ── 应用内终端 ────────────────────────────────────────────────────────
// node 没有 pty：cccodroid 自带原生小程序 app/lib/ptyhost（源码 android/native/ptyhost.c）；
// 开发端没有 lib/，退回到同一协议的 python3 pty 版。协议：
//   ptyhost <rows> <cols> <程序> [参数…]；stdin→pty，pty→stdout，fd 3 一行 "rows cols" 改窗口大小。
// 输出留一段环形缓冲：界面重开 / 断线重连时先回放，再接着推实时输出（SSE）。
const TERM_MAX = 8;
const TERM_RING = 256 * 1024;
const TERMS = new Map();
let termSeq = 0;
const PY_PTY = `import os,sys,pty,select,signal,struct,fcntl,termios,errno,time
r,c=int(sys.argv[1]),int(sys.argv[2])
try: os.fstat(3); ctl=3
except OSError: ctl=-1
pid,m=pty.fork()
if pid==0:
  if ctl>=0: os.close(ctl)
  try: os.execvp(sys.argv[3],sys.argv[3:])
  except Exception as e: sys.stderr.write("exec: %s\\r\\n"%e); os._exit(127)
def size(a,b):
  fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack("HHHH",a or 24,b or 80,0,0))
  try: os.killpg(pid,signal.SIGWINCH)
  except OSError: pass
size(r,c)
fds=[m,0]+([ctl] if ctl>=0 else []); line=b""
while True:
  try: rd,_,_=select.select(fds,[],[])
  except InterruptedError: continue
  if m in rd:
    try: d=os.read(m,16384)
    except OSError: d=b""
    if not d: break
    os.write(1,d)
  if 0 in rd:
    d=os.read(0,16384)
    if d: os.write(m,d)
    else:
      for s in (signal.SIGHUP,signal.SIGKILL):
        try: os.killpg(pid,s)
        except OSError: pass
        time.sleep(0.5)
      sys.exit(129)
  if ctl in rd:
    d=os.read(ctl,4096)
    if not d: fds.remove(ctl); continue
    line+=d
    while b"\\n" in line:
      l,line=line.split(b"\\n",1)
      try: a,b=map(int,l.split()); size(a,b)
      except ValueError: pass
_,st=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os,"waitstatus_to_exitcode") else 0)
`;

function ptyCommand() {
  const own = process.env.CCAPP_PTYHOST || path.join(HERE, "lib", "ptyhost");
  if (fs.existsSync(own)) return [own];
  const py = [PREFIX && path.join(PREFIX, "bin", "python3"), path.join(CFG.runtime, "..", "devbin", "python3")]
    .find((p) => p && fs.existsSync(p));
  return py ? [py, "-c", PY_PTY] : null;
}

/** 终端里的环境：与 claude 的工具子进程同一套 PATH / TMPDIR / terminfo，但它是给人用的 —— 要颜色，不要 CI 标记。 */
// ── git 可视化：改了哪些文件、逐行对比、提交历史、提交 / 撤销 ──────────────
// 只是 git 命令的薄壳，用终端同一套环境（PATH 里有 git）。仓库位置由前端给（文件面板当前目录 / 编辑器里的文件）
const GIT_MAX = 768 * 1024;
function git(cwd, args, { input, timeout = 30000, max = GIT_MAX } = {}) {
  return new Promise((resolve) => {
    const c = execFile("git", ["-c", "core.quotePath=false", "-c", "color.ui=false", ...args],
      { cwd, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C.UTF-8" }, timeout, maxBuffer: max * 2, encoding: "utf8" },
      (err, out, errOut) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: out || "", err: (errOut || (err && err.code === "ENOENT" ? "找不到 git" : err?.message) || "").trim() }));
    if (input != null) { c.stdin.end(input); }
  });
}
/** 抓取 / 拉取 / 推送：联网，最长 3 分钟。
 *  https 的凭据靠 gh auth setup-git（扩展页 GitHub 登录时配好的）；ssh 用本机钥匙。
 *  绝不能停下来等人输入：GIT_TERMINAL_PROMPT=0 已在 git() 里；ssh 没配过 core.sshCommand 时加 BatchMode
 *  （配过的——比如开发端走 443 端口的包装脚本——别用环境变量盖掉它）。 */
async function gitNet(root, args) {
  const sc = await git(root, ["config", "core.sshCommand"]);
  const env = sc.out.trim() ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20" };
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotePath=false", "-c", "color.ui=false", ...args],
      { cwd: root, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8", ...env }, timeout: 180000, maxBuffer: 4 << 20, encoding: "utf8" },
      (err, out, errOut) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: out || "", err: (errOut || (err && err.killed ? "timeout" : err?.message) || "").trim() }));
  });
}
function gitNetHuman(err) {
  const e = String(err || "");
  if (/timeout/i.test(e) && e.length < 20) return tz("三分钟没连上，网络可能不通。");
  if (/could not read Username|Authentication failed|terminal prompts disabled|Invalid username or password|403/i.test(e))
    return tz("远端要登录。GitHub 的仓库：到「扩展 → GitHub」登录一次（会顺便配好 git 的 https 推送）；别的网站请在终端里配好凭据。");
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(e))
    return tz("SSH 钥匙不被接受。把本机公钥加到远端账户，或者把远端地址换成 https 再用 GitHub 登录。");
  if (/Could not resolve host|Network is unreachable|Connection timed out|Connection refused|unable to access/i.test(e))
    return tz("连不上远端，检查一下网络或代理。");
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(e)) return tz("远端有你本地没有的新提交，先「拉取」再推送。");
  if (/Not possible to fast-forward|diverging|have diverged/i.test(e))
    return tz("本地和远端各有新提交（分叉了），没法直接快进。可以让 Claude 帮你合并或变基。");
  if (/would be overwritten|Please commit your changes or stash them/i.test(e)) return tz("有没提交的改动会被覆盖。先提交或撤销那些文件再试。");
  if (/No configured push destination|does not appear to be a git repository|No such remote/i.test(e)) return tz("这个仓库还没有设置远端（remote）。");
  if (/no tracking information/i.test(e)) return tz("当前分支没有对应的远端分支，先推送一次建立关联。");
  return "";
}

/** 从任意路径（文件或目录）找到所在仓库；密钥所在的私有目录一律不碰 */
async function gitRepo(p) {
  let dir = String(p || CFG.workspace).trim();
  if (!path.isAbsolute(dir)) dir = path.join(CFG.workspace, dir);
  try { dir = fs.realpathSync(dir); } catch { return { error: tz("路径不存在") }; }
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch {}
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code) return { error: /not a git repository/i.test(r.err) ? "not_repo" : r.err, notRepo: /not a git repository/i.test(r.err), dir };
  const root = r.out.trim();
  if (gitPrivate(root)) return { error: "forbidden", status: 403 };
  return { root, dir };
}
/** 仓库根落在私有目录（HOME / 运行时）里就不碰；但 cccodroid 的工作区本身就在 HOME 下面，工作区里的仓库放行 */
function gitPrivate(d) {
  const under = (a, b) => { const r = path.relative(b, a); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const real = (s) => { try { return fs.realpathSync(s); } catch { return s; } };
  const priv = [CFG.home, CFG.runtime].filter(Boolean).map(real);
  const ws = realWorkspace();
  // 在工作区里就放行；但工作区若就是 HOME（或它的上级），这条豁免作废
  if (ws && under(d, ws) && !priv.some((rr) => under(rr, ws))) return false;
  return priv.some((rr) => under(d, rr) || under(rr, d));
}
/** 仓库里的相对路径：前端给的可能是绝对路径 */
/** 仓库里的相对路径：前端给的可能是绝对路径，且 /sdcard 与 /storage/emulated/0 是同一处，按真实路径比（文件删了就解析它的目录） */
function gitRel(root, f) {
  let a = path.isAbsolute(f) ? f : path.join(root, f);
  try { a = fs.realpathSync(a); } catch { try { a = path.join(fs.realpathSync(path.dirname(a)), path.basename(a)); } catch {} }
  const r = path.relative(root, a);
  return r.startsWith("..") || path.isAbsolute(r) ? null : r;
}

async function gitStatus(root) {
  const r = await git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]);
  if (r.code) return { error: r.err };
  const parts = r.out.split("\0");
  const out = { root, branch: "", upstream: "", ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]; if (!s) continue;
    if (s.startsWith("## ")) {
      const m = s.slice(3).match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (m) {
        out.branch = m[1].replace(/^No commits yet on /, "");
        out.upstream = m[2] || "";
        const a = (m[3] || "").match(/ahead (\d+)/), b = (m[3] || "").match(/behind (\d+)/);
        out.ahead = a ? +a[1] : 0; out.behind = b ? +b[1] : 0;
      }
      continue;
    }
    const x = s[0], y = s[1], file = s.slice(3);
    const f = { path: file, x, y };
    if (x === "R" || x === "C") f.orig = parts[++i];
    f.kind = x === "?" ? "new" : (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) ? "conflict"
      : (x === "D" || y === "D") ? "deleted" : (x === "A") ? "added" : (x === "R") ? "renamed" : "modified";
    f.staged = x !== " " && x !== "?";
    out.files.push(f);
    if (out.files.length >= 1000) { out.truncated = true; break; }
  }
  // 每个文件的增删行数（工作区对 HEAD；新文件按行数算）
  const ns = await git(root, ["diff", "HEAD", "--numstat", "-z"]);
  if (!ns.code) {
    const map = new Map();
    for (const rec of ns.out.split("\0")) { const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.+)$/); if (m) map.set(m[3], [m[1], m[2]]); }
    for (const f of out.files) { const n = map.get(f.path); if (n) { f.add = n[0] === "-" ? null : +n[0]; f.del = n[1] === "-" ? null : +n[1]; } }
  }
  for (const f of out.files) if (f.kind === "new" && f.add == null) {
    try { const st = fs.statSync(path.join(root, f.path)); if (st.size < 2 << 20) { const t = fs.readFileSync(path.join(root, f.path)); f.add = t.includes(0) ? null : (t.length ? t.toString("utf8").split("\n").length - (t[t.length - 1] === 10 ? 1 : 0) : 0); f.del = 0; f.binary = t.includes(0); } } catch {}
  }
  return out;
}

async function handleGit(req, res, p, u) {
  const q = (k) => u.searchParams.get(k) || "";
  const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
  const act = p.slice("/api/git/".length);
  const repo = await gitRepo(req.method === "POST" ? body.dir : q("dir"));
  // 还不是仓库：只允许「建一个」（私有目录除外）
  if (repo.notRepo && act === "init" && req.method === "POST") {
    if (gitPrivate(repo.dir)) return sendJson(res, 403, { error: "forbidden" });
    const r = await git(repo.dir, ["init"]);
    log(`[git] 新建仓库 ${repo.dir}`);
    return sendJson(res, r.code ? 500 : 200, r.code ? { error: r.err } : { ok: true, root: repo.dir });
  }
  if (repo.error) return sendJson(res, repo.status || (repo.notRepo ? 200 : 400), { error: repo.error, notRepo: !!repo.notRepo, dir: repo.dir });
  const root = repo.root;

  if (act === "status") return sendJson(res, 200, await gitStatus(root));

  if (act === "diff") {
    // file 为空 = 整个工作区；commit 有值 = 那次提交里的改动
    const commit = q("commit"), file = q("file") ? gitRel(root, q("file")) : "";
    if (q("file") && file == null) return sendJson(res, 400, { error: "outside repo" });
    let r;
    if (commit) {
      if (!/^[0-9a-f]{4,40}$/i.test(commit)) return sendJson(res, 400, { error: "bad commit" });
      r = await git(root, ["show", "--format=", "--patch", "-M", commit, ...(file ? ["--", file] : [])]);
    } else {
      const st = file ? await git(root, ["status", "--porcelain=v1", "-z", "--", file]) : null;
      if (st && st.out.startsWith("??")) r = await git(root, ["diff", "--no-index", "--", "/dev/null", file]);
      else {
        const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
        r = await git(root, ["diff", ...(head.code ? ["--cached"] : ["HEAD"]), "-M", ...(file ? ["--", file] : [])]);
      }
      if (r.code === 1 && r.out) r.code = 0;            // --no-index 有差异时退出码是 1
    }
    if (r.code) return sendJson(res, 500, { error: r.err });
    return sendJson(res, 200, { root, file, commit, diff: r.out.slice(0, GIT_MAX), truncated: r.out.length > GIT_MAX });
  }

  if (act === "log") {
    const n = Math.min(200, Math.max(1, +q("n") || 50)), skip = Math.max(0, +q("skip") || 0);
    const file = q("file") ? gitRel(root, q("file")) : "";
    const r = await git(root, ["log", `-n${n}`, `--skip=${skip}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1e", ...(file ? ["--follow", "--", file] : [])]);
    if (r.code) return sendJson(res, 200, { root, commits: [], error: /does not have any commits/.test(r.err) ? "" : r.err });
    const commits = r.out.split("\x1e").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [hash, short, author, at, subject, refs] = s.split("\x1f");
      return { hash, short, author, at: +at * 1000, subject, refs: refs || "" };
    });
    return sendJson(res, 200, { root, commits, more: commits.length === n });
  }

  if (act === "show") {
    const c = q("commit");
    if (!/^[0-9a-f]{4,40}$/i.test(c)) return sendJson(res, 400, { error: "bad commit" });
    const meta = await git(root, ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B", c]);
    if (meta.code) return sendJson(res, 404, { error: meta.err });
    const [hash, author, email, at, message] = meta.out.split("\x1f");
    const ns = await git(root, ["show", "--format=", "--numstat", "-M", "-z", c]);
    const nm = await git(root, ["show", "--format=", "--name-status", "-M", "-z", c]);
    const files = [];
    const a = nm.out.split("\0").filter((x) => x !== "");
    for (let i = 0; i < a.length; i++) {
      const s = a[i][0];
      const f = { status: s, path: a[++i] };
      if (s === "R" || s === "C") { f.orig = f.path; f.path = a[++i]; }
      files.push(f);
    }
    const nums = ns.out.split("\0");
    for (const rec of nums) { const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/); if (!m) continue; const f = files.find((x) => x.path === m[3]) || files.find((x) => !("add" in x)); if (f) { f.add = m[1] === "-" ? null : +m[1]; f.del = m[2] === "-" ? null : +m[2]; } }
    return sendJson(res, 200, { root, hash, author, email, at: +at * 1000, message: (message || "").trim(), files });
  }

  if (act === "branches") {
    const r = await git(root, ["for-each-ref", "--sort=-committerdate",
      "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(HEAD)%1f%(contents:subject)", "refs/heads", "refs/remotes"]);
    if (r.code) return sendJson(res, 500, { error: r.err });
    const local = [], remote = [];
    for (const l of r.out.split("\n")) {
      if (!l) continue;
      const [ref, name, upstream, track, hash, at, head, subject] = l.split("\x1f");
      const b = { name, upstream, hash, at: +at * 1000, subject: (subject || "").slice(0, 120) };
      if (ref.startsWith("refs/heads/")) {
        const a = (track || "").match(/ahead (\d+)/), be = (track || "").match(/behind (\d+)/);
        local.push({ ...b, current: head === "*", ahead: a ? +a[1] : 0, behind: be ? +be[1] : 0, gone: /gone/.test(track || "") });
      } else if (!ref.endsWith("/HEAD")) remote.push(b);
    }
    // 远端分支里已经有本地对应的就不重复列
    const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
    const rem = await git(root, ["remote"]);
    return sendJson(res, 200, { root, local, remote: remote.filter((b) => !tracked.has(b.name)), remotes: rem.out.split("\n").filter(Boolean) });
  }

  if (req.method !== "POST") return sendJson(res, 404, { error: "unknown" });

  if (act === "fetch" || act === "pull" || act === "push") {
    const st = await gitStatus(root);
    if (st.error) return sendJson(res, 500, { error: st.error });
    let args;
    if (act === "fetch") args = ["fetch", "--prune", "--all"];
    else if (act === "pull") {
      if (!st.upstream) return sendJson(res, 409, { error: "no_upstream", message: tz("当前分支没有对应的远端分支，先推送一次建立关联。") });
      if (st.files.some((f) => f.kind === "conflict")) return sendJson(res, 409, { error: "conflict", message: tz("还有没解决的冲突，先处理完再拉取。") });
      args = ["pull", "--ff-only"];      // 只快进：分叉了就停下说清楚，不替用户做合并
    } else {
      if (!st.branch || /^HEAD|no branch/i.test(st.branch)) return sendJson(res, 409, { error: "detached", message: tz("现在不在任何分支上，先切到一个分支再推送。") });
      if (st.upstream) args = ["push"];
      else {
        const rem = (await git(root, ["remote"])).out.split("\n").filter(Boolean);
        if (!rem.length) return sendJson(res, 409, { error: "no_remote", message: tz("这个仓库还没有设置远端（remote）。") });
        const to = rem.includes("origin") ? "origin" : rem[0];
        args = ["push", "-u", to, st.branch];       // 第一次推：顺便建立关联，以后直接推/拉
      }
    }
    const t0 = Date.now();
    const r = await gitNet(root, args);
    log(`[git] ${act} ${r.code ? "失败" : "完成"}（${Date.now() - t0}ms）@ ${root}`);
    if (r.code) {
      const human = gitNetHuman(r.err + "\n" + r.out);
      const code = /Not possible to fast-forward|diverg/i.test(r.err) ? "diverged" : /\[rejected\]|non-fast-forward|fetch first/i.test(r.err) ? "rejected" : "";
      return sendJson(res, 500, { error: human || r.err.split("\n").slice(-3).join("\n") || tz("失败"), code, detail: (r.err || r.out).slice(-2000) });
    }
    const after = await gitStatus(root);
    const msg = act === "fetch" ? (after.behind ? tz("已抓取：远端有 {n} 个新提交", { n: after.behind }) : tz("已抓取：没有新提交"))
      : act === "pull" ? (/Already up to date/i.test(r.out) ? tz("已经是最新的") : tz("已拉取"))
      : (/Everything up-to-date/i.test(r.err) ? tz("没有要推送的提交") : tz("已推送"));
    return sendJson(res, 200, { ok: true, message: msg, ahead: after.ahead, behind: after.behind, upstream: after.upstream });
  }

  if (act === "switch") {
    const name = String(body.branch || "").trim();
    // 分支名照 git check-ref-format 的规矩挡一遍，免得把奇怪参数传进命令行
    if (!name || name.startsWith("-") || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\.lock$|\/$|\.$/.test(name)) return sendJson(res, 400, { error: tz("分支名不合法") });
    const create = !!body.create;
    const st = await gitStatus(root);
    if (st.files.some((f) => f.kind === "conflict")) return sendJson(res, 409, { error: tz("还有没解决的冲突，先处理完再切换。") });
    let r;
    if (create) r = await git(root, ["switch", "-c", name]);
    else {
      // 只在远端有：git switch 会自动建一个跟踪它的本地分支（origin/foo → foo）
      const local = await git(root, ["rev-parse", "--verify", "-q", "refs/heads/" + name]);
      const m = name.match(/^([^/]+)\/(.+)$/);
      if (local.code && m) {
        const isRemote = await git(root, ["rev-parse", "--verify", "-q", "refs/remotes/" + name]);
        r = isRemote.code ? await git(root, ["switch", name]) : await git(root, ["switch", "--track", name]);
      } else r = await git(root, ["switch", name]);
    }
    if (r.code) return sendJson(res, 409, { error: gitNetHuman(r.err) || r.err.split("\n").slice(0, 4).join("\n") });
    const cur = await git(root, ["branch", "--show-current"]);
    log(`[git] ${create ? "新建并切到" : "切到"} ${cur.out.trim()} @ ${root}`);
    // 没提交的改动会跟着带过去（git 允许时）——告诉用户一声
    const carried = st.files.length;
    return sendJson(res, 200, { ok: true, branch: cur.out.trim(), message: carried ? tz("已切到 {b}（{n} 个没提交的改动一起带过来了）", { b: cur.out.trim(), n: carried }) : tz("已切到 {b}", { b: cur.out.trim() }) });
  }

  if (act === "commit") {
    const msg = String(body.message || "").trim();
    if (!msg) return sendJson(res, 400, { error: tz("写一句提交说明") });
    const files = Array.isArray(body.files) ? body.files.map((f) => gitRel(root, String(f))).filter((f) => f != null) : null;
    const who = await git(root, ["config", "user.email"]);
    if (!who.out.trim()) return sendJson(res, 409, { error: "no_identity", message: tz("还没设置 git 的名字和邮箱（提交记录里署名用）。") });
    const add = files && files.length ? await git(root, ["add", "-A", "--", ...files]) : await git(root, ["add", "-A"]);
    if (add.code) return sendJson(res, 500, { error: add.err });
    const r = await git(root, ["commit", "-F", "-", ...(files && files.length ? ["--", ...files] : [])], { input: msg + "\n" });
    if (r.code) return sendJson(res, 500, { error: r.err || r.out.trim() });
    const h = await git(root, ["rev-parse", "--short", "HEAD"]);
    log(`[git] 提交 ${h.out.trim()} @ ${root}`);
    return sendJson(res, 200, { ok: true, hash: h.out.trim(), message: tz("已提交 {hash}", { hash: h.out.trim() }) });
  }

  if (act === "identity") {
    const name = String(body.name || "").trim(), email = String(body.email || "").trim();
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(email)) return sendJson(res, 400, { error: tz("名字和邮箱都要填") });
    await git(root, ["config", "--global", "user.name", name]);
    await git(root, ["config", "--global", "user.email", email]);
    return sendJson(res, 200, { ok: true });
  }

  if (act === "discard") {
    // 撤销一个文件的改动：改回上次提交时的样子；新文件（没被 git 记录过的）直接删掉
    const file = gitRel(root, String(body.file || ""));
    if (!file) return sendJson(res, 400, { error: "file required" });
    const st = await git(root, ["status", "--porcelain=v1", "-z", "--", file]);
    if (!st.out) return sendJson(res, 200, { ok: true, message: tz("没有改动") });
    if (st.out.startsWith("??")) {
      try { fs.rmSync(path.join(root, file), { force: true }); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    } else {
      const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
      const r = head.code ? await git(root, ["rm", "--cached", "-f", "-q", "--", file]) : await git(root, ["checkout", "HEAD", "--", file]);
      if (r.code) return sendJson(res, 500, { error: r.err });
    }
    log(`[git] 撤销 ${file} @ ${root}`);
    return sendJson(res, 200, { ok: true, message: tz("已撤销") });
  }

  return sendJson(res, 404, { error: "unknown" });
}

function termEnv() {
  const env = claudeEnv();
  for (const k of ["CI", "NO_COLOR", "CLAUDE_CODE_SHELL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CCAPP_RUN"]) delete env[k];   // 终端里用户自己起的东西不算 claude 运行，网关重启时别当孤儿清
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // C.UTF-8 是 glibc 内建的（开发端的 bash 是 glibc 版，没带 locale 数据）；不设的话 readline 把中文显示成 \344\270…
  if (!/utf-?8/i.test(env.LC_ALL || env.LANG || "")) env.LANG = "C.UTF-8";
  // …而它在哪儿找 locale 是编译期写死的：开发端的 locale 数据在工具链的 glibc 目录里，得用 LOCPATH 指过去
  const loc = path.join(PATHS.toolchain, "dshtc", "prefix", "glibc", "lib", "locale");
  if (!PREFIX && !env.LOCPATH && fs.existsSync(loc)) env.LOCPATH = loc;
  env.CCAPP_TERMINAL = "1";
  return env;
}

function termInfo(t) {
  return { id: t.id, title: t.title, cols: t.cols, rows: t.rows, created: t.created, alive: t.alive, code: t.code };
}

function termNew({ cols, rows, login } = {}) {
  for (const [id, t] of TERMS) if (!t.alive) TERMS.delete(id);   // 已退出的不占名额
  if (TERMS.size >= TERM_MAX) return { error: `too many terminals (${TERM_MAX})` };
  const pc = ptyCommand();
  if (!pc) return { error: "no pty helper (ptyhost / python3)" };
  cols = Math.max(20, Math.min(500, cols | 0 || 80));
  rows = Math.max(5, Math.min(300, rows | 0 || 24));
  const shell = ensureShell();
  let cwd = CFG.workspace;
  try { if (!fs.statSync(cwd).isDirectory()) cwd = CFG.home; } catch { cwd = CFG.home; }
  // login：给手动登录用的终端。环境和账户登录一样清掉第三方厂商的地址 / 密钥 / 模型，
  // 开好后替用户敲下 claude auth login —— 授权码由用户贴给 claude 自己的提示，网关只当字节通道
  const env = termEnv();
  if (login) for (const k of Object.keys(env)) if (/^ANTHROPIC_/.test(k)) delete env[k];
  const child = spawn(pc[0], [...pc.slice(1), String(rows), String(cols), shell], {
    cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  if (login) setTimeout(() => { try { child.stdin.write("claude auth login" + (login === "console" ? " --console" : "") + "\r"); } catch {} }, 400);
  const id = (++termSeq).toString(36) + Math.random().toString(36).slice(2, 6);
  const t = {
    id, title: `${path.basename(shell) === "bash" ? "bash" : "sh"} ${termSeq}`, cols, rows,
    created: Date.now(), alive: true, code: null, child,
    buf: "", subs: new Set(), dec: new StringDecoder("utf8"),
  };
  const out = (s) => {
    if (!s) return;
    t.buf += s;
    if (t.buf.length > TERM_RING) t.buf = t.buf.slice(t.buf.length - TERM_RING);
    for (const r of t.subs) sseSend(r, "o", s);
  };
  child.stdout.on("data", (d) => out(t.dec.write(d)));
  child.stderr.on("data", (d) => out(d.toString()));     // 只有 ptyhost 自己的报错走这里
  child.stdin.on("error", () => {});
  child.stdio[3]?.on("error", () => {});
  child.on("error", (e) => out(`\r\n[${e.message}]\r\n`));
  child.on("exit", (code, sig) => {
    out(t.dec.end());
    t.alive = false;
    t.code = code ?? (sig ? 128 : null);
    for (const r of t.subs) { sseSend(r, "exit", { code: t.code }); try { r.end(); } catch {} }
    t.subs.clear();
  });
  TERMS.set(id, t);
  log(`[term] ${id} 打开 ${cols}x${rows} via ${path.basename(pc[0])}`);
  return { ok: true, term: termInfo(t) };
}

function sseSend(res, ev, data) {
  try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

function termKill(t) {
  if (!t) return;
  if (t.alive) { try { t.child.stdin.end(); } catch {} setTimeout(() => { if (t.alive) killTree(t.child); }, 1500); }
  TERMS.delete(t.id);
  for (const r of t.subs) { try { r.end(); } catch {} }
  t.subs.clear();
}

async function handleTerm(req, res, p) {
  if (req.method === "GET" && p === "/api/term/list") {
    return sendJson(res, 200, { terms: [...TERMS.values()].map(termInfo), available: !!ptyCommand() });
  }
  if (req.method === "POST" && p === "/api/term/new") {
    let b = {};
    try { b = JSON.parse(await readBody(req) || "{}"); } catch {}
    const r = termNew(b);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  const m = p.match(/^\/api\/term\/([0-9a-z]+)\/(stream|in|resize|kill|rename)$/);
  if (!m) return sendJson(res, 404, { error: "not found" });
  const t = TERMS.get(m[1]);
  if (!t) return sendJson(res, 404, { error: "no such terminal" });
  const op = m[2];
  if (req.method === "GET" && op === "stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay?.(true);
    sseSend(res, "replay", t.buf);
    if (!t.alive) { sseSend(res, "exit", { code: t.code }); return res.end(); }
    t.subs.add(res);
    const ka = setInterval(() => { try { res.write(": k\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(ka); t.subs.delete(res); });
    return;
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  const body = await readBody(req);
  if (op === "in") {
    if (t.alive) try { t.child.stdin.write(body); } catch {}
    return sendJson(res, 200, { ok: true });
  }
  let b = {};
  try { b = JSON.parse(body || "{}"); } catch {}
  if (op === "resize") {
    t.cols = Math.max(20, Math.min(500, b.cols | 0 || t.cols));
    t.rows = Math.max(5, Math.min(300, b.rows | 0 || t.rows));
    if (t.alive) try { t.child.stdio[3].write(`${t.rows} ${t.cols}\n`); } catch {}
    return sendJson(res, 200, { ok: true });
  }
  if (op === "rename") {
    t.title = String(b.title || "").slice(0, 40) || t.title;
    return sendJson(res, 200, { ok: true });
  }
  if (op === "kill") { termKill(t); return sendJson(res, 200, { ok: true }); }
}

/** 前端文件（web/ 下全部，含 i18n.js 与各语言词典）的最后修改时间戳。界面拿它来判断「我是不是该刷新了」——
 *  这样以后只改 web/ 也能自动生效，不用重开 App。 */
// ── 可选组件（v0.1.9 起：浏览器组件 = 无头 Chromium）───────────────────
// 照 livehime 浏览器组件的路子：
//   · 组件有自己的版本，跟工具包（devkit）走，不跟 App 走。索引里每个构建声明它要求的工具包（gz 的 sha256），
//     对不上就不装、已装的显示"需要重新安装"。
//   · 两阶段：先下载 → 核 sha256 → 解到暂存区 → 按 MANIFEST 逐文件核对；全部通过才把文件换进 $PREFIX。
//     中途任何一步失败，$PREFIX 一根毫毛不动。
//   · 已装记录在 files/components/<id>.json（$PREFIX 之外：工具包整体替换时不会把记录一起换掉）；
//     记录里列着装进去的每个文件，卸载就按它删，不会误删工具包自己的东西。
//   · 状态：absent / downloading / verifying / installing / ok / outdated（工具包变了）/ damaged / error
// 只在 cccodroid（有 Termux 前缀）上可用；开发端没有 $PREFIX，接口返回 supported:false。
const COMP_INDEX = process.env.CCAPP_COMPONENTS_INDEX ||
  "https://github.com/greyoak111/cccodroid/releases/download/components/components.json";
// 社区组件（v0.2.0 起）：greyoak111/cccodroid-components 仓库，CI 按配方打包、出签名索引
const COMP_COMMUNITY_INDEX = process.env.CCAPP_COMPONENTS_COMMUNITY_INDEX ||
  "https://github.com/greyoak111/cccodroid-components/releases/download/index/components.json";
// 索引签名公钥（ed25519）：每份索引旁边都有 <索引>.sig（对原始字节的签名，base64），验不过整份不用。
// 索引里有每个包的 sha256，所以验了索引就等于验了包。私钥只在发布机和组件仓库的 CI 密钥里。
const COMP_INDEX_PUBKEY = crypto.createPublicKey(
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=\n-----END PUBLIC KEY-----\n");
const COMP_DIR = PREFIX ? path.join(path.dirname(PREFIX), "components") : "";
const COMP_JOBS = new Map();      // id → { phase, done, total, error, child, cancelled }
let compIndexCache = { at: 0, data: null, error: "" };

function devkitIdentity() {
  try { return JSON.parse(fs.readFileSync(path.join(PREFIX, ".devkit-ok"), "utf8")); } catch { return null; }
}
const compRecFile = (id) => path.join(COMP_DIR, id + ".json");
function compRecord(id) { try { return JSON.parse(fs.readFileSync(compRecFile(id), "utf8")); } catch { return null; } }
function compWriteRecord(id, rec) {
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.writeFileSync(compRecFile(id) + ".tmp", JSON.stringify(rec, null, 1));
  fs.renameSync(compRecFile(id) + ".tmp", compRecFile(id));
}

function compFetch(src) {
  return new Promise((resolve, reject) => {
    execFile(path.join(PREFIX, "bin", "curl"), ["-fsSL", "--max-time", "30", "--retry", "2", src],
      { env: claudeEnv(), maxBuffer: 4 << 20, encoding: "buffer" },
      (e, so, se) => (e ? reject(new Error(String(se || e.message).trim().slice(0, 200))) : resolve(so)));
  });
}
// 备用源：cccodroid.net 镜像了两份索引（连同 .sig，逐字节同 GitHub）。主地址拉不到才用；照样验签，镜像不需要被信任
const COMP_INDEX_MIRROR = { preset: "https://cccodroid.net/components/official/components.json",
  community: "https://cccodroid.net/components/community/components.json" };
/** 取一份索引并验签。unsigned 只在私有目录里有 allow-unsigned 开关文件时才放行（/sdcard 别的应用也能写） */
async function compFetchIndex(src, mirror) {
  let body;
  try { body = await compFetch(src); }
  catch (e) {
    if (!mirror) throw e;
    try { body = await compFetch(mirror); src = mirror; } catch { throw e; }
    log(`组件索引改用镜像：${mirror}`);
  }
  let sig = null;
  try { sig = Buffer.from(String(await compFetch(src + ".sig")).trim(), "base64"); } catch {}
  const ok = sig && sig.length === 64 && crypto.verify(null, body, COMP_INDEX_PUBKEY, sig);
  if (!ok && !fs.existsSync(path.join(COMP_DIR, "allow-unsigned"))) throw new Error(sig ? tz("索引签名不对，已拒绝") : tz("索引没有签名，已拒绝"));
  return { ...JSON.parse(String(body)), signed: !!ok };
}

/** 两个来源合并：预置（cccodroid 仓库）在前，社区（cccodroid-components）在后；id 撞了以预置为准。
 *  共享目录里放了 components/components.json 就代替预置来源（离线 / 测试），同样要签名。 */
async function compIndex(force) {
  // force：true = 必拉；数字 = 缓存超过这么多毫秒才拉（打开扩展页用，刚合并的验证记录不用等 10 分钟）
  const maxAge = typeof force === "number" ? force : force ? -1 : 10 * 60e3;
  if (compIndexCache.data && Date.now() - compIndexCache.at < maxAge) return compIndexCache;
  const local = process.env.CCAPP_SHARED && path.join(process.env.CCAPP_SHARED, "components", "components.json");
  const sources = [
    { source: "preset", url: local && fs.existsSync(local) ? "file://" + local : COMP_INDEX },
    { source: "community", url: COMP_COMMUNITY_INDEX },
  ];
  const got = await Promise.all(sources.map((s) => compFetchIndex(s.url, s.url.startsWith("file://") ? null : COMP_INDEX_MIRROR[s.source]).then((d) => ({ ...s, d }), (e) => ({ ...s, e }))));
  const components = {}, errors = [];
  for (const g of got) {
    if (g.e) { errors.push(`${g.source}: ${g.e.message}`); continue; }
    for (const [id, e] of Object.entries(g.d.components || {})) if (!components[id]) components[id] = { ...e, source: g.source, signed: g.d.signed };
  }
  // 某个来源这次没取到：沿用上次那个来源的条目，免得已装组件的状态跳成"不在索引里"
  const prev = (compIndexCache.data && compIndexCache.data.components) || {};
  for (const g of got) if (g.e) for (const [id, e] of Object.entries(prev)) if (e.source === g.source && !components[id]) components[id] = e;
  const anyOk = got.some((g) => !g.e);
  compIndexCache = anyOk || !compIndexCache.data
    ? { at: errors.length ? Date.now() - 9 * 60e3 : Date.now(), data: { components }, error: errors.join("；") }   // 有失败的一分钟后再试
    : { at: Date.now() - 9 * 60e3, data: compIndexCache.data, error: errors.join("；") };
  return compIndexCache;
}

/** 给当前工具包挑一个构建：base 等于已装工具包 gz 的 sha256 */
function compBuildFor(entry, dk) {
  const sha = dk && dk.sha256;
  return (entry.builds || []).find((b) => sha && b.base === sha) || null;
}

function compState(id, entry, dk) {
  const job = COMP_JOBS.get(id);
  if (job && !job.finished) return job.phase;
  const rec = compRecord(id);
  if (!rec) return job && job.error ? "error" : "absent";
  if (rec.state !== "ok") return "damaged";
  if (!dk || rec.base !== dk.sha256) return "outdated";          // 工具包换过：组件的文件已随旧工具包一起没了
  for (const b of rec.bin || []) if (!fs.existsSync(path.join(PREFIX, "bin", b))) return "damaged";
  const build = entry && compBuildFor(entry, dk);
  if (build && build.sha256 !== rec.sha256) return "update";
  return "ok";
}

// 只限骁龙的组件（needs.gpu 写 "adreno"）：Turnip 走 /dev/kgsl-3d0，别家 SoC 上没有这个节点，装了也用不了
const compUnsupported = (e) => (e && e.needs && e.needs.gpu === "adreno" && !fs.existsSync("/dev/kgsl-3d0") ? "adreno" : "");
// 依赖的组件装好了没有（有新版本可更新也算装好）
const compDepOk = (rid, comps, dk) => ["ok", "update"].includes(compState(rid, comps[rid] || null, dk));
const compName = (rid, comps) => (comps[rid] && comps[rid].name) || { zh: rid, en: rid };
/** 已装的组件里，requires 了 id 的那些（卸载 id 会把它们弄坏） */
function compUsers(id) {
  const out = [];
  try {
    for (const f of fs.readdirSync(COMP_DIR)) {
      if (!f.endsWith(".json") || f === id + ".json") continue;
      const r = compRecord(f.slice(0, -5));
      if (r && (r.requires || []).includes(id)) out.push(f.slice(0, -5));
    }
  } catch {}
  return out;
}

async function compList(force) {
  if (!PREFIX) return { supported: false };
  const dk = devkitIdentity();
  compHealSkills();
  const ix = await compIndex(force);
  const comps = (ix.data && ix.data.components) || {};
  const ids = new Set([...Object.keys(comps)]);
  try { for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) ids.add(f.slice(0, -5)); } catch {}
  const items = [...ids].map((id) => {
    const e = comps[id] || null, b = e && compBuildFor(e, dk), rec = compRecord(id), job = COMP_JOBS.get(id);
    return {
      id, name: e ? e.name : { zh: id, en: id }, desc: e ? e.desc : null,
      version: b ? b.version : null, bytes: b ? b.bytes : 0, installed: b ? b.installed : 0,
      available: !!b, installedVersion: rec ? rec.version : null,
      state: compState(id, e, dk),
      progress: job && !job.finished ? { phase: job.phase, done: job.done, total: job.total } : null,
      error: job && job.error ? tr(LAST_LANG, job.error) : "",
      bin: (b && b.bin) || (rec && rec.bin) || [],
      selftest: (b && b.selftest) || "",
      // 来源与可信度：预置组件由 cccodroid 发布、随版本测过；社区组件看 verified（真机验证记录）
      source: e ? e.source : (rec && rec.source) || "", signed: e ? !!e.signed : true,
      verified: e ? e.source === "preset" || !!(b && b.verified) : true,
      license: (e && e.license) || "", homepage: (e && e.homepage) || "", needs: (e && e.needs) || {},
      category: (e && e.category) || "",          // 扩展页分类索引条用（配方的 category）
      // 依赖：requires 了哪些组件、各自装好没有；谁在依赖它（卸载前要先卸那些）；本机能不能用
      requires: ((e && e.requires) || (rec && rec.requires) || []).map((rid) => ({ id: rid, name: compName(rid, comps), ok: compDepOk(rid, comps, dk) })),
      usedBy: rec ? compUsers(id).map((rid) => ({ id: rid, name: compName(rid, comps) })) : [],
      unsupported: compUnsupported(e),
    };
  });
  return { supported: true, devkit: dk ? (dk.sha256 || "").slice(0, 12) : null, indexError: ix.error, items };
}

function sha256File(f, job) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256"), s = fs.createReadStream(f, { highWaterMark: 1 << 20 });
    s.on("data", (c) => { h.update(c); if (job) job.done += c.length; });
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

function compRun(job, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: termEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
    job.child = child;
    let err = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", reject);
    child.on("exit", (code) => { job.child = null; job.cancelled ? reject(new Error("cancelled")) : code === 0 ? resolve() : reject(new Error(tz("{cmd} 退出码 {code}：{err}", { cmd: path.basename(cmd), code, err: `${err.trim().split("\n").filter((l) => l.trim() && !/Exiting with failure status|Error is not recoverable/.test(l)).slice(-3).join(" · ") || err.trim().split("\n").pop() || ""}` }))); });
  });
}

/** 把暂存区里的 usr/ 树逐个搬进 $PREFIX；返回搬进去的相对路径（文件与软链） */
function compMoveIn(stageUsr, rel = "", moved = [], skipped = []) {
  for (const d of fs.readdirSync(path.join(stageUsr, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + d.name : d.name;
    const src = path.join(stageUsr, r), dst = path.join(PREFIX, r);
    if (d.isDirectory()) {
      let st = null; try { st = fs.lstatSync(dst); } catch {}
      if (st && !st.isDirectory()) { skipped.push(r); continue; }
      if (!st) fs.mkdirSync(dst, { recursive: true });
      compMoveIn(stageUsr, r, moved, skipped);
      continue;
    }
    // 工具包已有的同名文件不覆盖（组件只带底座里没有的包，撞名多半是共用的目录索引之类）
    let exists = false; try { fs.lstatSync(dst); exists = true; } catch {}
    if (exists) { skipped.push(r); continue; }
    fs.renameSync(src, dst);
    moved.push(r);
  }
  return { moved, skipped };
}

const PKG_LIST = /^var\/lib\/dpkg\/info\/(.+)\.list$/;
/** 磁盘上某个包现在的文件清单（devkit 给每个包写的 var/lib/dpkg/info/<包>.list，绝对路径 → 相对 $PREFIX） */
function compPkgFiles(pkg) {
  const out = [];
  try {
    for (const l of fs.readFileSync(path.join(PREFIX, "var/lib/dpkg/info", pkg + ".list"), "utf8").split("\n")) {
      const i = l.indexOf("/files/usr/");
      if (i >= 0 && l.length > i + 11) out.push(l.slice(i + 11));
    }
  } catch {}
  return out;
}

/** 已装组件要用的全部文件：
 *  · 自己放进去的（files）+ 装的时候已经在、没放的（shared）；0.1.10 及以前的记录没有 shared，拿包内 MANIFEST 补；
 *  · 再加上它带的每个包「磁盘上现在那一版」的整份文件清单。两个组件带了同一个包、版本却不同时
 *    （浏览器带 mesa 26.2.4、GPU 驱动带 26.2.5），后装的跳过了同名文件、用的是先装那版 —— 而那版还有
 *    文件名带版本号的库（libgallium-26.2.4.so），光按路径比对会把它删掉，留下的同名文件就找不到它了 */
function compNeeds(id, rec) {
  const s = new Set([...(rec.files || []), ...(rec.shared || [])]);
  if (!rec.shared) {
    try {
      for (const line of fs.readFileSync(path.join(PREFIX, "libexec/devkit/components", id, "MANIFEST"), "utf8").split("\n")) {
        const rel = line.split(" ").slice(2).join(" ");
        if (rel) s.add(rel);
      }
    } catch {}
  }
  for (const r of [...s]) { const m = PKG_LIST.exec(r); if (m) for (const f of compPkgFiles(m[1])) s.add(f); }
  return s;
}

/** 删掉一个组件放进去的文件。两个组件带了同一个依赖包（浏览器和 GPU 驱动都带 mesa）时，
 *  后装的那个跳过了已存在的文件、记录里没有它们 —— 所以删之前先看别的组件要不要用：要用的留下、记到它名下，
 *  不然卸一个，另一个就悄悄坏了 */
function compRemoveFiles(id, rec) {
  const others = [];
  try {
    for (const f of fs.readdirSync(COMP_DIR)) {
      if (!f.endsWith(".json") || f === id + ".json") continue;
      const oid = f.slice(0, -5), orec = compRecord(oid);
      if (orec) others.push({ id: oid, rec: orec, needs: compNeeds(oid, orec), gained: [] });
    }
  } catch {}
  const dirs = new Set();
  // Python 运行时在旁边的 __pycache__ 里生成 .pyc（不在组件清单里）：删 .py 时一并删掉，不然卸载后留下几十 MB
  const pyc = new Map();
  const pycOf = (d) => { if (!pyc.has(d)) { let l = []; try { l = fs.readdirSync(path.join(PREFIX, d)); } catch {} pyc.set(d, l); } return pyc.get(d); };
  for (const r of rec.files || []) {
    const keeper = others.find((o) => o.needs.has(r));
    if (keeper) { keeper.gained.push(r); continue; }
    try { fs.unlinkSync(path.join(PREFIX, r)); } catch {}
    for (let d = path.dirname(r); d && d !== "."; d = path.dirname(d)) dirs.add(d);
    if (r.endsWith(".py")) {
      const pc = path.join(path.dirname(r), "__pycache__"), stem = path.basename(r, ".py") + ".";
      for (const f of pycOf(pc)) if (f.startsWith(stem) && f.endsWith(".pyc")) try { fs.unlinkSync(path.join(PREFIX, pc, f)); } catch {}
      dirs.add(pc);
    }
  }
  for (const o of others) {
    if (!o.gained.length) continue;
    o.rec.files = [...new Set([...(o.rec.files || []), ...o.gained])];
    compWriteRecord(o.id, o.rec);
    log(`[comp] ${id}：${o.gained.length} 个文件 ${o.id} 也要用，留下归它`);
  }
  // 由深到浅删掉变空的目录（工具包自己的目录不空，自然删不掉）
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(PREFIX, d)); } catch {} }
  if (rec.skill) fs.rmSync(path.join(SKILLS_DIR, rec.skill), { recursive: true, force: true });
}

async function compInstall(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const cur = COMP_JOBS.get(id);
  if (cur && !cur.finished) return { ok: false, message: "busy" };
  const dk = devkitIdentity();
  if (!dk || !dk.sha256) return { ok: false, message: tz("工具包还没装好（或是本地文件装的，没有版本身份），装不了组件") };
  const ix = await compIndex(true);
  const entry = ix.data && ix.data.components && ix.data.components[id];
  if (!entry) return { ok: false, message: ix.error || tz("没有这个组件") };
  if (compUnsupported(entry)) return { ok: false, message: tz("这个组件只能用在高通骁龙（Adreno GPU）的设备上，本机用不了") };
  const miss = (entry.requires || []).filter((rid) => !compDepOk(rid, ix.data.components, dk));
  if (miss.length) return { ok: false, message: tz("要先装：{names}", { names: miss.map((rid) => compName(rid, ix.data.components).zh || rid).join("、") }) };
  const b0 = compBuildFor(entry, dk), b = b0 && { ...b0, source: entry.source, requires: entry.requires || [] };
  if (!b) return { ok: false, message: tz("这个组件还没有对应当前工具包的版本，先更新工具包或稍后再试") };
  // 空间：压缩包 + 解开后的大小，再留 10%
  try {
    const sf = fs.statfsSync(path.dirname(PREFIX));
    const need = (b.bytes + b.installed) * 1.1;
    if (sf.bavail * sf.bsize < need) return { ok: false, message: tz("存储空间不够：需要约 {n} MB", { n: Math.ceil(need / 1048576) }) };
  } catch {}
  const job = { phase: "downloading", done: 0, total: b.bytes, error: "", child: null, cancelled: false, finished: false };
  COMP_JOBS.set(id, job);
  compRunInstall(id, b, job).then(
    () => { job.finished = true; log(`[comp] ${id} ${b.version} 装好了`); },
    (e) => { job.finished = true; job.error = job.cancelled ? "" : e.message; log(`[comp] ${id} 安装失败：${e.message}`); });
  return { ok: true };
}

/** 把组件带的 skill 目录拷进 ~/.claude/skills。skill 路径相对 files/（以 usr/ 开头），PREFIX 已经是 files/usr */
function compInstallSkill(id, rel, rec) {
  const src = path.join(PREFIX, rel.replace(/^usr\//, ""));
  const name = (skillMeta(src) || {}).name || id;
  const dst = path.join(SKILLS_DIR, name);
  try {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    rec.skill = name;
  } catch (e) { log(`[comp] ${id} 技能没装上：${e.message}`); }
}
// v0.1.9 拼错了 skill 路径（多了一层 usr/），装好的组件没有 skill：发现就补上
function compHealSkills() {
  let fs_; try { fs_ = fs.readdirSync(COMP_DIR); } catch { return; }
  for (const f of fs_) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5), rec = compRecord(id);
    if (!rec || rec.state !== "ok" || rec.skill || (COMP_JOBS.get(id) && !COMP_JOBS.get(id).finished)) continue;
    const rel = `usr/share/cccodroid/components/${id}/skill`;
    if (!fs.existsSync(path.join(PREFIX, rel.slice(4), "SKILL.md"))) continue;
    try { fs.rmdirSync(path.join(SKILLS_DIR, id)); } catch {}     // 当时留下的空目录（只删空的）
    compInstallSkill(id, rel, rec);
    if (rec.skill) { compWriteRecord(id, rec); log(`[comp] ${id} 补装技能 ${rec.skill}`); }
  }
}

// 启动后预取一次索引：首次打开「扩展」页时不用干等两份索引下载验签
if (PREFIX) setTimeout(() => { compHealSkills(); compIndex(false).catch(() => {}); }, 8000).unref?.();

// 暂存区是所有组件共用的：只清这一个组件自己的东西（<id>-<sha12>.tar.gz[.part] 和解包目录 <id>）。
// 以前卸载时整个 .staging 一起删，别的组件正在下载的 .part 就被连带删掉 —— curl 写完退出、校验时报 ENOENT
function compClearStage(id) {
  const stage = path.join(COMP_DIR, ".staging");
  let list = []; try { list = fs.readdirSync(stage); } catch { return; }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return;   // 组件 id 只有小写字母、数字、连字符
  const mine = new RegExp("^" + id + "-[0-9a-f]{12}\\.tar\\.gz(\\.part)?$");
  for (const n of list) if (n === id || mine.test(n)) fs.rmSync(path.join(stage, n), { recursive: true, force: true });
}

async function compRunInstall(id, b, job) {
  const stage = path.join(COMP_DIR, ".staging"), gz = path.join(stage, `${id}-${b.sha256.slice(0, 12)}.tar.gz`), tree = path.join(stage, id);
  fs.mkdirSync(stage, { recursive: true });
  // 上回留下的压缩包也要先核对：以前只看存不存在，一份写坏的（被并发清理打断过）会被反复拿去解包，怎么重试都失败
  if (fs.existsSync(gz)) {
    job.phase = "verifying"; job.done = 0; job.total = b.bytes;
    if ((await sha256File(gz, job)) !== b.sha256) { log(`[comp] ${id} 暂存的压缩包校验不符，删掉重下`); fs.rmSync(gz, { force: true }); }
  }
  // 1) 下载（断点续传：.part 的名字带着 sha，换了版本不会接错）
  if (!fs.existsSync(gz)) {
    const part = gz + ".part";
    const tick = setInterval(() => { try { job.done = fs.statSync(part).size; } catch {} }, 500);
    try {
      let lastErr;
      for (let i = 0; i < 4 && !job.cancelled; i++) {
        try {
          await compRun(job, path.join(PREFIX, "bin", "curl"), ["-fL", "-sS", "-C", "-", "--retry", "3", "--speed-limit", "10000", "--speed-time", "60", "-o", part, b.url]);
          lastErr = null; break;
        } catch (e) { lastErr = e; if (job.cancelled) break; }
      }
      if (job.cancelled) throw new Error("cancelled");
      // 上回已经下全、没来得及改名就被打断：续传会得到 416，直接去校验
      let have = 0; try { have = fs.statSync(part).size; } catch {}
      if (lastErr && have !== b.bytes) throw lastErr;
    } finally { clearInterval(tick); }
    job.phase = "verifying"; job.done = 0; job.total = b.bytes;
    const got = await sha256File(part, job);
    if (got !== b.sha256) { fs.rmSync(part, { force: true }); throw new Error(tz("下载的文件校验不符（已删除，重试会重新下载）")); }
    fs.renameSync(part, gz);
  }
  if (job.cancelled) throw new Error("cancelled");
  // 2) 解到暂存区，按包内 MANIFEST 逐个核对
  job.phase = "verifying"; job.done = 0; job.total = b.installed || 0;
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  // 解包失败就把压缩包也删了：下次重试从头下载，不再拿同一份去撞
  try { await compRun(job, path.join(PREFIX, "bin", "tar"), ["-xzf", gz, "-C", tree]); }
  catch (e) { if (!job.cancelled) fs.rmSync(gz, { force: true }); throw e; }
  const lx = `libexec/devkit/components/${id}`;
  const man = fs.readFileSync(path.join(tree, "usr", lx, "MANIFEST"), "utf8").trim().split("\n");
  for (const line of man) {
    if (job.cancelled) throw new Error("cancelled");
    const [h, n, ...rest] = line.split(" "), rel = rest.join(" ");
    const f = path.join(tree, "usr", rel);
    let st; try { st = fs.statSync(f); } catch { throw new Error(tz("组件包缺文件：{file}", { file: rel })); }
    if (st.size !== Number(n) || (await sha256File(f)) !== h) throw new Error(tz("组件包里的文件校验不符：{file}", { file: rel }));
    job.done += st.size;
  }
  // 3) 切换：先写"安装中"的记录（被打断就是 damaged，可以重装或卸载），再逐个搬进 $PREFIX
  job.phase = "installing";
  const old = compRecord(id);
  if (old) compRemoveFiles(id, old);                // 升级 / 重装：先清掉上一版（别的组件也要用的留下）
  const rec = { id, source: b.source || "", version: b.version, upstream: b.upstream, base: b.base, sha256: b.sha256, bin: b.bin || [],
    requires: b.requires || [], skill: "", state: "installing", at: Date.now(), files: [], shared: [] };
  // 先按包内文件清单记下"将要放进去的文件"：搬到一半被杀也能按它卸干净
  const list = [];
  (function walk(rel) {
    for (const d of fs.readdirSync(path.join(tree, "usr", rel), { withFileTypes: true })) {
      const r = rel ? rel + "/" + d.name : d.name;
      if (d.isDirectory()) walk(r); else list.push(r);
    }
  })("");
  // 已经在的（工具包自带，或别的组件放进去的）不覆盖、不归我们，但记进 shared：那个组件卸载时要知道我们也在用
  for (const r of list) { let have = false; try { fs.lstatSync(path.join(PREFIX, r)); have = true; } catch {} (have ? rec.shared : rec.files).push(r); }
  compWriteRecord(id, rec);
  const { skipped } = compMoveIn(path.join(tree, "usr"));
  if (skipped.length) log(`[comp] ${id}：${skipped.length} 个文件已经在了（工具包或别的组件放的），保留原样`);
  // 4) 首次运行配置（各包 postinst），失败不算安装失败
  const fr = path.join(PREFIX, lx, "first-run.sh");
  if (fs.existsSync(fr)) { try { await compRun(job, path.join(PREFIX, "bin", "sh"), [fr]); } catch (e) { log(`[comp] ${id} first-run：${e.message}`); } }
  // 5) 给 Claude 的技能
  if (b.skill) compInstallSkill(id, b.skill, rec);
  rec.state = "ok"; rec.at = Date.now();
  compWriteRecord(id, rec);
  fs.rmSync(tree, { recursive: true, force: true });
  fs.rmSync(gz, { force: true });
}

function compCancel(id) {
  const job = COMP_JOBS.get(id);
  if (!job || job.finished) return { ok: false, message: "not running" };
  if (job.phase === "installing") return { ok: false, message: tz("正在放进工具包，这一步不能中断") };
  job.cancelled = true;
  if (job.child) killTree(job.child);
  return { ok: true };
}

function compRemove(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const job = COMP_JOBS.get(id);
  if (job && !job.finished) return { ok: false, message: "busy" };
  const rec = compRecord(id);
  if (!rec) return { ok: false, message: "not installed" };
  const users = compUsers(id);
  if (users.length) {
    const comps = (compIndexCache.data && compIndexCache.data.components) || {};
    return { ok: false, message: tz("{names} 要用它，先卸载那些组件", { names: users.map((rid) => compName(rid, comps).zh || rid).join("、") }) };
  }
  compRemoveFiles(id, rec);
  fs.rmSync(compRecFile(id), { force: true });
  compClearStage(id);
  COMP_JOBS.delete(id);
  log(`[comp] ${id} 已卸载（${(rec.files || []).length} 个文件）`);
  return { ok: true };
}

// ── 组件的运行数据：约定放在 ~/.cccodroid/<id>/（blender 的 Debian 环境、下载缓存等），卸载组件不碰它。
// 卸载后报出大小、问用户要不要一起删。目录名不一定等于 id（gpu-driver-glibc 用 gpu-driver 的目录），
// 所以只认和 id 同名的目录，还装着 <id>-xxx 组件时当作共用、不提议删
function compDataDir(id) { return path.join(CFG.home, ".cccodroid", id); }
function compDataShared(id) {
  try { return fs.readdirSync(COMP_DIR).some((f) => f.endsWith(".json") && f.startsWith(id + "-")); } catch { return false; }
}
async function compDuBytes(dir) {
  let n = 0;
  const walk = async (d) => {
    let es; try { es = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { n += (await fs.promises.lstat(p)).size; } catch {} }
    }
  };
  await walk(dir);
  return n;
}
async function compDataInfo(id) {
  const dir = compDataDir(id);
  try { if (!fs.lstatSync(dir).isDirectory()) return null; } catch { return null; }
  if (compRecord(id) || compDataShared(id)) return null;
  return { path: "~/.cccodroid/" + id, bytes: await compDuBytes(dir) };
}
async function compPurgeData(id) {
  if (compRecord(id)) return { ok: false, message: "still installed" };
  if (compDataShared(id)) return { ok: false, message: "shared" };
  const dir = compDataDir(id);
  try { if (!fs.lstatSync(dir).isDirectory()) return { ok: true }; } catch { return { ok: true }; }
  const rm = () => fs.promises.rm(dir, { recursive: true, force: true });
  try { await rm(); }
  catch {
    // 解开的 Debian 包里有只读目录：先把目录都改成可写再删
    const fix = async (d) => {
      try { await fs.promises.chmod(d, 0o700); } catch {}
      let es; try { es = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) if (e.isDirectory()) await fix(path.join(d, e.name));
    };
    await fix(dir);
    try { await rm(); } catch (e) { return { ok: false, message: e.message }; }
  }
  log(`[comp] ${id} 的运行数据已删除`);
  return { ok: true };
}

// ── gh 登录卡：设备码流程（显示一次性码 → 用户在浏览器里授权 → gh 自己轮询到完成）──
// 令牌只由 gh 自己存（~/.config/gh/hosts.yml）：网关不读那个文件、不转发、不记 gh 的输出，
// 对外只给账号名与状态。登录成功后跑 gh auth setup-git，git 走 https 推送就能用
const GH = { job: null };
// cccodroid：gh 组件装在 $PREFIX/bin；开发端没有组件这一层，用终端 PATH 里的 gh（devbin/gh）
function ghBin() {
  if (PREFIX) return path.join(PREFIX, "bin", "gh");
  for (const d of String(termEnv().PATH || "").split(":")) if (d && fs.existsSync(path.join(d, "gh"))) return path.join(d, "gh");
  return "";
}
const GH_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
function ghExec(args, timeout = 20000) {
  return new Promise((resolve) => execFile(ghBin(), args, { env: termEnv(), timeout },
    (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out || ""), err: String(err || "") })));
}
function ghKill(job) {
  if (!job.child) return;
  try { process.kill(-job.child.pid, "SIGKILL"); } catch { try { job.child.kill("SIGKILL"); } catch {} }
}
async function ghStatus() {
  const bin = ghBin();
  if (!bin || !fs.existsSync(bin)) return { installed: false };
  // 没登录时也是退出码 0、输出 {"hosts":{}}；令牌失效的账号 state 不是 success
  const r = await ghExec(["auth", "status", "--json", "hosts", "-h", "github.com"]);
  let accounts = [];
  try { accounts = (JSON.parse(r.out).hosts["github.com"] || []).map((a) => ({ login: String(a.login || ""), active: !!a.active, ok: a.state === "success" })); } catch {}
  const j = GH.job;
  return { installed: true, accounts, job: j ? { state: j.state, code: j.code, url: j.url, error: j.error, git: j.git } : null };
}
function ghLogin() {
  const bin = ghBin();
  if (!bin || !fs.existsSync(bin)) return { ok: false, message: tz("gh 没装") };
  if (GH.job && ["starting", "waiting"].includes(GH.job.state)) return { ok: true };
  // 没有终端时 gh 不等回车、不开浏览器，只把一次性码和网址打到 stderr；-s workflow 让推 .github/workflows 也行
  const child = spawn(bin, ["auth", "login", "--web", "-h", "github.com", "-p", "https", "-s", "workflow"],
    { env: termEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const job = (GH.job = { state: "starting", code: "", url: "", error: "", git: null, child });
  let buf = "";
  const onData = (d) => {
    buf = (buf + d).slice(-4000);
    const m = buf.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
    if (m && !job.code) { job.code = m[1]; job.state = "waiting"; }
    const u = buf.match(/https:\/\/github\.com\/login\/device\b/);
    if (u) job.url = u[0];
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { job.state = "error"; job.error = e.message; });
  // 设备码 15 分钟过期，过了还没授权就收掉
  const timer = setTimeout(() => { if (job.child) { job.state = "error"; job.error = "timeout"; ghKill(job); } }, 16 * 60000);
  child.on("exit", async (code) => {
    clearTimeout(timer);
    job.child = null;
    if (job.state === "cancelled" || job.error === "timeout") return;
    if (code !== 0) {
      // 只取最后一行报错给界面（剪贴板那两行提示是 gh 自己复制失败，不算错）
      const last = buf.split("\n").map((l) => l.trim()).filter((l) => l && !/clipboard|xsel|one-time code|Open this URL/i.test(l)).pop();
      job.state = "error"; job.error = (last || tz("gh 退出码 {code}", { code })).slice(0, 300);
      return;
    }
    const s = await ghExec(["auth", "setup-git", "-h", "github.com"]);
    job.git = s.code === 0;
    job.state = "done";
    log(`[gh] 登录完成${job.git ? "，已配好 git 凭据" : "，setup-git 失败"}`);
  });
  return { ok: true };
}
async function handleGh(req, res, p) {
  if (req.method === "GET" && p === "/api/gh/auth") return sendJson(res, 200, await ghStatus());
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  if (p === "/api/gh/login") return sendJson(res, 200, ghLogin());
  if (p === "/api/gh/cancel") {
    const j = GH.job;
    if (j && j.child) { j.state = "cancelled"; ghKill(j); }
    GH.job = null;
    return sendJson(res, 200, { ok: true });
  }
  const user = String(body.user || "");
  if (!GH_USER.test(user)) return sendJson(res, 400, { ok: false, message: "bad user" });
  const args = { "/api/gh/logout": ["auth", "logout", "-h", "github.com", "-u", user], "/api/gh/switch": ["auth", "switch", "-h", "github.com", "-u", user] }[p];
  if (!args) return sendJson(res, 404, { error: "not found" });
  if (GH.job && GH.job.state !== "starting" && GH.job.state !== "waiting") GH.job = null;
  const r = await ghExec(args);
  return sendJson(res, 200, r.code === 0 ? { ok: true } : { ok: false, message: (r.err.trim().split("\n").pop() || "").slice(0, 300) });
}

// ── 自定义组件：用户自己导入的 Linux arm64 程序（不经市场，来源由用户负责） ─────────────────
// 放在 ~/.cccodroid/custom/<id>/（app/ 原样解开的程序，deps/ 自动补的 glibc 库），不进 $PREFIX：换工具包不会被冲掉。
// 入口包装在 ~/.cccodroid/bin（claudeEnv 的 PATH 里，排在工具包 bin 之后，所以不许和工具包的命令重名）；
// 技能在 ~/.claude/skills/custom-<id>/，Claude 由此知道有这个程序、怎么跑起来的。
// 适配按 ELF 的解释器分：glibc（经本应用的 ld-linux + seccomp 垫片）、bionic（安卓原生，设库路径）、
// 静态（套 seccomp 监督器）；x86 / 32 位 / musl 跑不了，分析时如实说。缺的 glibc 库从 Termux 的 glibc 仓库补。
const CUSTOM_DIR = PREFIX ? path.join(CFG.home, ".cccodroid", "custom") : "";
const CUSTOM_BIN = PREFIX ? path.join(CFG.home, ".cccodroid", "bin") : "";
const CUSTOM_REC = "cccodroid-custom.json";
const CUSTOM_STAGES = new Map();          // 分析过、还没装的：stage → { dir, root, report, at }
const GLIBC_REPO = "https://packages-cf.termux.dev/apt/termux-glibc/";
const GLIBC_REPO_LIB = "data/data/com.termux/files/usr/glibc/lib/";
const ELF_ARCH = { 183: "arm64", 62: "x86_64", 40: "arm32", 3: "x86", 243: "riscv64" };
const verCmp = (a, b) => { const x = a.split("."), y = b.split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (+x[i] || 0) - (+y[i] || 0); if (d) return d; } return 0; };

/** 读 ELF：架构、位数、类型、解释器、依赖的库、SONAME、要求的最高 GLIBC 版本。不是 ELF 返回 null */
function elfInfo(file) {
  let fd; try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const h = Buffer.alloc(64);
    if (fs.readSync(fd, h, 0, 64, 0) < 64 || h.readUInt32BE(0) !== 0x7f454c46) return null;
    const info = { arch: ELF_ARCH[h.readUInt16LE(18)] || "machine-" + h.readUInt16LE(18), bits: h[4] === 2 ? 64 : 32, type: h.readUInt16LE(16), interp: "", needed: [], soname: "", glibc: "" };
    if (info.bits !== 64 || h[5] !== 1) return info;
    const phoff = Number(h.readBigUInt64LE(32)), phsz = h.readUInt16LE(54), phnum = h.readUInt16LE(56);
    const ph = Buffer.alloc(phsz * phnum); fs.readSync(fd, ph, 0, ph.length, phoff);
    const loads = []; let dyn = null;
    for (let i = 0; i < phnum; i++) {
      const o = i * phsz, t = ph.readUInt32LE(o);
      const off = Number(ph.readBigUInt64LE(o + 8)), va = Number(ph.readBigUInt64LE(o + 16)), fsz = Number(ph.readBigUInt64LE(o + 32));
      if (t === 1) loads.push({ off, va, fsz });
      else if (t === 3) { const b = Buffer.alloc(Math.min(fsz, 4096)); fs.readSync(fd, b, 0, b.length, off); info.interp = b.toString("latin1").replace(/\0[\s\S]*$/, ""); }
      else if (t === 2) dyn = { off, fsz };
    }
    if (dyn) {
      const d = Buffer.alloc(Math.min(dyn.fsz, 1 << 20)); fs.readSync(fd, d, 0, d.length, dyn.off);
      const need = []; let strtab = 0, strsz = 0, son = -1;
      for (let o = 0; o + 16 <= d.length; o += 16) {
        const tag = Number(d.readBigInt64LE(o)), val = Number(d.readBigUInt64LE(o + 8));
        if (tag === 0) break;
        if (tag === 1) need.push(val); else if (tag === 5) strtab = val; else if (tag === 10) strsz = val; else if (tag === 14) son = val;
      }
      const seg = loads.find((l) => strtab >= l.va && strtab < l.va + l.fsz);
      if (seg && strsz) {
        const s = Buffer.alloc(Math.min(strsz, 8 << 20)); fs.readSync(fd, s, 0, s.length, seg.off + (strtab - seg.va));
        const str = (i) => { const e = s.indexOf(0, i); return s.toString("latin1", i, e < 0 ? s.length : e); };
        info.needed = need.map(str);
        if (son >= 0) info.soname = str(son);
        for (const m of s.toString("latin1").matchAll(/GLIBC_(\d+\.\d+)/g)) if (!info.glibc || verCmp(m[1], info.glibc) > 0) info.glibc = m[1];
      }
    }
    return info;
  } catch { return null; } finally { fs.closeSync(fd); }
}
/** ELF 归类：glibc / bionic / musl / static 是程序，lib 是库，unsupported 是这台机器跑不了的 */
function elfKind(e, name) {
  if (e.arch !== "arm64" || e.bits !== 64) return "unsupported";
  if (/ld-linux|\/lib(64)?\/ld-/.test(e.interp)) return "glibc";
  if (/linker64$/.test(e.interp)) return "bionic";
  if (/ld-musl/.test(e.interp)) return "musl";
  if (e.interp) return "unsupported";
  if (e.soname || /\.so(\.[\d.]+)?$/.test(name) || (e.type === 3 && e.needed.length)) return "lib";
  return "static";
}
let GLIBC_VER;
function glibcVersion() {
  if (GLIBC_VER !== undefined) return GLIBC_VER;
  GLIBC_VER = "";
  try { const m = /release version (\d+\.\d+)/.exec(fs.readFileSync(path.join(PATHS.glibcLib, "libc.so.6")).toString("latin1")); if (m) GLIBC_VER = m[1]; } catch {}
  return GLIBC_VER;
}
const runP = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { env: termEnv(), timeout: 600000, maxBuffer: 16 << 20, ...opts },
  (err, out, errOut) => resolve({ code: err ? (err.code || 1) : 0, out: String(out || ""), err: String(errOut || err?.message || "") })));
function walkFiles(root, rel = "", out = [], cap = 50000) {
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (out.length >= cap) break;
    const r = rel ? rel + "/" + d.name : d.name;
    if (d.isDirectory()) walkFiles(root, r, out, cap); else out.push({ rel: r, link: d.isSymbolicLink(), file: d.isFile() });
  }
  return out;
}
const customSlug = (s) => String(s || "").toLowerCase().replace(/\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar|zip)$/i, "")
  .replace(/[-_.]?(v?\d+(\.\d+)+.*|linux.*|aarch64.*|arm64.*)$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "program";
const CMD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** 命令名能不能用：工具包里已有（PATH 里排在前面，会被盖住）、或别的自定义组件占了，都不行 */
function customCmdClash(cmd, selfId) {
  if (fs.existsSync(path.join(PREFIX, "bin", cmd))) return "toolkit";
  const w = path.join(CUSTOM_BIN, cmd);
  if (fs.existsSync(w)) { const m = /cccodroid-custom-id: ([a-z0-9-]+)/.exec(fs.readFileSync(w, "utf8").slice(0, 400)); if (!m || m[1] !== selfId) return "custom"; }
  return "";
}

// Termux glibc 仓库的 Contents（文件 → 包）与 Packages（包 → 下载地址、sha256），缓存一天
async function glibcRepoIndex() {
  const cache = path.join(CUSTOM_DIR, ".cache"); fs.mkdirSync(cache, { recursive: true });
  const get = async (name, url) => {
    const f = path.join(cache, name), part = f + "." + crypto.randomBytes(3).toString("hex") + ".part";
    try { if (Date.now() - fs.statSync(f).mtimeMs < 86400000) return fs.readFileSync(f); } catch {}
    const r = await runP(path.join(PREFIX, "bin", "curl"), ["-fsSL", "--max-time", "120", "--retry", "2", "-o", part, url]);
    if (r.code) { fs.rmSync(part, { force: true }); if (fs.existsSync(f)) return fs.readFileSync(f); throw new Error(tz("取不到 glibc 仓库索引：{msg}", { msg: r.err.trim().split("\n").pop() })); }
    fs.renameSync(part, f); return fs.readFileSync(f);
  };
  const contents = zlib.gunzipSync(await get("Contents-glibc.gz", GLIBC_REPO + "dists/glibc/Contents-aarch64.gz")).toString();
  const lib = new Map();
  for (const l of contents.split("\n")) {
    if (!l.startsWith(GLIBC_REPO_LIB)) continue;
    const sp = l.lastIndexOf(" "), p = l.slice(GLIBC_REPO_LIB.length, sp).trim();
    if (!p.includes("/")) lib.set(p, l.slice(sp + 1).split(",")[0].replace(/^.*\//, ""));
  }
  const pk = new Map();
  for (const blk of (await get("Packages-glibc", GLIBC_REPO + "dists/glibc/stable/binary-aarch64/Packages")).toString().split("\n\n")) {
    const f = Object.fromEntries(blk.split("\n").map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 1).trim()]));
    if (f.Package) pk.set(f.Package, { version: f.Version, file: f.Filename, sha256: f.SHA256, size: +f.Size || 0 });
  }
  return { lib, pk };
}

/** 一个目录里所有 ELF 的「能提供的库名」（文件名 + SONAME） */
function libNamesIn(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

/** 分析：解开（压缩包）或拷进（单个文件）暂存区，逐个看 ELF，列出程序、缺的库、能补的库 */
async function customAnalyze(src) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  let sp = String(src || "").trim();
  if (!sp) return { ok: false, message: tz("没给文件") };
  if (!path.isAbsolute(sp)) sp = path.join(CFG.workspace, sp);
  let st; try { st = fs.statSync(sp); } catch { return { ok: false, message: tz("找不到文件：{p}", { p: sp }) }; }
  if (!st.isFile()) return { ok: false, message: tz("要选一个文件（程序本身或压缩包）") };
  for (const [k, v] of CUSTOM_STAGES) if (Date.now() - v.at > 3600000) { fs.rmSync(v.dir, { recursive: true, force: true }); CUSTOM_STAGES.delete(k); }
  const stage = crypto.randomBytes(6).toString("hex");
  const dir = path.join(CUSTOM_DIR, ".stage-" + stage), x = path.join(dir, "x");
  fs.mkdirSync(x, { recursive: true });
  const base = path.basename(sp), warnings = [];
  const fail = (m) => { fs.rmSync(dir, { recursive: true, force: true }); return { ok: false, message: m }; };
  if (/\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar)$/i.test(base)) {
    const r = await runP(path.join(PREFIX, "bin", "tar"), ["-xf", sp, "-C", x, "--no-same-owner"]);
    if (r.code) return fail(tz("解压失败：{msg}", { msg: r.err.trim().split("\n").slice(-2).join(" ") }));
  } else if (/\.zip$/i.test(base)) {
    const r = await runP(path.join(PREFIX, "bin", "unzip"), ["-q", "-o", sp, "-d", x]);
    if (r.code > 1) return fail(tz("解压失败：{msg}", { msg: r.err.trim().split("\n").slice(-2).join(" ") }));
  } else if (/\.(deb|rpm|apk|appimage)$/i.test(base)) {
    return fail(tz("{ext} 包还不支持：请用程序本身、或 .tar.gz / .zip 压缩包", { ext: base.split(".").pop() }));
  } else {
    const head = Buffer.alloc(4); const fd = fs.openSync(sp, "r"); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.readUInt32BE(0) !== 0x7f454c46 && head.toString("latin1", 0, 2) !== "#!") return fail(tz("认不出这个文件：不是程序（ELF）、脚本，也不是支持的压缩包"));
    const name = base.replace(/[^\w.+-]/g, "_");
    fs.copyFileSync(sp, path.join(x, name)); fs.chmodSync(path.join(x, name), 0o755);
  }
  // 解出来的软链只许指向包内：绝对路径或者跳出去的一律删掉（不然装进去以后顺着它能碰到别处）
  const all = walkFiles(x);
  for (const f of all.filter((a) => a.link)) {
    const abs = path.join(x, f.rel); let t = "";
    try { t = fs.readlinkSync(abs); } catch {}
    const to = path.resolve(path.dirname(abs), t);
    if (path.isAbsolute(t) || !(to === x || to.startsWith(x + path.sep))) { fs.rmSync(abs, { force: true }); warnings.push(tz("去掉了指向包外的软链：{p}", { p: f.rel })); }
  }
  // 只有一个顶层目录（常见的 foo-1.2-linux-arm64/）就以它为根
  let root = x;
  const top = fs.readdirSync(x);
  if (top.length === 1 && fs.statSync(path.join(x, top[0])).isDirectory()) root = path.join(x, top[0]);
  const files = walkFiles(root).filter((f) => f.file || f.link);
  if (!files.length) return fail(tz("里面是空的"));
  let bytes = 0;
  const elves = [], scripts = [];
  for (const f of files) {
    const abs = path.join(root, f.rel);
    let s; try { s = fs.statSync(abs); } catch { continue; }
    if (!s.isFile()) continue;
    bytes += s.size;
    const e = elfInfo(abs);
    if (e) { elves.push({ rel: f.rel, ...e, kind: elfKind(e, path.basename(f.rel)), exec: (s.mode & 0o111) !== 0 }); continue; }
    if (s.mode & 0o111) {
      const b = Buffer.alloc(128); const fd = fs.openSync(abs, "r"); const n = fs.readSync(fd, b, 0, 128, 0); fs.closeSync(fd);
      const line = b.toString("utf8", 0, n).split("\n")[0];
      if (line.startsWith("#!")) scripts.push({ rel: f.rel, interp: line.slice(2).trim() });
    }
  }
  // 库目录：放着 .so 的目录（相对根），程序启动时按它们找库
  const libDirs = [...new Set(elves.filter((e) => e.kind === "lib").map((e) => path.dirname(e.rel)))];
  const provided = new Set();
  for (const d of libDirs) for (const n of libNamesIn(path.join(root, d))) provided.add(n);
  for (const e of elves) if (e.soname) provided.add(e.soname);
  const glibcHave = new Set(libNamesIn(PATHS.glibcLib));
  const bionicHave = new Set([...libNamesIn(path.join(PREFIX, "lib")), ...libNamesIn("/system/lib64")]);
  const gv = glibcVersion();
  const missingGlibc = new Set();
  const isGlibcLib = (e) => e.kind === "lib" && e.needed.some((n) => /^libc\.so\.6$|^ld-linux/.test(n));
  for (const e of elves) {
    if (e.kind === "glibc" || isGlibcLib(e)) e.missing = e.needed.filter((n) => !provided.has(n) && !glibcHave.has(n));
    else if (e.kind === "bionic") e.missing = e.needed.filter((n) => !provided.has(n) && !bionicHave.has(n));
    else e.missing = [];
    if (e.kind === "glibc" || isGlibcLib(e)) for (const n of e.missing) missingGlibc.add(n);
    if (gv && e.glibc && verCmp(e.glibc, gv) > 0) warnings.push(tz("{p} 要求 GLIBC_{need}，本机是 {have}，可能跑不起来", { p: e.rel, need: e.glibc, have: gv }));
  }
  // 缺的 glibc 库：查 Termux glibc 仓库，能补的装的时候下载
  let fixable = [], unresolved = [];
  if (missingGlibc.size) {
    try {
      const ix = await glibcRepoIndex();
      for (const n of missingGlibc) { const pkg = ix.lib.get(n); if (pkg && ix.pk.has(pkg)) fixable.push({ soname: n, pkg, size: ix.pk.get(pkg).size }); else unresolved.push(n); }
    } catch (e) { warnings.push(e.message); unresolved = [...missingGlibc]; }
  }
  const progs = elves.filter((e) => ["glibc", "bionic", "static", "musl", "unsupported"].includes(e.kind) && (e.exec || e.kind !== "unsupported"))
    .map((e) => ({ rel: e.rel, kind: e.kind, arch: e.arch, bits: e.bits, interp: e.interp, needed: e.needed, missing: e.missing || [], glibc: e.glibc }))
    .concat(scripts.map((s) => ({ rel: s.rel, kind: "script", interp: s.interp, needed: [], missing: [] })));
  const okKinds = new Set(["glibc", "bionic", "static", "script"]);
  const inBin = (r) => !r.includes("/") || /(^|\/)(s?bin)\/[^/]+$/.test(r);
  for (const p of progs) {
    p.cmd = path.basename(p.rel).replace(/\.(sh|py|bin|AppImage)$/i, "").replace(/[^A-Za-z0-9._+-]/g, "-");
    p.suggest = okKinds.has(p.kind) && inBin(p.rel) && !/\.(so|py|sh)$/.test(p.rel) || (p.kind !== "script" && okKinds.has(p.kind) && progs.filter((q) => okKinds.has(q.kind)).length === 1);
    p.clash = CMD_RE.test(p.cmd) ? customCmdClash(p.cmd, "") : "bad";
    if (p.kind === "unsupported") p.why = p.arch !== "arm64" ? tz("这是 {arch} 程序，手机（arm64）跑不了", { arch: p.bits === 32 && p.arch === "arm32" ? "32 位 ARM" : p.arch }) : tz("解释器 {i} 认不出", { i: p.interp });
    if (p.kind === "musl") p.why = tz("musl 程序暂不支持：找同一个程序的静态版或 glibc 版");
  }
  progs.sort((a, b) => (b.suggest - a.suggest) || a.rel.localeCompare(b.rel));
  if (!progs.some((p) => okKinds.has(p.kind))) {
    const why = progs.find((p) => p.why)?.why;
    return fail(why || tz("没找到能运行的程序（arm64 的 ELF 或脚本）"));
  }
  const id0 = customSlug(base);
  let id = id0; for (let i = 2; fs.existsSync(path.join(CUSTOM_DIR, id)); i++) id = (id0.slice(0, 36) + "-" + i);
  const report = {
    ok: true, stage, source: base, id, name: base.replace(/\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar|zip)$/i, ""),
    files: files.length, bytes, programs: progs.slice(0, 60), libDirs, fixable, unresolved, warnings,
    glibc: gv, gpu: fs.existsSync(path.join(PREFIX, "bin", "lgpu-run")),
    readme: files.map((f) => f.rel).find((r) => /^readme(\.(md|txt))?$/i.test(path.basename(r)) && !r.includes("/", r.indexOf("/") + 1)) || "",
  };
  CUSTOM_STAGES.set(stage, { dir, root, report, at: Date.now() });
  return report;
}

/** 从 glibc 仓库补库：按 soname 找包、下载、核对 sha256、只取用得上的 .so（软链解成实体），
 *  补进来的库自己还缺什么接着补，最多 6 轮 */
async function customFetchLibs(want, deps, have, log2) {
  const ix = await glibcRepoIndex();
  const cache = path.join(CUSTOM_DIR, ".cache"), got = [];
  fs.mkdirSync(deps, { recursive: true });
  for (let round = 0; want.size && round < 6; round++) {
    const byPkg = new Map();
    for (const n of want) { if (have.has(n)) continue; const p = ix.lib.get(n); if (p && ix.pk.has(p)) (byPkg.get(p) || byPkg.set(p, []).get(p)).push(n); }
    want = new Set();
    for (const [pkg, names] of byPkg) {
      const m = ix.pk.get(pkg), deb = path.join(cache, path.basename(m.file));
      let ok = false; try { ok = (await sha256File(deb)) === m.sha256; } catch {}
      if (!ok) {
        const part = deb + "." + crypto.randomBytes(3).toString("hex") + ".part";
        log2(tz("下载 {pkg}（{mb} MB）", { pkg, mb: Math.max(1, Math.round(m.size / 1048576)) }));
        const r = await runP(path.join(PREFIX, "bin", "curl"), ["-fsSL", "--max-time", "900", "--retry", "2", "-o", part, GLIBC_REPO + m.file]);
        if (r.code) { fs.rmSync(part, { force: true }); throw new Error(tz("下载 {pkg} 失败：{msg}", { pkg, msg: r.err.trim().split("\n").pop() })); }
        if ((await sha256File(part)) !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error(tz("{pkg} 校验不对", { pkg })); }
        fs.renameSync(part, deb);
      }
      // .deb 是 ar 包：找 data.tar.*，用工具包的 tar 解到临时目录
      const buf = fs.readFileSync(deb); let off = 8, member = null;
      while (off + 60 <= buf.length) {
        const nm = buf.toString("latin1", off, off + 16).trim().replace(/\/$/, ""), size = parseInt(buf.toString("latin1", off + 48, off + 58), 10);
        if (nm.startsWith("data.tar")) { member = { nm, data: buf.subarray(off + 60, off + 60 + size) }; break; }
        off += 60 + size + (size & 1);
      }
      if (!member) throw new Error(tz("{pkg} 的包结构不对", { pkg }));
      const tmp = path.join(cache, "x-" + pkg + "-" + crypto.randomBytes(3).toString("hex")); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      const tf = path.join(tmp, member.nm); fs.writeFileSync(tf, member.data);
      const r = await runP(path.join(PREFIX, "bin", "tar"), ["-xf", tf, "-C", tmp, "--no-same-owner", "./" + GLIBC_REPO_LIB]);
      if (r.code) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(tz("解开 {pkg} 失败：{msg}", { pkg, msg: r.err.trim().split("\n").pop() })); }
      const libd = path.join(tmp, GLIBC_REPO_LIB);
      for (const n of names) {
        if (have.has(n)) continue;
        let real; try { real = fs.realpathSync(path.join(libd, n)); } catch { continue; }
        if (!real.startsWith(tmp + path.sep)) continue;
        fs.copyFileSync(real, path.join(deps, n)); fs.chmodSync(path.join(deps, n), 0o755);
        have.add(n); got.push({ soname: n, pkg, version: m.version });
        const e = elfInfo(path.join(deps, n));
        for (const d of (e && e.needed) || []) if (!have.has(d)) want.add(d);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // 下载的 .deb 只是中转（gcc-libs 就 20 多 MB），用完删掉；索引留着
  for (const f of fs.readdirSync(cache)) if (f.endsWith(".deb")) fs.rmSync(path.join(cache, f), { force: true });
  return { got, still: [...want].filter((n) => !have.has(n)) };
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** 一个入口的包装脚本：按程序类型套上能让它在这里跑起来的那层 */
function customWrapper(id, p, appDir, libs, opts) {
  const prog = path.join(appDir, p.rel), sh = path.join(PREFIX, "bin", "sh");
  const er = SETTINGS.staticCompat !== false ? enosysRun() : "";
  const head = `#!${sh}\n# cccodroid-custom-id: ${id}\n# 自定义组件「${id}」的入口：${p.rel}（${p.kind}）。由扩展页生成，卸载组件时一起删掉。\n`;
  const erLine = `ER=${shq(er)}; [ -n "$ER" ] && [ -x "$ER" ] || ER=\n`;
  if (p.kind === "glibc") {
    if (opts.gpu) { const own = libs.filter((l) => l !== PATHS.glibcLib); return head + `exec ${shq(path.join(PREFIX, "bin", "lgpu-run"))}${own.length ? " -L " + shq(own.join(":")) : ""} -- ${shq(prog)} "$@"\n`; }
    const pre = PATHS.preload && fs.existsSync(PATHS.preload) ? ` --preload ${shq(PATHS.preload)}` : "";
    if (opts.patchelf) return head + `unset LD_PRELOAD LD_LIBRARY_PATH\n` + erLine + `exec $ER \${ER:+-f} ${shq(prog)} "$@"\n`;
    // 摘掉 termux-exec 的 bionic 垫片（glibc 的 ld.so 带不了它）；库路径里只放 glibc 的目录
    return head + `unset LD_PRELOAD LD_LIBRARY_PATH\n` + erLine +
      `exec $ER \${ER:+-f} ${shq(PATHS.loader)} --library-path ${shq(libs.join(":"))}${pre} --argv0 "$0" ${shq(prog)} "$@"\n`;
  }
  if (p.kind === "bionic") {
    const own = libs.filter((l) => l !== PATHS.glibcLib && !l.endsWith("/deps"));
    return head + (own.length ? `export LD_LIBRARY_PATH=${shq(own.join(":"))}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n` : "") + `exec ${shq(prog)} "$@"\n`;
  }
  if (p.kind === "static") return head + erLine + `exec $ER \${ER:+-f} ${shq(prog)} "$@"\n`;
  return head + `exec ${shq(prog)} "$@"\n`;          // 脚本：保留 termux-exec，#!/usr/bin/env 之类才认得
}

function customSkill(rec) {
  const kindZh = { glibc: "glibc 程序（Linux 发行版那种），经本应用的 glibc 加载器启动", bionic: "安卓原生程序（bionic）", static: "静态链接程序", script: "脚本" };
  const lines = rec.entries.map((e) => `- \`${e.cmd}\` → \`${path.join(rec.dir, "app", e.rel)}\`：${kindZh[e.kind] || e.kind}${e.gpu ? "，经 gpu-driver-glibc 的 lgpu-run 用 GPU（Vulkan / Turnip）" : ""}${e.patchelf ? "，已用 patchelf 改了解释器和 RUNPATH" : ""}`);
  return `---
name: custom-${rec.id}
description: 用户自己导入的程序「${rec.name.replace(/\n/g, " ")}」${rec.desc ? "：" + rec.desc.replace(/\n/g, " ") : ""}（cccodroid 自定义组件）。命令：${rec.entries.map((e) => e.cmd).join("、")}。用户提到它或要用这些命令时使用。
---

# ${rec.name}（自定义组件）

用户在扩展页「自定义组件」里自己导入的 Linux arm64 程序（来源：\`${rec.source}\`）。**没经过 cccodroid 验证**，能不能用以实际运行为准。
${rec.desc ? "\n用户的说明：" + rec.desc + "\n" : ""}
## 运行链路

${lines.join("\n")}

- 入口是 \`~/.cccodroid/bin/<命令>\` 的包装脚本（在 PATH 里），程序文件在 \`${rec.dir}/app/\`${rec.readme ? "，自带说明 `" + path.join(rec.dir, "app", rec.readme) + "`" : ""}。
- glibc 程序的库按这个顺序找：${rec.libs.map((l) => "`" + l + "`").join(" → ")}。${rec.deps.length ? "\n- 从 Termux glibc 仓库补进来的库（在 deps/）：" + rec.deps.map((d) => `${d.soname}（${d.pkg} ${d.version}）`).join("、") + "。" : ""}
- 包装脚本会摘掉 termux-exec 的 LD_PRELOAD，并套上 seccomp 垫片（安卓会拦一些系统调用，垫片把它们改成返回 ENOSYS）。

## 出错时

- \`error while loading shared libraries: libXXX.so\`：缺库。告诉用户缺哪个；Termux glibc 仓库有的，可以在扩展页删掉这个组件后重新导入（导入时会自动补）。
- \`Bad system call\` 或直接被杀：撞了安卓的 seccomp。确认设置里「静态程序兼容」开着。
- 程序找不到自己的数据文件：有的程序按 /proc/self/exe 找自己的位置，经加载器启动时那会指向加载器。可以在扩展页对这个组件改用 patchelf 方式重装。
- 程序要图形界面（X11 / Wayland）：这里没有桌面，跑不了界面，只能用它的命令行功能。
- 不要改 \`${rec.dir}\` 里的文件，也不要往 \`~/.cccodroid/bin\` 里手写脚本；要改就让用户在扩展页重新导入。
`;
}

async function customInstall(b) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const s = CUSTOM_STAGES.get(String(b.stage || ""));
  if (!s) return { ok: false, message: tz("分析结果过期了，重新导入一次") };
  const id = String(b.id || "");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return { ok: false, message: tz("名字只能用小写字母、数字和 -") };
  const dir = path.join(CUSTOM_DIR, id);
  if (fs.existsSync(dir)) return { ok: false, message: tz("已经有一个叫 {id} 的自定义组件了，换个名字或先卸载它", { id }) };
  const progs = new Map(s.report.programs.map((p) => [p.rel, p]));
  const entries = [], seen = new Set();
  for (const e of Array.isArray(b.entries) ? b.entries : []) {
    const p = progs.get(String(e.rel || "")), cmd = String(e.cmd || "");
    if (!p || !["glibc", "bionic", "static", "script"].includes(p.kind)) continue;
    if (!CMD_RE.test(cmd)) return { ok: false, message: tz("命令名不合法：{c}", { c: cmd }) };
    if (seen.has(cmd)) return { ok: false, message: tz("命令名重复：{c}", { c: cmd }) };
    const clash = customCmdClash(cmd, id);
    if (clash) return { ok: false, message: clash === "toolkit" ? tz("命令 {c} 工具包里已经有了，换个名字", { c: cmd }) : tz("命令 {c} 被别的自定义组件占了", { c: cmd }) };
    seen.add(cmd);
    entries.push({ rel: p.rel, cmd, kind: p.kind, gpu: !!e.gpu && p.kind === "glibc" && s.report.gpu, patchelf: !!e.patchelf && p.kind === "glibc" && !e.gpu });
  }
  if (!entries.length) return { ok: false, message: tz("至少选一个要用的命令") };
  const msgs = [], log2 = (m) => { msgs.push(m); log(`[custom] ${id}：${m}`); };
  fs.mkdirSync(dir, { recursive: true });
  const appDir = path.join(dir, "app"), deps = path.join(dir, "deps");
  try {
    fs.renameSync(s.root, appDir);
    fs.rmSync(s.dir, { recursive: true, force: true });
    CUSTOM_STAGES.delete(b.stage);
    // 补库
    let got = [], still = [];
    const need = new Set(s.report.fixable.map((f) => f.soname));
    if (need.size && b.fetchLibs !== false) {
      const have = new Set([...libNamesIn(PATHS.glibcLib)]);
      for (const d of s.report.libDirs) for (const n of libNamesIn(path.join(appDir, d))) have.add(n);
      ({ got, still } = await customFetchLibs(need, deps, have, log2));
    }
    const libs = [...s.report.libDirs.map((d) => path.join(appDir, d)), ...(got.length ? [deps] : []), PATHS.glibcLib];
    // patchelf 方式：直接改程序的解释器和 RUNPATH（/proc/self/exe 才指向程序本身）
    for (const e of entries.filter((x) => x.patchelf)) {
      const f = path.join(appDir, e.rel);
      const r = await runP(path.join(PREFIX, "bin", "patchelf"), ["--set-interpreter", PATHS.loader, "--set-rpath", libs.join(":"), f]);
      if (r.code) throw new Error(tz("patchelf 改 {p} 失败：{msg}", { p: e.rel, msg: r.err.trim().split("\n").pop() }));
    }
    fs.mkdirSync(CUSTOM_BIN, { recursive: true });
    for (const e of entries) {
      try { fs.chmodSync(path.join(appDir, e.rel), 0o755); } catch {}
      fs.writeFileSync(path.join(CUSTOM_BIN, e.cmd), customWrapper(id, e, appDir, libs, e), { mode: 0o755 });
    }
    const rec = {
      id, name: String(b.name || id).slice(0, 80), desc: String(b.desc || "").slice(0, 400), source: s.report.source,
      dir, at: Date.now(), entries, libs, deps: got, unresolved: [...s.report.unresolved, ...still], readme: s.report.readme,
      bytes: s.report.bytes,
    };
    fs.writeFileSync(path.join(dir, CUSTOM_REC), JSON.stringify(rec, null, 1));
    const sk = path.join(SKILLS_DIR, "custom-" + id);
    fs.mkdirSync(sk, { recursive: true });
    fs.writeFileSync(path.join(sk, "SKILL.md"), customSkill(rec));
    log(`[custom] ${id} 已装：${entries.map((e) => e.cmd + "(" + e.kind + ")").join(" ")}，补库 ${got.length} 个`);
    return { ok: true, id, log: msgs, unresolved: rec.unresolved };
  } catch (e) {
    customRemove(id, true);
    return { ok: false, message: e.message, log: msgs };
  }
}

/** 网关启动时按记录重写入口：「静态程序兼容」开关、工具包路径变了，入口跟着变；装了 GPU 组件以后被卸掉的，退回普通方式 */
function customRefresh() {
  if (!PREFIX) return;
  const gpu = fs.existsSync(path.join(PREFIX, "bin", "lgpu-run"));
  for (const r of customRecords()) {
    try {
      fs.mkdirSync(CUSTOM_BIN, { recursive: true });
      for (const e of r.entries) fs.writeFileSync(path.join(CUSTOM_BIN, e.cmd), customWrapper(r.id, e, path.join(r.dir, "app"), r.libs, { gpu: e.gpu && gpu, patchelf: e.patchelf }), { mode: 0o755 });
    } catch (e) { log(`[custom] ${r.id} 入口重写失败：${e.message}`); }
  }
}
function customRecords() {
  const out = [];
  try { for (const d of fs.readdirSync(CUSTOM_DIR)) { if (d.startsWith(".")) continue; try { out.push(JSON.parse(fs.readFileSync(path.join(CUSTOM_DIR, d, CUSTOM_REC), "utf8"))); } catch {} } } catch {}
  return out.sort((a, b) => b.at - a.at);
}
function customList() {
  if (!PREFIX) return { supported: false };
  return { supported: true, gpu: fs.existsSync(path.join(PREFIX, "bin", "lgpu-run")), items: customRecords().map((r) => ({
    id: r.id, name: r.name, desc: r.desc, source: r.source, at: r.at, bytes: r.bytes, unresolved: r.unresolved || [],
    deps: (r.deps || []).length, entries: r.entries.map((e) => ({ cmd: e.cmd, kind: e.kind, gpu: e.gpu, patchelf: e.patchelf, ok: fs.existsSync(path.join(CUSTOM_BIN, e.cmd)) })),
  })) };
}
function customRemove(id, quiet) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return { ok: false, message: "bad id" };
  const dir = path.join(CUSTOM_DIR, id);
  if (!fs.existsSync(dir)) return { ok: false, message: "not installed" };
  try { for (const f of fs.readdirSync(CUSTOM_BIN)) { const w = path.join(CUSTOM_BIN, f); if (fs.readFileSync(w, "utf8").slice(0, 400).includes("cccodroid-custom-id: " + id + "\n")) fs.rmSync(w, { force: true }); } } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(SKILLS_DIR, "custom-" + id), { recursive: true, force: true });
  if (!quiet) log(`[custom] ${id} 已卸载`);
  return { ok: true };
}
/** 试运行：--version，不认就 --help，8 秒为限，只取开头几行 */
async function customTry(id, cmd) {
  const rec = customRecords().find((r) => r.id === id);
  const e = rec && rec.entries.find((x) => x.cmd === cmd);
  if (!e) return { ok: false, message: "not found" };
  const w = path.join(CUSTOM_BIN, cmd);
  let last;
  for (const arg of ["--version", "--help"]) {
    last = await runP(w, [arg], { timeout: 8000, cwd: CFG.workspace });
    if (last.code === 0) break;
  }
  const text = (last.out + (last.out && last.err ? "\n" : "") + last.err).split("\n").slice(0, 14).join("\n").slice(0, 1500);
  // 不认 --version / --help 的程序会以非 0 退出，但打出了用法也算「跑起来了」；装载失败才算没跑起来
  const broken = /error while loading shared libraries|Exec format error|Bad system call|cannot execute|version `GLIBC_|symbol lookup error/.test(text) || last.code === 126 || last.code === 127 || last.code === "ETIMEDOUT" && !text;
  return { ok: !broken && (last.code === 0 || !!text.trim()), code: last.code, output: text };
}

async function handleCustom(req, res, p, u) {
  if (req.method === "GET" && p === "/api/custom") return sendJson(res, 200, customList());
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  if (p === "/api/custom/upload") {
    // 程序可能很大（几百 MB）：流式落盘到暂存目录，不走 /api/upload 的 64 MB 内存缓冲
    if (!PREFIX) return sendJson(res, 200, { ok: false, message: "only available in cccodroid" });
    const name = path.basename(u.searchParams.get("name") || "program").replace(/[^\w.+-]/g, "_").slice(0, 120) || "program";
    const up = path.join(CUSTOM_DIR, ".uploads"); fs.mkdirSync(up, { recursive: true });
    try { for (const f of fs.readdirSync(up)) if (Date.now() - fs.statSync(path.join(up, f)).mtimeMs > 3600000) fs.rmSync(path.join(up, f), { force: true }); } catch {}
    const out = path.join(up, crypto.randomBytes(4).toString("hex") + "-" + name);
    await new Promise((resolve, reject) => { const w = fs.createWriteStream(out); req.pipe(w); w.on("finish", resolve); w.on("error", reject); req.on("error", reject); });
    const r = await customAnalyze(out);
    fs.rmSync(out, { force: true });
    if (r.ok) r.source = r.source.replace(/^[0-9a-f]{8}-/, "");
    return sendJson(res, 200, r);
  }
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  if (p === "/api/custom/analyze") return sendJson(res, 200, await customAnalyze(body.path));
  if (p === "/api/custom/install") return sendJson(res, 200, await customInstall(body));
  if (p === "/api/custom/discard") { const s = CUSTOM_STAGES.get(String(body.stage || "")); if (s) { fs.rmSync(s.dir, { recursive: true, force: true }); CUSTOM_STAGES.delete(body.stage); } return sendJson(res, 200, { ok: true }); }
  if (p === "/api/custom/remove") return sendJson(res, 200, customRemove(String(body.id || "")));
  if (p === "/api/custom/try") return sendJson(res, 200, await customTry(String(body.id || ""), String(body.cmd || "")));
  return sendJson(res, 404, { error: "not found" });
}

async function handleComponents(req, res, p, u) {
  if (req.method === "GET" && p === "/api/components") return sendJson(res, 200, await compList(((r) => r === "1" ? true : /^\d+$/.test(r || "") ? Number(r) * 1000 : false)(u.searchParams.get("refresh"))));
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const id = String(body.id || "");
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return sendJson(res, 400, { ok: false, message: "bad id" });
  if (p === "/api/components/install") return sendJson(res, 200, await compInstall(id));
  if (p === "/api/components/cancel") return sendJson(res, 200, compCancel(id));
  if (p === "/api/components/remove") { const r = compRemove(id); if (r.ok) r.data = await compDataInfo(id); return sendJson(res, 200, r); }
  if (p === "/api/components/purge") return sendJson(res, 200, await compPurgeData(id));
  return sendJson(res, 404, { error: "not found" });
}

function uiTag() {
  let t = 0;
  let files = [];
  try { files = fs.readdirSync(PATHS.web); } catch {}
  for (const f of files) {
    try { t = Math.max(t, fs.statSync(path.join(PATHS.web, f)).mtimeMs); } catch {}
  }
  return Math.round(t);
}

function sendJson(res, code, obj) {
  if (obj && typeof obj.message === "string" && res.req) obj = { ...obj, message: tr(reqLang(res.req), obj.message) };
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
  res.end(b);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.replace(/^\/+/, "");
  if (rel.includes("..")) return sendJson(res, 403, { error: "forbidden" });
  const full = path.join(PATHS.web, rel);
  if (!full.startsWith(PATHS.web) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    log(`404 ${rel}`);
    return sendJson(res, 404, { error: "not found", path: rel });
  }
  const data = fs.readFileSync(full);
  res.writeHead(200, {
    "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 16 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── 事件总线 ──────────────────────────────────────────────────────────
// Claude Desktop 的做法：一次生成（run）属于网关，不属于哪个 HTTP 请求。
// 前端只是订阅者 —— 断线、切后台、热替换界面、甚至开两个窗口，都不影响生成本身；
// 连回来时按 Last-Event-ID 从环形缓冲续上，续不上就把当前这一轮从头重放。
//
// 旧版的暗病都出在"生成绑在 /api/chat 那条 SSE 上"：
//   - WebView 一 reload（uiTag 变了、切后台被回收）请求一断，req.on('close') 就把 claude 杀了；
//   - 回来看不到正在跑的那一轮，只能等它（已经被杀的）结束；
//   - 排队在前端内存里，一刷新就丢。
const BOOT = Date.now().toString(36);
const BUS = { seq: 0, ring: [], clients: new Set() };
const RING_MAX = 4000;

function publish(ev) {
  const seq = ++BUS.seq;
  const line = `id: ${BOOT}.${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
  BUS.ring.push({ seq, line });
  if (BUS.ring.length > RING_MAX) BUS.ring.splice(0, BUS.ring.length - RING_MAX);
  for (const c of BUS.clients) busWrite(c, line);
}
function busWrite(res, line) {
  try {
    // 订阅者读得太慢（WebView 在后台被冻住）：别让它把网关内存撑爆，断掉让它重连续传
    if (res.writableLength > 8 * 1024 * 1024) { BUS.clients.delete(res); res.destroy(); return; }
    res.write(line);
  } catch { BUS.clients.delete(res); }
}
setInterval(() => { for (const c of BUS.clients) busWrite(c, ": hb\n\n"); }, 15000).unref();

// ── 生成与排队 ────────────────────────────────────────────────────────
const QUEUE = [];                 // 等着跑的消息：{ id, message, sessionId, follow, model, permissionMode, addDirs, at }
const RUN_SESSIONS = new Map();   // runId → sessionId（新会话要等 init 才知道自己的会话号）
const RUN_LANE = new Map();       // runId → 车道（跟在它后面排队的消息走同一条车道）

// ── 车道：同一个会话里的消息严格按顺序一条条跑，不同会话可以同时跑 ──
//   "s:<会话号>"  发给已有会话的
//   "n:<runId>"   新会话还没拿到会话号：以第一条消息的 runId 为名，后面跟着发的（follow）都进这条车道
function laneOf(item) {
  if (item.follow && RUN_LANE.get(item.follow)) return RUN_LANE.get(item.follow);
  return item.sessionId ? "s:" + item.sessionId : "n:" + (item.follow || item.id);
}
const laneOfItem = (q) => q.lane || (q.lane = laneOf(q));
const sidOfLane = (lane) => lane.startsWith("s:") ? lane.slice(2) : (RUN_SESSIONS.get(lane.slice(2)) || null);
/** 这条车道上正在跑的那一轮（没有就 null）。新会话 init 之后会话号和车道名对得上 */
function laneRun(lane) {
  const sid = sidOfLane(lane);
  for (const r of RUNS.values()) if (r.lane === lane || (sid && r.sessionId === sid)) return r;
  return null;
}
const sameLane = (q, run) => { const l = laneOfItem(q), sid = sidOfLane(l); return l === run.lane || (!!sid && sid === run.sessionId); };
let RUN_N = 0;
const newRunId = () => `r${BOOT}${(++RUN_N).toString(36)}`;

const runInfo = (r) => r && {
  id: r.id, cid: r.cid, text: r.text.slice(0, 2000), sessionId: r.sessionId, follow: r.follow, startedAt: r.startedAt,
  perms: r.perms ? [...r.perms.values()] : [],
  idle: !!r.idle, bg: r.bgTasks || 0, bgList: r.bgList || [], auto: r.auto || null,
};

/** 改权限模式：存进设置（下一轮沿用），正在跑的那一轮当场切（set_permission_mode） */
function setPermMode(mode) {
  if (!PERM_MODES.includes(mode)) return false;
  if (SETTINGS.permissionMode !== mode) log(`权限模式 ${SETTINGS.permissionMode} → ${mode}`);   // 排障时看得出是谁、何时切的
  SETTINGS.permissionMode = mode;
  saveSettings();
  for (const r of RUNS.values()) if (r.setMode) r.setMode(mode);
  publish({ type: "perm_mode", mode });
  return true;
}
function snapshot() {
  return {
    run: runInfo(latestRun()),           // 旧字段：最近开始的那一轮
    runs: runList().map(runInfo),
    maxParallel: maxParallel(),
    queue: QUEUE.map((q) => ({ id: q.id, cid: q.cid, text: q.message.slice(0, 500), sessionId: q.sessionId, follow: q.follow, at: q.at, held: !!q.held, intr: !!q.intr })),
    provider: PROVIDER.id,
    model: SETTINGS.model || PROVIDER.defaultModel || null,
    lastSessionId: LAST_SESSION ? LAST_SESSION.id : null,
    interrupted: INTERRUPTED,
  };
}
const publishState = () => { saveRunMark(); publish({ type: "state", ...snapshot() }); };

// ── 被系统杀掉后接得上（A2）──────────────────────────────────────────
// 正在跑的这一轮 + 排队的消息，每次状态变化都落盘；正常收尾、队列清空时删掉。
// App 连同网关被系统结束时它留下来：下次启动把那一轮记成「已中断」（前端给「继续」），
// 排队的消息原样放回队列、一律挂起 —— 杀掉之后不许自己发出去，用户点 ⚡ 才发。
const RUN_MARK = path.join(CFG.home, "ccapp-run-mark.json");
const INTR_FILE = path.join(CFG.home, "ccapp-interrupted.json");
function saveRunMark() {
  try {
    if (!RUNS.size && !QUEUE.length) return fs.rmSync(RUN_MARK, { force: true });
    const live = runList().filter((r) => !r.ended);
    fs.writeFileSync(RUN_MARK + ".tmp", JSON.stringify({
      runs: live.map((r) => ({ id: r.id, sessionId: r.sessionId, text: r.text.slice(0, 4000), startedAt: r.startedAt })),
      // 已经写进 stdin、claude 还没吃进去的插话也算排队的：一起留下
      queue: [...live.flatMap((r) => (r.pendingInject || []).map((it) => ({ ...it, injected: false }))), ...QUEUE],
    }), { mode: 0o600 });
    fs.renameSync(RUN_MARK + ".tmp", RUN_MARK);
  } catch {}
}
let INTERRUPTED = (() => {
  try { const j = JSON.parse(fs.readFileSync(INTR_FILE, "utf8")); if (j && j.id) return j; } catch {}
  return null;
})();
function setInterrupted(v) {
  INTERRUPTED = v;
  try { v ? fs.writeFileSync(INTR_FILE, JSON.stringify(v), { mode: 0o600 }) : fs.rmSync(INTR_FILE, { force: true }); } catch {}
}
/** 启动时调一次：上一任留下的标记 → 中断记录 + 挂起的队列 */
function recoverRunMark() {
  let m;
  try { m = JSON.parse(fs.readFileSync(RUN_MARK, "utf8")); } catch { return; }
  finally { try { fs.rmSync(RUN_MARK, { force: true }); } catch {} }
  // 并行时可能同时断了好几轮：「继续」卡只挂最近开始的那一轮，其余的会话内容都在，用户打开接着聊就行
  const runs = (Array.isArray(m.runs) ? m.runs : m.run ? [m.run] : []).filter((r) => r && r.id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const r of runs) {
    if (r.sessionId) RUN_SESSIONS.set(r.id, r.sessionId);
    log(`⚠️ 上一轮没跑完就被结束了（会话 ${r.sessionId || "未建立"}），已标为中断`);
  }
  if (runs.length) setInterrupted({ ...runs[runs.length - 1], at: Date.now() });
  for (const q of Array.isArray(m.queue) ? m.queue : []) {
    if (!q || !q.id || typeof q.message !== "string") continue;
    if (!q.sessionId && q.follow && RUN_SESSIONS.get(q.follow)) q.sessionId = RUN_SESSIONS.get(q.follow);
    QUEUE.push({ ...q, held: true, intr: true });   // intr：前端据此说「被系统中断」而不是「点了停止」
  }
  if (QUEUE.length) { log(`  排队的 ${QUEUE.length} 条消息已放回队列（挂起，等用户点 ⚡）`); saveRunMark(); }
}
recoverRunMark();

// 逐字增量太碎：攒 40ms 合成一条再发，其它事件到来前先冲掉，保证顺序不乱
function runEmit(run, ev) {
  if (run.ended) return;
  ev.runId = run.id;
  if (ev.type === "delta" || ev.type === "thinking_delta") {
    if (run.pend && run.pend.type === ev.type) run.pend.text += ev.text;
    else { flushPend(run); run.pend = ev; }
    if (!run.pendTimer) run.pendTimer = setTimeout(() => flushPend(run), 40);
    return;
  }
  flushPend(run);
  record(run, ev);
  publish(ev);
}
function flushPend(run) {
  if (run.pendTimer) { clearTimeout(run.pendTimer); run.pendTimer = null; }
  const p = run.pend; run.pend = null;
  if (p) { record(run, p); publish(p); }
}
/** 这一轮的完整事件记录 —— 断线太久环形缓冲续不上时，靠它把整轮重放给前端。
 *  相邻增量就地合并，一轮再长也只有"块数"那么多条。 */
function record(run, ev) {
  const last = run.log[run.log.length - 1];
  if (last && last.type === ev.type && (ev.type === "delta" || ev.type === "thinking_delta")) last.text += ev.text;
  else if (last && last.type === "usage" && ev.type === "usage") run.log[run.log.length - 1] = { ...ev };
  else if (last && last.type === "phase" && ev.type === "phase") run.log[run.log.length - 1] = { ...ev };
  else run.log.push({ ...ev });
}

function endRun(run, fields = {}) {
  if (run.ended) return;
  flushPend(run);
  run.ended = true;
  RUNS.delete(run.id);
  if (!RUNS.size) runFlag(false);
  publish({ type: "run_end", runId: run.id, sessionId: run.sessionId, aborted: !!run.aborted, ...(run.auto ? { auto: run.auto } : {}), ...fields });
  goalCheck(run.sessionId);
  tasksCheck(run.sessionId);
  run.log = [];
  publishState();
  setImmediate(pump);
}

function abortRun(run) {
  if (!run || run.ended) return false;
  run.aborted = true;
  // 停止要和排队的消息严格隔开：此刻排着的一律挂起，不许这一轮一结束就自动发出去
  // （以前点停止反而是"立刻发下一条"）。用户点 ⚡ 才发；停止之后新发的消息不受影响，照常先跑
  // 并行时只挂起这个会话自己排着的，别的会话不受影响
  for (const q of QUEUE) if (sameLane(q, run)) { q.held = true; q.intr = false; }
  if (run.child) killTree(run.child);
  return true;
}

// ── 空闲压缩（上游 2.1.299 起只在终端交互模式里有；网关每轮起一个进程，用不上，照它的条件自己做）──
// 上游的条件：自动压缩开着、没关空闲压缩、1 小时缓存、缓存还热、上下文 ≥ 20 万、之后没有新请求、额度没逼近上限。
// 1 小时缓存从接口返回的 cache_creation.ephemeral_1h_input_tokens 看出来（订阅账户就是这种）；
// 第三方厂商的缓存规则各不相同，不做。计时从这一轮结束算起，54 分钟时缓存还剩约 6 分钟。
// 两个环境变量只给测试用（缩短等待、降低门槛）
const IDLE_MS = Number(process.env.CCAPP_IDLE_MS) || 54 * 60 * 1000, IDLE_MIN_TOKENS = Number(process.env.CCAPP_IDLE_MIN) || 200000;
const IDLE = new Map();   // 会话号 → { timer, ctx, at, size }
function idleDisarm(sid) { const x = IDLE.get(sid); if (x) { clearTimeout(x.timer); IDLE.delete(sid); } }
function idleDisarmAll() { for (const sid of [...IDLE.keys()]) idleDisarm(sid); }
function autoCompactOff() {
  if (/^(1|true)$/i.test(process.env.DISABLE_COMPACT || "") || /^(1|true)$/i.test(process.env.DISABLE_AUTO_COMPACT || "")) return true;
  try { return JSON.parse(fs.readFileSync(path.join(CFG.home, ".claude", "settings.json"), "utf8")).autoCompactEnabled === false; } catch { return false; }
}
function idleArm(sid, flags) {
  idleDisarm(sid);
  const ctx = flags.mainCtx || 0;
  if (SETTINGS.idleCompaction === false || !PROVIDER.nativeModels || PROVIDER.local) return;
  if (!flags.cache1h || flags.cache5m || ctx < IDLE_MIN_TOKENS || autoCompactOff()) return;
  let size = -1; try { size = fs.statSync(findSessionFile(sid).file).size; } catch { return; }
  const timer = setTimeout(() => idleFire(sid), IDLE_MS);
  timer.unref?.();
  IDLE.set(sid, { timer, ctx, at: Date.now(), size });
  log(`⏲ 空闲压缩已挂上：会话 ${sid.slice(0, 8)} 上下文 ${ctx}，${IDLE_MS / 60000} 分钟后没动静就压缩`);
}
function idleFire(sid) {
  const x = IDLE.get(sid);
  IDLE.delete(sid);
  if (!x || SETTINGS.idleCompaction === false || !PROVIDER.nativeModels) return;
  const why = (() => {
    if (laneRun("s:" + sid)) return "正在跑";
    if (QUEUE.some((q) => sidOfLane(laneOfItem(q)) === sid)) return "有排队的消息";
    try { if (fs.statSync(findSessionFile(sid).file).size !== x.size) return "会话有新内容"; } catch { return "会话文件不见了"; }
    const rl = RATE_LIMITS;
    if (rl && isLoginMode() && Math.max(rl.fiveHour?.used || 0, rl.sevenDay?.used || 0) >= 90) return "额度逼近上限";
    return null;
  })();
  if (why) { log(`⏲ 空闲压缩跳过（${why}）：会话 ${sid.slice(0, 8)}`); return; }
  log(`⏲ 空闲压缩：会话 ${sid.slice(0, 8)} 闲置 ${Math.round((Date.now() - x.at) / 60000)} 分钟，上下文 ${x.ctx}`);
  enqueue({ message: "/compact", sessionId: sid, auto: "idle" });
}

/** 有空位就从队列里挑能跑的：车道空闲、且是这条车道上排在最前的（同一会话不许插队、不许同时跑两轮） */
function pump() {
  const blocked = new Set();
  for (let i = 0; i < QUEUE.length && RUNS.size < maxParallel(); ) {
    const q = QUEUE[i];
    if (q.held) { i++; continue; }                  // 停止时挂起的不自动发，也不挡后面新发的
    const lane = laneOfItem(q), key = sidOfLane(lane) || lane;
    if (blocked.has(key) || laneRun(lane)) { blocked.add(key); i++; continue; }
    blocked.add(key);
    const item = QUEUE.splice(i, 1)[0];
    startRun(item).catch((e) => {                   // startRun 同步占槽，RUNS.size 立刻算上它
      log(`run 异常: ${e.stack || e.message}`);
      const r = RUNS.get(item.id);
      if (r) {
        runEmit(r, { type: "error", message: tr(LAST_LANG, tz("内部错误：{err}", { err: e.message })) });
        endRun(r, { failed: true });
      }
    });
  }
}

function enqueue(body) {
  const item = {
    id: newRunId(),
    message: String(body.message || ""),
    sessionId: body.sessionId ? String(body.sessionId) : null,
    follow: body.follow ? String(body.follow) : null,
    cid: body.cid ? String(body.cid).slice(0, 64) : null,   // 前端自己的消息号：SSE 可能比 POST 的响应先到
    model: body.model || null,
    permissionMode: body.permissionMode || null,
    addDirs: Array.isArray(body.addDirs) ? body.addDirs : [],
    at: Date.now(),
    ...(body.auto ? { auto: body.auto } : {}),
  };
  // 插话（"inject"，旧前端叫 "interrupt"）：不打断。消息直接写进正在跑的 claude 的 stdin，
  // claude 会在当前这一步（比如一次工具调用）结束后把它并进对话，同一轮里接着干 —— 和终端里边干边打字一样。
  // 塞不进去（这一轮已在收尾、或者不是同一个会话）就排到队首，这一轮一结束马上发。
  const busyRun = laneRun(laneOfItem(item));
  if (busyRun && busyRun.idle && tryInject(busyRun, item)) { item.injected = true; publishState(); return item; }
  if ((body.mode === "inject" || body.mode === "interrupt") && busyRun) {
    if (tryInject(busyRun, item)) { item.injected = true; return item; }
    QUEUE.unshift(item);
  } else {
    QUEUE.push(item);
  }
  publishState();
  pump();
  return item;
}

function tryInject(run, item) {
  if (!run.inject || item.message.trim().startsWith("/")) return false;   // 斜杠命令得自己单跑一轮
  const same = item.sessionId ? item.sessionId === run.sessionId : (item.follow === run.id || !item.follow);
  if (!same) return false;
  return run.inject(item);
}

// ── 账户登录（OAuth 全程由 claude 自己完成；网关只转递地址，不碰凭据）────────
//
// 两条路，同一个进程：
//   自动：设了 BROWSER，claude 会把一个 redirect_uri=http://localhost:<端口>/callback 的地址
//         交给"浏览器"，自己在那个端口等回调。手机浏览器和 claude 在同一台机器上，
//         授权完浏览器跳回 localhost，claude 直接收到 —— 不用贴码。
//         我们的"浏览器"是个小脚本，只把地址写进文件，由界面交给系统浏览器打开。
//   手动：浏览器回不到 localhost 时（比如在别的设备上授权），页面会显示一个授权码。
//         这个码网关**不经手**：界面打开一个终端跑 claude auth login，用户把码直接贴给 claude 自己的提示
//         （终端只是通用的字节通道，和 Termux / SSH 一样）。以前的 /api/login/code 接收授权码再写进 stdin，
//         条款要求登录走 Anthropic 自己的流程、开发者不得经手凭据，所以拿掉了。
let LOGIN = null;
const LOGIN_DIR = path.join(CFG.home, ".cache", "ccapp-login");

function authEnv() {
  const env = claudeEnv();
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) delete env[k];
  return env;
}

function loginStart(flag) {
  if (LOGIN && LOGIN.child.exitCode === null) try { LOGIN.child.kill("SIGKILL"); } catch {}
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  const urlFile = path.join(LOGIN_DIR, "url");
  const browser = path.join(LOGIN_DIR, "browser.sh");
  try { fs.unlinkSync(urlFile); } catch {}
  fs.writeFileSync(browser, '#!/system/bin/sh\nprintf "%s\\n" "$1" > "' + urlFile + '"\n', { mode: 0o700 });
  const env = { ...authEnv(), BROWSER: browser };
  const child = spawn(PATHS.loader, claudeArgv(["auth", "login", flag]), { cwd: CFG.home, env, stdio: ["ignore", "pipe", "pipe"] });
  const L = LOGIN = { child, out: "", startedAt: Date.now(), done: false, ok: false, flag };
  const onData = (d) => { L.out += String(d); };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("close", (code) => {
    L.done = true;
    L.ok = code === 0 && /success/i.test(L.out);
    log("登录：" + (L.ok ? "成功" : "结束（退出码 " + code + "）"));
    // 浏览器授权完停在 claude 的托管成功页上，用户不知道怎么回来 —— 主动把界面叫回前台
    if (L.ok) toFront("登录成功").then((r) => log("登录：回到前台 → " + (r.via || r.message || "?")));
  });
  log("登录：已启动 claude auth login " + flag);
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let auto = "";
      try { auto = fs.readFileSync(urlFile, "utf8").trim(); } catch {}
      const manual = (L.out.match(/https:\/\/\S+/) || [""])[0];
      if ((auto && manual) || L.done || Date.now() - L.startedAt > 20000) {
        clearInterval(tick);
        resolve(auto || manual
          ? { ok: true, url: auto || manual, manualUrl: manual, auto: !!auto }
          : { ok: false, message: tz("没拿到登录地址"), output: L.out.slice(-1500) });
      }
    }, 200);
  });
}

/** 登录状态由 claude 自己报（claude auth status），网关不读凭据文件 */
function runAuth(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(PATHS.loader, claudeArgv(["auth", ...args]), { cwd: CFG.home, env: authEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
  });
}
let AUTH_CACHE = null;
async function authStatus(force) {
  if (!force && AUTH_CACHE && Date.now() - AUTH_CACHE.at < 30000) return AUTH_CACHE.v;
  const r = await runAuth(["status"]);
  let j = {};
  try { j = JSON.parse(r.out.slice(r.out.indexOf("{"))); } catch {}
  // 只转出界面要显示的几项；令牌之类的东西它本来也不报
  const v = {
    loggedIn: !!j.loggedIn, authMethod: j.authMethod || "none",
    email: j.email || j.account?.email || null,
    org: j.orgName || j.organization?.name || null,
    plan: j.subscriptionType || j.plan || null,
  };
  AUTH_CACHE = { at: Date.now(), v };
  return v;
}

// ── /model 与 /effort：由网关本地处理 ─────────────────────────────────
// 为什么不让 claude 自己处理：它自带的 /model 只改「当前会话」，
// 而 GUI 每次调用都是新进程 —— 下一条消息就忘了。只有落到 SETTINGS 才持久。
async function handleLocalCommand(name, arg, reply) {
  const models = await fetchModels(true);
  const cur = models.find((m) => m.id === SETTINGS.model) || models[0];

  // ── /autocompact ──
  // 交给 claude 自己处理的话：它写进 ~/.claude/settings.json，但我们下发的 CLAUDE_CODE_AUTO_COMPACT_WINDOW
  // 优先级更高（它会说 "env is set and takes precedence"），界面上的压缩线也要切一次模型才刷新。
  // 所以由网关接住：存进设置（和设置页那一栏是同一个值），下一轮起生效，前端收到 run_end 就刷新刻度。
  if (name === "autocompact") {
    const win = Number(cur && cur.context_window) || 0;
    const fmt = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
    if (!arg) {
      const v = effectiveAutoCompact();
      return reply(
        `自动压缩线：**${v ? fmt(v) + " tokens" : "默认（由 claude 按模型窗口决定）"}**${win ? `　（当前模型窗口 ${fmt(win)}）` : ""}\n\n` +
        "用法：`/autocompact 400k`、`/autocompact 1m`；恢复默认：`/autocompact off`。设置页「自动压缩」一栏是同一个值。",
        "autocompact"
      );
    }
    const a = arg.trim().toLowerCase();
    let n = null;
    if (!/^(off|default|reset|auto|0)$/.test(a)) {
      const m = a.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
      if (!m) return reply(`看不懂 \`${arg.trim()}\`。写成 \`400k\`、\`1m\` 或纯数字；恢复默认用 \`off\`。`, "autocompact");
      n = Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
      if (n < 10000) return reply(`${fmt(n)} 太小了，压缩线至少 10k。`, "autocompact");
    }
    SETTINGS.autoCompactWindow = n;
    saveSettings();
    log(`⌘ /autocompact → ${n || "(默认)"}`);
    return reply(
      (n ? `自动压缩线已设为 **${fmt(n)} tokens**，下一轮起生效。` : "自动压缩线已恢复默认（由 claude 按模型窗口决定），下一轮起生效。") +
      (n && win && n > win ? `\n\n> ⚠️ 比当前模型的窗口（${fmt(win)}）还大，实际会先撞上窗口上限。` : ""),
      "autocompact"
    );
  }

  // ── /model ──
  if (name === "model" || name === "models") {
    if (!arg) {
      // 原生厂商（claude 自己认识模型）：不列清单，也不劝你手选
      if (!models.length) {
        return reply(
          `当前厂商：**${PROVIDER.label || PROVIDER.id}**（claude 原生）\n\n` +
          `> 该厂商由 claude 自己决定模型，未提供可切换的模型清单 —— \`/model\` 在此不适用。\n` +
          `> 若要指定，可直接写进 \`ccapp-providers.json\` 的 \`defaultModel\`。`,
          "model"
        );
      }
      const lines = models.map((m) => {
        const on = m.id === SETTINGS.model ? "**▸** " : "　　";
        const img = (m.input_modalities || []).includes("image") ? " · 支持图片" : "";
        const eff = (m.effort?.supported_levels || []).join(" / ");
        return `${on}\`${m.id}\` — ${m.name || ""}\n　　上下文 ${Math.round((m.context_window || 0) / 1024)}k${img} · effort ${eff}`;
      }).join("\n\n");
      return reply(
        `当前厂商：**${PROVIDER.label || PROVIDER.id}**\n` +
        `当前模型：**${SETTINGS.model || "(由 claude 决定)"}**　（effort **${SETTINGS.effort || "默认"}**）\n\n` +
        `可用模型：\n\n${lines}\n\n` +
        `用法：\`/model <id>\`　切换思考强度：\`/effort\`\n\n` +
        (PROVIDER.nativeModels
          ? `> 模型名由 claude 自己解析，写错会直接报错。`
          : `> 第三方厂商对不认识的名字**可能静默回落**，所以这里挡一道，免得你以为切成功了。`),
        "model"
      );
    }
    const t = arg.toLowerCase().trim();
    const target = models.find((m) => m.id.toLowerCase() === t)
      || models.find((m) => (m.name || "").toLowerCase() === t)
      || models.find((m) => m.id.toLowerCase().includes(t));
    if (!target) {
      if (!models.length) {
        return reply(
          `当前厂商（**${PROVIDER.label || PROVIDER.id}**）未提供模型清单，\`/model\` 不适用。\n` +
          `> 原生厂商由 claude 自己决定模型；要指定就改 \`ccapp-providers.json\` 的 \`defaultModel\`。`,
          "model"
        );
      }
      return reply(
        `没有模型 \`${arg}\`。\n\n可用：${models.map((m) => "`" + m.id + "`").join("、")}\n\n` +
        `（${PROVIDER.label || PROVIDER.id} 收到不认识的名字可能静默回落，所以这里挡住，免得你以为切成功了）`,
        "model"
      );
    }
    SETTINGS.model = target.id;
    const eff = normEffort(target, SETTINGS.effort);
    const effChanged = eff !== SETTINGS.effort;
    SETTINGS.effort = eff;
    saveSettings();
    return reply(
      `已切换到 **${target.id}**${target.name ? "（" + target.name + "）" : ""}\n\n` +
      `- 上下文窗口：${Math.round((target.context_window || 0) / 1024)}k\n` +
      `- 输入模态：${(target.input_modalities || []).join(" / ")}\n` +
      `- effort 档位：${(target.effort?.supported_levels || []).join(" / ")}\n` +
      (effChanged ? `- ⚠️ 原 effort 该模型不支持，已调为 \`${eff}\`\n` : "") +
      `\n下一条消息生效。`,
      "model"
    );
  }

  // ── /effort ──
  if (name === "effort") {
    const levels = effortLevelsOf(cur);
    const dflt = cur && cur.effort && cur.effort.default_level;
    if (!arg) {
      const lines = levels.map((l) =>
        `${l === SETTINGS.effort ? "**▸** " : "　　"}\`${l}\`` + (l === dflt ? "　（模型默认）" : "")).join("\n");
      return reply(
        `当前模型 **${SETTINGS.model || "默认"}** 的思考强度：**${SETTINGS.effort || "(未设置)"}**\n\n${lines}\n\n` +
        `用法：\`/effort <level>\`\n\n` +
        `> 档位越高思考越久、通常质量越好。实测首字延迟：\`low\` ≈ 0.9s，\`max\` ≈ 2.3s。`,
        "effort"
      );
    }
    const t = arg.toLowerCase().trim();
    if (levels.includes(t)) {
      SETTINGS.effort = t;
      saveSettings();
      return reply(`思考强度已设为 **${t}**（模型 ${SETTINGS.model || "默认"}）。\n\n下一条消息生效。`, "effort");
    }
    // claude 认 low/medium/high/xhigh/max，DeepSeek 只有 low/high/max，做个就近映射
    const alias = { medium: "high", xhigh: "max", highest: "max", lowest: "low", normal: "high" }[t];
    if (alias && levels.includes(alias)) {
      SETTINGS.effort = alias;
      saveSettings();
      return reply(`\`${arg}\` 不是 ${SETTINGS.model} 的档位，已就近设为 **${alias}**。\n\n` +
        `该模型支持：${levels.map((l) => "`" + l + "`").join("、")}`, "effort");
    }
    return reply(`\`${arg}\` 不是有效档位。**${SETTINGS.model || "默认模型"}** 支持：${levels.map((l) => "`" + l + "`").join("、")}`, "effort");
  }

  return reply(`未知命令 /${name}`, name);
}

// ── 跑一轮 ────────────────────────────────────────────────────────────
// 和 HTTP 请求完全脱钩：前端断了也接着跑，结果照样落进 transcript、照样广播。
async function startRun(item) {
  const run = {
    id: item.id,
    text: item.message,
    // 跟在一个还没拿到会话号的新会话后面排队的：等前一条 init 了再接上它的会话
    sessionId: item.sessionId || (item.follow && RUN_SESSIONS.get(item.follow)) || null,
    follow: item.follow,
    cid: item.cid,
    auto: item.auto || null,           // "idle" = 网关自己发起的空闲压缩（界面画成系统提示，不发通知）
    startedAt: Date.now(),
    child: null, aborted: false, ended: false,
    provider: PROVIDER.id,             // 记 token 用：开跑时的厂商（跑着的时候不许切）
    log: [], pend: null, pendTimer: null,
  };
  run.lane = laneOfItem(item);
  RUNS.set(run.id, run);                 // 同步占槽，中间不许有 await
  RUN_LANE.set(run.id, run.lane);
  if (RUN_LANE.size > 1000) for (const k of [...RUN_LANE.keys()].slice(0, 500)) if (!RUNS.has(k)) RUN_LANE.delete(k);
  runFlag(true);
  // 在被中断的那个会话里又跑起来了（点了「继续」或者直接接着聊）：中断提示就不用再挂着了
  if (INTERRUPTED && (INTERRUPTED.sessionId ? INTERRUPTED.sessionId === run.sessionId : !run.sessionId)) setInterrupted(null);
  if (run.sessionId) { RUN_SESSIONS.set(run.id, run.sessionId); idleDisarm(run.sessionId); }
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt, ...(run.auto ? { auto: run.auto } : {}) });
  publishState();

  const message = run.text;
  const local = message.trim().match(/^\/(model|models|effort|autocompact)(?:\s+([\s\S]*))?$/);
  if (local) {
    log(`⌘ 本地命令 /${local[1]}${local[2] ? " " + local[2].trim() : ""}`);
    return handleLocalCommand(local[1], (local[2] || "").trim(),
      (text, cmd) => endRun(run, { localCommand: cmd || local[1], resultText: text, durationMs: 0, costUsd: 0 }));
  }

  if (!API_KEY && !PROVIDER.login) {
    emit({ type: "error", message: tr(LAST_LANG, tz("未配置 API 密钥。请在设置里填入 {name} 的密钥。", { name: PROVIDER.label || PROVIDER.id })) });
    return endRun(run, { failed: true });
  }
  if (!isLoginMode() && !(await ensureBridge())) {
    emit({ type: "error", message: tr(LAST_LANG, tz("本地 DNS 桥启动失败，无法连接 API。")) });
    return endRun(run, { failed: true });
  }
  if (run.aborted) return endRun(run, { failed: true });   // 等桥的时候就被停了

  // 模型三级取：本次请求指定 → 设置里存的 → 该厂商自己的默认。
  // ⚠️ 不能回落到 CFG.model：那是全局兜底（deepseek-flash），只有内置厂商能碰。
  let model = (item.model || SETTINGS.model || PROVIDER.defaultModel || (PROVIDER.explicit ? "" : CFG.model) || "").trim();
  // 原生厂商只认 claude 自家的模型名；别家的名字（切厂商前留下的）宁可不传，交给 claude 自己选
  if (PROVIDER.nativeModels && model && !/^(claude-|opus|sonnet|haiku|fable|default|best)/i.test(model)) model = "";
  let permMode = String(item.permissionMode || SETTINGS.permissionMode || "default").trim();
  if (!PERM_MODES.includes(permMode)) permMode = "default";

  // 端侧小模型：先确保 llama-server 跑着、载的是这个模型（第一次要加载十几秒）
  if (PROVIDER.local) {
    try {
      const m = await ensureLlama(model, (key, text) => emit({ type: "note", key, text }));
      model = m.id;
      LL.run = run;
    } catch (e) {
      emit({ type: "error", message: e.message });
      return endRun(run, { failed: true });
    }
    if (run.aborted) return endRun(run, { failed: true });
  }

  const argv = [
    "-p",
    // 流式输入：stdin 一直开着，跑到一半还能再递消息进去（插话）。
    // --replay-user-messages 让 claude 在真正吃进一条消息时回显出来 —— 我们靠它知道插话何时送达。
    "--input-format", "stream-json",
    "--replay-user-messages",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", permMode,
    // 要确认的工具调用走 stdout 的 control_request(can_use_tool) 来问我们，前端出卡片，用户点了再回 stdin。
    // 不加这个，-p 模式下 claude 不问，直接按拒绝处理（实测：工具结果 "…needs approval"）
    "--permission-prompt-tool", "stdio",
  ];
  if (model) argv.push("--model", model);
  if (run.sessionId) argv.push("--resume", String(run.sessionId));

  // 告诉 claude 这台设备上有什么现成工具 —— 不说它就不会去用。
  // 和用户自己的追加提示合成一条：重复给同一个单值参数，解析器一般只留一个，合成一条最稳
  // 端侧：--bare 换成很短的系统提示和精简工具（见「端侧小模型」一节）；本机工具清单太长，小模型读不起，不附
  // 内置只有聊天（不给工具）；自定义模式的工具清单和提示由用户的配置文件给（见 localCustom）
  const lcust = PROVIDER.local ? localCustomActive() : null;
  if (PROVIDER.local) argv.push("--bare", "--tools", lcust ? lcust.tools : "");
  // 端侧只补一句身份（--bare 的提示自称 Claude，小模型会照着说），几十 token，不拖慢首字
  const localHint = !PROVIDER.local ? "" : lcust && lcust.systemPrompt ? lcust.systemPrompt
    : `You are ${model}, a small open model running locally on the user's Android device through llama.cpp (not Claude). Reply in the user's language; keep answers short.`;
  const appendPrompt = [PROVIDER.local ? localHint : toolsHint(), !PROVIDER.nativeModels && !PROVIDER.local ? TASKS_HINT : "", PROVIDER.local ? "" : PREVIEW_HINT, SETTINGS.appendSystemPrompt].filter(Boolean).join("\n\n");
  if (appendPrompt) argv.push("--append-system-prompt", appendPrompt);
  // claude 没有 --output-style 参数（传了直接 unknown option，整条消息失败）；它是 settings 里的 outputStyle。
  // 密钥读取器也在这里（见 settingsArgs）
  argv.push(...settingsArgs());
  if (SETTINGS.effort) argv.push("--effort", SETTINGS.effort);
  if (SETTINGS.allowedTools?.length) argv.push("--allowedTools", SETTINGS.allowedTools.join(","));
  if (SETTINGS.disallowedTools?.length) argv.push("--disallowedTools", SETTINGS.disallowedTools.join(","));

  const dirs = new Set();
  if (fs.existsSync(CFG.workspace)) dirs.add(CFG.workspace);
  if (process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED)) dirs.add(process.env.CCAPP_SHARED);
  for (const d of SETTINGS.addDirs || []) if (fs.existsSync(d)) dirs.add(d);
  for (const d of item.addDirs || []) if (typeof d === "string" && fs.existsSync(d)) dirs.add(d);
  for (const d of dirs) argv.push("--add-dir", d);

  const isCmd = message.trim().startsWith("/");
  log(`▶ ${isCmd ? "命令" : "提问"} ${message.trim().slice(0, 60).replace(/\s+/g, " ")}  ${run.sessionId ? `(续 ${String(run.sessionId).slice(0, 8)})` : "(新会话)"}  [model=${model || "默认"} effort=${SETTINGS.effort || "默认"} style=${SETTINGS.outputStyle || "默认"} perm=${permMode}]`);
  const t0 = Date.now();

  const [cmd0, args0] = claudeCmd(argv);
  const child = spawn(cmd0, args0, {
    cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home,
    env: claudeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,            // 当进程组长，中断时好整组带走（见 killTree）
  });
  run.child = child;
  child.stdin.on("error", () => {});
  const writeUser = (text) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  writeUser(message);
  run.inputOpen = true;
  run.pendingInject = [];      // 已写进 stdin、还没被 claude 吃进去的插话
  run.bgTasks = 0;             // claude 报的后台任务数（见 feed）
  run.bgList = [];             // 后台任务明细：{ id, type, desc }（shell / 子代理 / monitor / 工作流），界面列出来、可单独停
  run.replays = 0;
  run.inject = (item) => {
    if (!run.inputOpen || run.ended || run.aborted) return false;
    try { writeUser(item.message); } catch { return false; }
    run.pendingInject.push(item);
    log(`↪ 插话 ${item.message.trim().slice(0, 60).replace(/\s+/g, " ")}`);   // 压成一行：诊断包按行抹掉对话内容
    return true;
  };
  // 每轮 result 之后：没有待送达的插话就关 stdin，claude 随即退出；有就留着，它会接着处理
  // ── 权限确认（stream-json 控制协议）──
  // claude 要用需确认的工具时，往 stdout 发 control_request(can_use_tool) 然后等；我们回 control_response。
  // 待答的请求存在 run.perms，同时作为 perm_request 事件发给前端（也进 run.log，断线重连能补到）。
  run.perms = new Map();
  const writeCtl = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); return true; } catch { return false; } };
  let ctlN = 0;
  run.setMode = (mode) => run.inputOpen && writeCtl({ type: "control_request", request_id: "ccapp-" + (++ctlN), request: { subtype: "set_permission_mode", mode } });
  // 停掉一个后台任务（stop_task 控制请求；claude 停完会再报一次 background_tasks_changed）
  run.stopTask = (taskId) => run.inputOpen && run.bgList.some((t) => t.id === taskId) &&
    writeCtl({ type: "control_request", request_id: "ccapp-" + (++ctlN), request: { subtype: "stop_task", task_id: taskId } });
  run.answerPerm = (id, a) => {
    const p = run.perms.get(id);
    if (!p || run.ended || run.aborted) return false;
    let resp;
    if (a.behavior === "allow") {
      // 参数一律用 claude 发来的原样，前端改不了命令；AskUserQuestion 只往里加 answers
      const input = p.tool === "AskUserQuestion" && a.answers && typeof a.answers === "object"
        ? { ...p.input, answers: Object.fromEntries(Object.entries(a.answers).map(([k, v]) => [String(k), String(v)])) }
        : p.input;
      resp = { behavior: "allow", updatedInput: input };
      // 「始终允许」：只认 claude 自己给的建议（规则 + 目录），前端不能塞任意规则；切模式另走 a.mode
      if (a.always) {
        const ups = (p.suggestions || []).filter((x) => x && (x.type === "addRules" || x.type === "addDirectories"));
        if (ups.length) resp.updatedPermissions = ups;
      }
    } else {
      resp = { behavior: "deny", message: String(a.message || "").trim().slice(0, 2000) || "用户拒绝了这次操作。", ...(a.interrupt ? { interrupt: true } : {}) };
    }
    if (!writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: resp } })) return false;
    run.perms.delete(id);
    log(`${resp.behavior === "allow" ? "✓ 允许" : "✗ 拒绝"} ${p.tool}${a.always && resp.updatedPermissions ? "（始终）" : ""}${a.interrupt ? "（并停止）" : ""}`);
    emit({ type: "perm_resolved", id, behavior: resp.behavior, always: !!resp.updatedPermissions, interrupt: !!a.interrupt });
    if (a.mode && PERM_MODES.includes(a.mode)) setPermMode(a.mode);
    publishState();
    return true;
  };
  const onControl = (ev) => {
    const id = ev.request_id, r = ev.request || {};
    if (r.subtype === "can_use_tool" && id) {
      const p = {
        id, tool: String(r.tool_name || ""), input: r.input || {}, toolUseId: r.tool_use_id || null,
        suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
        reason: r.decision_reason || null, blockedPath: r.blocked_path || null, description: r.description || null,
        interactive: !!r.requires_user_interaction, agentId: r.agent_id || null, at: Date.now(),
        runId: run.id, sessionId: run.sessionId || null,   // 并行时通知要知道是哪个会话的
      };
      run.perms.set(id, p);
      log(`⏸ 等确认 ${p.tool} ${String(p.input.command || p.input.file_path || p.input.url || "").slice(0, 60)}`);
      emit({ type: "perm_request", ...p });
      publishState();
      return;
    }
    // 别的控制请求（hook 回调、MCP elicitation…）我们不接：回错误，别让 claude 干等
    if (id) writeCtl({ type: "control_response", response: { subtype: "error", request_id: id, error: `unsupported: ${r.subtype}` } });
  };

  const closeInput = () => {
    if (!run.inputOpen || run.perms.size) return;
    run.inputOpen = false;
    try { child.stdin.end(); } catch {}
  };

  let buf = "", stderr = "", lastResult = null;
  // 开了 --include-partial-messages，正文已经逐字发过，assistant 事件别重复整段
  const flags = { gotDelta: false, isCmd };
  const onInit = (init) => {
    LAST_INIT = init;
    run.sessionId = init.session_id;
    // 新会话的 run_start 发出时还没有会话号：回填进日志，别的视图切过来、整轮重放时才认得出这是它的
    for (const e of run.log || []) if (e.type === "run_start" && !e.sessionId) e.sessionId = run.sessionId;
    RUN_SESSIONS.set(run.id, run.sessionId);
    if (RUN_SESSIONS.size > 500) RUN_SESSIONS.delete(RUN_SESSIONS.keys().next().value);
    rememberSession(run.sessionId);
    saveRunMark();                       // 标记里补上会话号：被杀之后「继续」要靠它 --resume
    if (!SESSIONS.has(init.session_id)) {
      SESSIONS.set(init.session_id, { id: init.session_id, title: message.slice(0, 60), createdAt: Date.now() });
    }
    if (model && init.model && model !== init.model) ALIAS_SEEN[model] = init.model;
    emit({
      type: "init",
      sessionId: init.session_id,
      model: init.model,
      permissionMode: init.permissionMode,
      outputStyle: init.output_style,
      version: init.claude_code_version,
    });
    publishState();
  };
  const onResult = (r) => {
    lastResult = r;
    if (run.pendingInject.length) return;
    if (!run.bgTasks) return closeInput();
    // 答完了，只是后台任务（本地服务之类）还在跑：界面上算这一轮结束，进程和 stdin 留着等任务回报
    run.idle = true;
    emit({ type: "run_idle", bg: run.bgTasks, at: Date.now() });
    publishState();
  };
  const onReplay = () => {
    // 第一条回显是本轮的原始消息；之后每条都是一条送达的插话（按写入顺序）
    if (run.replays++ === 0) return;
    const it = run.pendingInject.shift();
    if (it) emit({ type: "inject", text: it.message, cid: it.cid, itemId: it.id });
  };
  const feed = (line) => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "control_request") return onControl(ev);
    // 清单工具一出结果就推，不等 4 秒轮询
    if (ev.type === "user" && ev.tool_use_result && (ev.tool_use_result.task || ev.tool_use_result.statusChange || ev.tool_use_result.updatedFields)) setImmediate(() => tasksCheck(run.sessionId));
    if (ev.type === "control_response") return;          // 我们发的 set_permission_mode 的回执
    if (ev.type === "control_cancel_request") {           // claude 自己撤回了（比如被中断）
      if (run.perms.delete(ev.request_id)) { emit({ type: "perm_resolved", id: ev.request_id, behavior: "cancel" }); publishState(); }
      return;
    }
    // 后台任务（run_in_background 的命令、后台子代理）：result 之后它们跑完，claude 会在同一进程里接着再跑一轮。
    // 那时 stdin 要还开着，否则这一轮里所有授权请求都报「Tool permission request failed: AbortError: Stream closed」。
    // claude 有任何别的动静（开始请求、回显通知…）就不替它收尾了：之后的 result 会正常关 stdin
    if (run.idleClose && !(ev.type === "system" && ev.subtype === "background_tasks_changed")) { clearTimeout(run.idleClose); run.idleClose = null; }
    if (ev.type === "system" && ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
      run.bgTasks = ev.tasks.length;
      run.bgList = ev.tasks.slice(0, 30).map((t) => ({ id: String(t.task_id || ""), type: String(t.task_type || ""), desc: String(t.description || "").slice(0, 200) }));
      if (run.idle && run.bgTasks) emit({ type: "run_idle", bg: run.bgTasks });
      publishState();                    // 明细跟着状态走（runInfo.bgList），断线重连也补得上
      // 空闲中后台任务全没了：任务自己跑完时 claude 会接着起一轮（之后的 result 会关 stdin）；
      // 被 stop_task 停掉的只排进它的队列、不起新一轮，这一轮就永远挂着。等 6 秒没动静就收尾
      clearTimeout(run.idleClose);
      if (run.idle && !run.bgTasks) run.idleClose = setTimeout(() => { if (run.idle && !run.bgTasks && !run.ended) closeInput(); }, 6000);
    }
    // 空闲中 claude 又动起来了（后台任务回报、或用户发来的新消息）：重新算「生成中」
    if (run.idle && (ev.type === "assistant" || ev.type === "stream_event" || (ev.type === "system" && ev.subtype === "init"))) {
      run.idle = false;
      emit({ type: "run_busy", startedAt: Date.now() });
      publishState();
    }
    translate(ev, { sse: emit, flags, onInit, onResult, onReplay });
  };

  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) feed(line);
    }
  });

  child.stderr.on("data", (d) => {
    const s = d.toString("utf8");
    if (stderr.length < 20000) stderr += s;
    if (/error|Error|failed|ENOENT|EACCES/.test(s)) log(`[claude!] ${s.trim().slice(0, 300)}`);
  });

  const finish = (code) => {
    if (buf.trim()) feed(buf.trim());
    buf = "";
    run.inputOpen = false;
    run.perms.clear();                // 卡片随 run_end 一起作废（前端按 run_end 收起）
    if (run.pendingInject.length) {
      log(`插话 ${run.pendingInject.length} 条没来得及送达，退回队首`);
      QUEUE.unshift(...run.pendingInject.map((it) => ({ ...it, injected: false, held: !!run.aborted })));
      run.pendingInject = [];
    }
    const ms = Date.now() - t0;
    if (run.aborted) {
      log(`⏹ 已中断 (${ms}ms)`);
      return endRun(run, { durationMs: ms });
    }
    if (lastResult) {
      const localCmd = lastResult.local_command || null;
      log(`✔ 完成 ${ms}ms  ${lastResult.num_turns || "?"} 轮  ` +
          `上下文=${flags.contextTokens ?? "?"} out=${lastResult.usage?.output_tokens ?? "?"}  ` +
          `$${Number(lastResult.total_cost_usd || 0).toFixed(5)}${localCmd ? "  [" + localCmd + "]" : ""}`);
      noteTokens(run.provider, lastResult.usage);
      billAfterRun(run.provider);
      if (!isCmd && !lastResult.is_error && run.sessionId) idleArm(run.sessionId, flags);
      return endRun(run, {
        durationMs: ms,
        // claude 按内置的 Anthropic 价目表算账；第三方厂商的价格差得远，报出来能高一二十倍，干脆不报
        costUsd: PROVIDER.nativeModels ? Number(lastResult.total_cost_usd || 0) : 0,
        usage: lastResult.usage
          ? {
              output_tokens: lastResult.usage.output_tokens || 0,
              context_tokens: flags.contextTokens || 0,   // 真实占用（累计和不算）
              context_window: contextWindowOf(lastResult),
            }
          : null,
        subtype: lastResult.subtype,
        isError: !!lastResult.is_error,
        // 本地命令（/context /cost …）的结果正文在这里
        localCommand: localCmd,
        resultText: localCmd ? String(lastResult.result || "") : "",
      });
    }
    const hint = code !== 0 ? `生成失败（退出码 ${code}）` : "生成结束但没有返回结果";
    log(`✖ ${hint}${stderr ? " :: " + stderr.trim().slice(0, 300) : ""}`);
    emit({ type: "error", message: hint, detail: stderr.trim().slice(0, 1200) });
    endRun(run, { failed: true, durationMs: ms });
  };

  child.on("error", (e) => {
    log(`spawn 出错: ${e.message}`);
    emit({ type: "error", message: tr(LAST_LANG, tz("无法启动 claude：{err}", { err: e.message })) });
    endRun(run, { failed: true });
  });
  child.on("close", finish);
}

/** 整屏截图（PNG）。cccodroid：priv 的 stdout 是干净的二进制通道，直接收；
 *  开发端的 rish 会把输出随机拆到 stdout / stderr，二进制会坏 —— 先写到共享存储再读回来 */
async function screencap() {
  let last = "";
  for (let i = 0; i < 2; i++) {
    const r = await screencapOnce();
    // 完整的 PNG 以 IEND 块收尾；只看开头的魔数会把截断的文件当成好的（界面上就是一张坏图）
    if (r.buf && r.buf.length > 64 && r.buf.readUInt32BE(0) === 0x89504e47 && r.buf.subarray(-8, -4).toString("latin1") === "IEND") return r.buf;
    last = `${r.buf ? r.buf.length : 0} B${r.code != null ? " rc=" + r.code : ""}${r.err ? " " + r.err : ""}`;
    log(`[screenshot] 第 ${i + 1} 次不完整：${last}`);
  }
  throw new Error(tz("截屏失败（Shizuku 可用吗？设置 → Shizuku）") + " · " + last);
}
function screencapOnce() {
  return new Promise((resolve) => {
    if (PREFIX) {
      // 去掉 CCAPP_RUN：特权命令记录按这个标记认「Claude 发起的」，截屏是用户在界面上点的
      const env = claudeEnv(); delete env.CCAPP_RUN;
      const c = spawn(process.execPath, [path.join(process.env.CCAPP_BIN || HERE, "priv.mjs"), "screencap -p"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const out = [], err = [];
      c.stdout.on("data", (d) => out.push(d));
      c.stderr.on("data", (d) => err.push(d));
      const t = setTimeout(() => c.kill("SIGKILL"), 20000);
      c.on("close", (code) => { clearTimeout(t); resolve({ buf: Buffer.concat(out), code, err: Buffer.concat(err).toString().trim().slice(0, 160) }); });
      c.on("error", (e) => { clearTimeout(t); resolve({ buf: null, err: e.message }); });
      return;
    }
    const tmp = "/sdcard/Download/.ccapp-screen.png";
    execFile("priv", [`screencap -p ${tmp}`], { timeout: 20000, env: process.env }, (e) => {
      let buf = null; try { buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); } catch {}
      resolve({ buf, err: e ? e.message.slice(0, 160) : "" });
    });
  });
}

// ── Office 文档：docx / xlsx 前端自己渲染；ppt / pptx / doc / odt… 交给 LibreOffice 转成 PDF 再看 ──
// LibreOffice 不在工具包里（装好约 830 MB），第一次要看时由用户点一下用 pkg 装。
// 转出来的 PDF 按「路径 + 大小 + 修改时间」缓存在 home/.cache/office-pdf，同一份文件第二次秒开。
const OFFICE_DIR = path.join(CFG.home, ".cache", "office-pdf");
const OFFICE_KEEP = 40;
const sofficePath = () => PREFIX ? path.join(PREFIX, "bin", "soffice") : "";
const officeHave = () => { const s = sofficePath(); return !!s && fs.existsSync(s); };
const officeKey = (file, st) => crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 20);

// 文档里写的多是 Windows 字体（宋体、微软雅黑…），本机没有；不配的话 fontconfig 会挑到 Noto CJK 的日文 / 韩文字形。
// 宋体一类映射到 Noto Serif CJK SC，黑体一类映射到 Noto Sans CJK SC（安卓系统自带这两套）
function officeFonts() {
  const f = path.join(OFFICE_DIR, "fonts.conf");
  const alias = (list, to) => list.map((n) => `  <alias binding="same"><family>${n}</family><prefer><family>${to}</family></prefer></alias>`).join("\n");
  const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">${PREFIX}/etc/fonts/fonts.conf</include>
  <cachedir>${path.join(OFFICE_DIR, "fc-cache")}</cachedir>
${alias(["SimSun", "宋体", "NSimSun", "新宋体", "FangSong", "仿宋", "仿宋_GB2312", "KaiTi", "楷体", "楷体_GB2312", "STSong", "华文宋体", "STFangsong", "华文仿宋", "STKaiti", "华文楷体", "Songti SC", "方正书宋_GBK", "方正仿宋_GBK", "方正楷体_GBK", "MingLiU", "PMingLiU", "新細明體"], "Noto Serif CJK SC")}
${alias(["Microsoft YaHei", "微软雅黑", "Microsoft YaHei UI", "SimHei", "黑体", "DengXian", "等线", "PingFang SC", "STHeiti", "华文黑体", "华文细黑", "Heiti SC", "思源黑体", "Source Han Sans SC", "方正黑体_GBK", "Microsoft JhengHei", "微軟正黑體"], "Noto Sans CJK SC")}
  <alias><family>serif</family><prefer><family>Noto Serif CJK SC</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>Noto Sans CJK SC</family></prefer></alias>
  <match target="pattern"><test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="append"><string>Noto Sans CJK SC</string></edit></match>
</fontconfig>
`;
  let cur = ""; try { cur = fs.readFileSync(f, "utf8"); } catch {}
  if (cur !== xml) fs.writeFileSync(f, xml);
  return f;
}

// 一次只转一个（LibreOffice 吃内存，同一个配置目录也不能两个实例同时用）；同一份文件重复请求合并成一个
const officeJobs = new Map();
let officeQ = Promise.resolve();
function officePdf(file) {
  const st = fs.statSync(file);
  const key = officeKey(file, st), out = path.join(OFFICE_DIR, key + ".pdf");
  if (fs.existsSync(out)) { try { const n = new Date(); fs.utimesSync(out, n, n); } catch {} return Promise.resolve(out); }
  if (officeJobs.has(key)) return officeJobs.get(key);
  const job = (officeQ = officeQ.catch(() => {}).then(() => officeConvert(file, key, out)));
  officeJobs.set(key, job);
  job.finally(() => officeJobs.delete(key)).catch(() => {});
  return job;
}
function officeConvert(file, key, out) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(OFFICE_DIR, { recursive: true });
    const work = path.join(OFFICE_DIR, "work-" + key);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work);
    // 文件名可能带空格、中文、奇怪符号：先拷成固定名字再转，转出来的就是 in.pdf
    const ext = path.extname(file).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
    const src = path.join(work, "in" + ext);
    fs.copyFileSync(file, src);
    const env = { ...termEnv(), FONTCONFIG_FILE: officeFonts(), SAL_USE_VCLPLUGIN: "svp" };
    const args = ["-env:UserInstallation=file://" + path.join(OFFICE_DIR, "profile"), "--headless", "--norestore", "--nologo",
      "--convert-to", "pdf", "--outdir", work, src];
    const nice = path.join(PREFIX, "bin", "nice");
    // 经 Claude 用的那个 shell 包装起：soffice 是 #!$PREFIX/bin/sh 脚本，里面还会调别的脚本
    const argv = [ensureShell(), "-c", 'exec "$0" "$@"', ...(fs.existsSync(nice) ? [nice, "-n", "5"] : []), sofficePath(), ...args];
    const t0 = Date.now();
    const c = spawn(argv[0], argv.slice(1), { env, cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let log2 = "";
    const grab = (d) => { if (log2.length < 8192) log2 += d; };
    c.stdout.on("data", grab); c.stderr.on("data", grab);
    const timer = setTimeout(() => { try { killTree(c); } catch {} }, 4 * 60e3);
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
    c.on("close", (code) => {
      clearTimeout(timer);
      const pdf = path.join(work, "in.pdf");
      if (fs.existsSync(pdf) && fs.statSync(pdf).size > 0) {
        fs.renameSync(pdf, out);
        fs.rmSync(work, { recursive: true, force: true });
        log(`[office] ${path.basename(file)} → PDF ${Math.round((Date.now() - t0) / 100) / 10}s`);
        officePrune();
        return resolve(out);
      }
      fs.rmSync(work, { recursive: true, force: true });
      const why = log2.trim().split("\n").filter((l) => /error|fail|exception/i.test(l)).pop() || log2.trim().split("\n").pop() || "";
      log(`[office] 转换失败 rc=${code}：${log2.trim().slice(-400)}`);
      reject(new Error(tz("LibreOffice 没转出来") + (why ? "：" + why.slice(0, 200) : `（rc=${code}）`)));
    });
  });
}
function officePrune() {
  try {
    const list = fs.readdirSync(OFFICE_DIR).filter((f) => f.endsWith(".pdf"))
      .map((f) => ({ f: path.join(OFFICE_DIR, f), t: fs.statSync(path.join(OFFICE_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of list.slice(OFFICE_KEEP)) fs.rmSync(x.f, { force: true });
  } catch {}
}

// 一键安装：后台跑 pkg install libreoffice，前端轮询进度
let officeInst = null;   // { running, line, rc, at }
function officeInstall() {
  if (officeInst && officeInst.running) return officeInst;
  const pkg = path.join(process.env.CCAPP_BIN || HERE, "pkg.mjs");
  officeInst = { running: true, line: "", rc: null, at: Date.now() };
  const st = officeInst;
  const c = spawn(process.execPath, [pkg, "install", "libreoffice"], { env: termEnv(), cwd: CFG.home, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const eat = (d) => {
    tail = (tail + d.toString()).slice(-4000);
    const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) st.line = lines[lines.length - 1].slice(0, 200);
  };
  c.stdout.on("data", eat); c.stderr.on("data", eat);
  c.on("error", (e) => { st.running = false; st.rc = -1; st.line = e.message; });
  c.on("close", (code) => {
    st.running = false; st.rc = code;
    if (code === 0 && !officeHave()) st.rc = 1;
    log(`[office] 安装 LibreOffice 结束 rc=${st.rc}：${st.line}`);
  });
  return st;
}

// ── 端侧小模型：网关按需拉起 llama-server，空闲一阵自动停（模型常驻要占好几 GB 内存） ──
// 模型放 /sdcard/cccodroid/models（和 llama-cpp 组件的 llama-run 同一个目录）或 home/models。
// claude 以 --bare --tools "" 跑：内置只有聊天，提示只有七十 token 左右（完整模式两万 token，手机上光读提示就要好几分钟）。
// 实测 1.5B/3B 都撑不起工具调用（命令写成文字、读目录、选错命令），所以干活不内置；
// 想折腾的用户写 ~/.cccodroid/local-mode.json 开「自定义模式」，配法见随包装进去的 local-model-mode 技能。
const LOCAL_MODEL_DIRS = PREFIX ? ["/sdcard/cccodroid/models", path.join(CFG.home, "models")] : [];
const LLAMA_IDLE_MS = 10 * 60e3;
const LLAMA_LOG = path.join(CFG.home, ".cache", "llama-server.log");
const llamaBin = () => PREFIX ? path.join(PREFIX, "bin", "llama-server") : "";
const LL = { child: null, file: "", id: "", sig: "", gpu: false, state: "off", since: 0, lastUse: 0, err: "", run: null, loadMs: 0 };
const LOCAL_MODE_FILE = path.join(CFG.home, ".cccodroid", "local-mode.json");

/** 自定义模式的配置：{ have, ok, cfg } 或 { have, ok:false, err }。每次现读，改完下一条消息就生效 */
function localCustom() {
  let raw;
  try { raw = fs.readFileSync(LOCAL_MODE_FILE, "utf8"); } catch { return { have: false, ok: false, path: LOCAL_MODE_FILE }; }
  const bad = (err) => ({ have: true, ok: false, err, path: LOCAL_MODE_FILE });
  let j; try { j = JSON.parse(raw); } catch (e) { return bad("JSON: " + e.message); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return bad(tz("顶层要是一个对象"));
  const str = (v, max) => typeof v === "string" && v.length <= max;
  if (j.label != null && !str(j.label, 40)) return bad(tz("{k} 要是不超过 {n} 字的文本", { k: "label", n: 40 }));
  if (j.tools != null && !str(j.tools, 500)) return bad(tz("{k} 要是不超过 {n} 字的文本", { k: "tools", n: 500 }));
  if (j.systemPrompt != null && !str(j.systemPrompt, 20000)) return bad(tz("{k} 要是不超过 {n} 字的文本", { k: "systemPrompt", n: 20000 }));
  if (j.llamaArgs != null && !(Array.isArray(j.llamaArgs) && j.llamaArgs.length <= 40 && j.llamaArgs.every((x) => str(x, 300))))
    return bad(tz("llamaArgs 要是文本数组（最多 40 项）"));
  if (j.ctx != null && !(Number.isInteger(j.ctx) && j.ctx >= 512 && j.ctx <= 262144)) return bad(tz("ctx 要是 512 到 262144 之间的整数"));
  // 这几个由网关管，用户改了就接不上
  const owned = (j.llamaArgs || []).find((x) => ["-m", "--model", "--host", "--port", "-np", "--parallel"].includes(x));
  if (owned) return bad(tz("llamaArgs 里不能改 {k}（由网关管）", { k: owned }));
  return { have: true, ok: true, path: LOCAL_MODE_FILE,
    cfg: { label: j.label || tz("自定义"), tools: j.tools || "", systemPrompt: j.systemPrompt || "", llamaArgs: j.llamaArgs || [], ctx: j.ctx || 0 } };
}
/** 当前生效的自定义配置；没选自定义、文件不在或写坏了都回落聊天（返回 null） */
function localCustomActive() {
  if (SETTINGS.localMode !== "custom") return null;
  const c = localCustom();
  return c.ok ? c.cfg : null;
}
let llStarting = null;

function localModels() {
  const out = [], seen = new Set();
  for (const d of LOCAL_MODEL_DIRS) {
    let list = []; try { list = fs.readdirSync(d); } catch {}
    for (const f of list) {
      // mmproj-*.gguf 是多模态的视觉投影，不是能单独对话的模型
      if (!/\.gguf$/i.test(f) || /^mmproj/i.test(f)) continue;
      const id = f.replace(/\.gguf$/i, "");
      if (seen.has(id)) continue;
      let st; try { st = fs.statSync(path.join(d, f)); } catch { continue; }
      if (!st.isFile() || st.size < 10e6) continue;
      seen.add(id);
      out.push({ id, name: id, file: path.join(d, f), size: st.size, context_window: llamaCtx(), max_output_tokens: 0, input_modalities: ["text"], effort: null });
    }
  }
  return out.sort((a, b) => a.size - b.size);
}
function memTotalKB() { try { return Number((fs.readFileSync("/proc/meminfo", "utf8").match(/MemTotal:\s+(\d+)/) || [])[1]) || 0; } catch { return 0; } }
function memAvailKB() { try { return Number((fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/) || [])[1]) || 0; } catch { return 0; } }
// 上下文按内存给：KV 缓存随上下文线性涨（3B 模型 32k 上下文约 1.2 GB）
function llamaCtx() { const c = localCustomActive(); if (c && c.ctx) return c.ctx; const g = memTotalKB() / 1048576; return g >= 11 ? 32768 : g >= 7 ? 16384 : 8192; }
// 线程数：只用比最慢那档快的核（小核掺进来反而拖慢一倍，llama-run 实测 10.3 vs 25.0 t/s）
function llamaThreads() {
  const f = [];
  for (let i = 0; i < 16; i++) { try { f.push(Number(fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`, "utf8"))); } catch { break; } }
  if (!f.length) return 4;
  const min = Math.min(...f), fast = f.filter((x) => x > min).length;
  return Math.max(2, Math.min(8, fast || f.length));
}
// 有没有真 GPU 驱动：Vulkan 清单里除了 lavapipe（软件实现）还有别的（gpu-driver 组件装的 Turnip）
function llamaGpu() {
  for (const d of [path.join(PREFIX, "share", "vulkan", "icd.d"), path.join(PREFIX, "etc", "vulkan", "icd.d")]) {
    try { if (fs.readdirSync(d).some((f) => f.endsWith(".json") && !/lvp|lavapipe/i.test(f))) return true; } catch {}
  }
  return false;
}
async function llamaHealthy() {
  try { const r = await fetch(`http://127.0.0.1:${LLAMA_PORT}/health`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}
function llamaInfo() {
  const cust = localCustom();
  return {
    custom: { have: cust.have, ok: cust.ok, err: cust.err || "", path: cust.path, label: cust.ok ? cust.cfg.label : "",
      tools: cust.ok ? cust.cfg.tools : "", skill: LOCAL_SKILL_FILE },
    can: !!PREFIX, bin: !!PREFIX && fs.existsSync(llamaBin()), gpu: !!PREFIX && llamaGpu(),
    ctx: llamaCtx(), threads: llamaThreads(), memTotal: memTotalKB() * 1024, memAvail: memAvailKB() * 1024,
    dirs: LOCAL_MODEL_DIRS, models: localModels().map(({ id, size, file }) => ({ id, size, file })),
    mode: SETTINGS.localMode === "custom" ? "custom" : "chat",
    server: { state: LL.state, model: LL.id, since: LL.since, lastUse: LL.lastUse, err: LL.err, loadMs: LL.loadMs, idleMs: LLAMA_IDLE_MS },
  };
}

/** 确保 llama-server 跑着、载的是要的模型。note(key, text) 往当前这一轮里报进度 */
async function ensureLlama(want, note) {
  const list = localModels();
  const m = list.find((x) => x.id === want) || list[0];
  if (!m) throw new Error(tz("还没有端侧模型：把 .gguf 文件放进 {dir}", { dir: LOCAL_MODEL_DIRS[0] }));
  if (!fs.existsSync(llamaBin())) throw new Error(tz("没装 llama.cpp：到「扩展」页装 llama-cpp 组件"));
  LL.lastUse = Date.now();
  const sig = llamaPlan(m).sig;
  if (LL.child && LL.sig === sig && LL.state === "ready" && await llamaHealthy()) return m;
  if (llStarting && LL.sig === sig) { await llStarting; return m; }
  if (llStarting) { try { await llStarting; } catch {} }
  if (LL.child) llamaStop("换模型或参数");
  llStarting = llamaStart(m, note).finally(() => { llStarting = null; });
  await llStarting;
  return m;
}
/** 这次该用什么参数起服务。sig 不同（换模型、换模式、GPU 回退）就得重启 */
function llamaPlan(m) {
  const gpu = llamaGpu(), ctx = llamaCtx();
  const cust = localCustomActive();
  // -np 1：只开一个槽，KV 缓存不被四等分（默认 4 槽，每槽只剩四分之一上下文）；
  // --cache-reuse：同一段提示前缀第二轮起直接复用，不再从头读。自定义参数放最后，同名参数以它为准
  const args = ["-m", m.file, "--host", "127.0.0.1", "--port", String(LLAMA_PORT), "-c", String(ctx), "-np", "1",
    "-t", String(llamaThreads()), "--jinja", "--cache-reuse", "256", "--no-webui",
    ...(gpu ? ["-ngl", "99"] : ["-dev", "none"]), ...(cust ? cust.llamaArgs : [])];
  return { gpu, ctx, args, sig: JSON.stringify(args) };
}
function llamaStart(m, note) {
  return new Promise((resolve, reject) => {
    const { gpu, ctx, args, sig } = llamaPlan(m);
    fs.mkdirSync(path.dirname(LLAMA_LOG), { recursive: true });
    const logFd = fs.openSync(LLAMA_LOG, "w");
    const argv = [ensureShell(), "-c", 'exec "$0" "$@"', llamaBin(), ...args];
    log(`[local] 启动 llama-server：${m.id}（${gpu ? "GPU" : "CPU"}，上下文 ${ctx}）`);
    note && note("load", tz("正在加载端侧模型 {name}（{how}）…", { name: m.id, how: gpu ? "GPU" : "CPU" }));
    const c = spawn(argv[0], argv.slice(1), { env: termEnv(), cwd: CFG.home, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    Object.assign(LL, { child: c, file: m.file, id: m.id, sig, gpu, state: "loading", since: Date.now(), err: "", loadMs: 0 });
    let tail = "", lastNote = 0;
    const eat = (d) => {
      try { fs.writeSync(logFd, d); } catch {}
      tail = (tail + d).slice(-6000);
      // 读提示的进度（llama-server 每读一批打一行 progress = 0.41）报给当前这一轮：首字前别让人干等
      const s = String(d), mm = s.match(/prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+)/g);
      if (mm && LL.run && !LL.run.ended && Date.now() - lastNote > 1500) {
        const last = mm[mm.length - 1].match(/n_tokens =\s*(\d+), progress = ([\d.]+)/);
        const pct = Math.round(Number(last[2]) * 100);
        lastNote = Date.now();
        runEmit(LL.run, { type: "note", key: "prefill", text: tz("端侧模型正在读提示：{pct}%", { pct }) });
      }
    };
    c.stdout.on("data", eat); c.stderr.on("data", eat);
    let done = false;
    const fail = (msg) => { if (done) return; done = true; LL.state = "error"; LL.err = msg; reject(new Error(msg)); };
    c.on("error", (e) => fail(e.message));
    c.on("close", (code) => {
      try { fs.closeSync(logFd); } catch {}
      const ours = LL.child === c, wasReady = LL.state === "ready";     // ours：不是网关自己停的（llamaStop 会先把 child 清掉）
      if (ours) Object.assign(LL, { child: null, state: LL.state === "error" ? "error" : "off" });
      log(`[local] llama-server 退出 rc=${code}`);
      // 跑着跑着崩了（大模型在 GPU 上可能 vk::DeviceLostError）：只报出来，不替用户改走 CPU —— 想换用 llamaArgs 自己配
      if (ours && wasReady) {
        const why = tail.split("\n").filter((l) => /error|failed|DeviceLost|out of memory/i.test(l)).pop() || "";
        Object.assign(LL, { state: "error", err: tz("llama-server 意外退出（rc={code}）", { code }) + (why ? "：" + why.trim().slice(0, 200) : "") });
        if (LL.run && !LL.run.ended) runEmit(LL.run, { type: "note", key: "crash", text: LL.err });
      }
      const why = tail.split("\n").filter((l) => /error|failed|out of memory|unable/i.test(l)).pop() || "";
      fail(tz("端侧模型没起来") + (why ? "：" + why.trim().slice(0, 200) : `（rc=${code}）`));
    });
    const t0 = Date.now();
    (async () => {
      while (!done && Date.now() - t0 < 240e3) {
        await new Promise((r) => setTimeout(r, 500));
        if (done) return;
        if (await llamaHealthy()) {
          done = true;
          Object.assign(LL, { state: "ready", loadMs: Date.now() - t0, lastUse: Date.now() });
          log(`[local] 模型已加载 ${m.id}（${Math.round(LL.loadMs / 100) / 10}s）`);
          note && note("load", tz("端侧模型已加载（{s} 秒）", { s: Math.round(LL.loadMs / 100) / 10 }));
          return resolve();
        }
      }
      if (!done) { try { killTree(c); } catch {} fail(tz("端侧模型加载超时")); }
    })();
  });
}
function llamaStop(why) {
  const c = LL.child;
  if (!c) return;
  log(`[local] 停 llama-server（${why}）`);
  Object.assign(LL, { child: null, state: "off", run: null });
  try { killTree(c); } catch {}
}
// 空闲自动停：没有在跑的会话、十分钟没用过，就把模型卸掉还内存
if (PREFIX) setInterval(() => {
  if (!LL.child) return;
  if (RUNS.size) { LL.lastUse = Date.now(); return; }
  if (Date.now() - LL.lastUse > LLAMA_IDLE_MS) llamaStop("空闲");
}, 60e3).unref?.();

// ── 端侧模型下载：内置目录（llama.cpp 能跑的主流开源模型，Q4_K_M 量化，sha256 取自 HuggingFace LFS 记录），curl 断点续传 ──
// 源：ms=1 的（Qwen 官方仓库）先走魔搭；都会试 HuggingFace 和 hf-mirror.com。超过 6B 的下载前提醒一句，不拦。
// 目录外的模型：贴 .gguf 直链下载（不知道哈希，只核对 GGUF 文件头）。
// tag：think = 会先输出思考过程；code = 偏写代码
const LOCAL_CATALOG = [
  { fam: "Qwen3", params: 0.6, repo: "bartowski/Qwen_Qwen3-0.6B-GGUF", file: "Qwen_Qwen3-0.6B-Q4_K_M.gguf", bytes: 484220320,
    sha256: "9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14", tag: "think" },
  { fam: "Qwen3", params: 1.7, repo: "bartowski/Qwen_Qwen3-1.7B-GGUF", file: "Qwen_Qwen3-1.7B-Q4_K_M.gguf", bytes: 1282439584,
    sha256: "72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb", tag: "think" },
  { fam: "Qwen3", params: 4, repo: "Qwen/Qwen3-4B-GGUF", file: "Qwen3-4B-Q4_K_M.gguf", bytes: 2497280256,
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5", tag: "think", ms: 1 },
  { fam: "Qwen3", params: 8.2, repo: "Qwen/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf", bytes: 5027783488,
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785", tag: "think", ms: 1 },
  { fam: "Qwen3", params: 14.8, repo: "Qwen/Qwen3-14B-GGUF", file: "Qwen3-14B-Q4_K_M.gguf", bytes: 9001752960,
    sha256: "500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0", tag: "think", ms: 1 },
  { fam: "Qwen2.5", params: 0.5, repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", file: "qwen2.5-0.5b-instruct-q4_k_m.gguf", bytes: 491400032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db", ms: 1 },
  { fam: "Qwen2.5", params: 1.5, repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF", file: "qwen2.5-1.5b-instruct-q4_k_m.gguf", bytes: 1117320736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", ms: 1 },
  { fam: "Qwen2.5", params: 3.1, repo: "Qwen/Qwen2.5-3B-Instruct-GGUF", file: "qwen2.5-3b-instruct-q4_k_m.gguf", bytes: 2104932768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d", ms: 1 },
  { fam: "Qwen2.5", params: 7.6, repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf", bytes: 4683074240,
    sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423" },
  { fam: "Qwen2.5", params: 14.8, repo: "bartowski/Qwen2.5-14B-Instruct-GGUF", file: "Qwen2.5-14B-Instruct-Q4_K_M.gguf", bytes: 8988110976,
    sha256: "e47ad95dad6ff848b431053b375adb5d39321290ea2c638682577dafca87c008" },
  { fam: "Qwen2.5 Coder", params: 1.5, repo: "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF", file: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf", bytes: 986048800,
    sha256: "f530705d447660a4336c329981af164b471b60b974b1d808d57e8ec9fe23b239", tag: "code" },
  { fam: "Qwen2.5 Coder", params: 7.6, repo: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf", bytes: 4683074336,
    sha256: "1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6", tag: "code" },
  { fam: "DeepSeek-R1 Distill", params: 1.8, repo: "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF", file: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf", bytes: 1117320800,
    sha256: "1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f", tag: "think" },
  { fam: "DeepSeek-R1 Distill", params: 7.6, repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF", file: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf", bytes: 4683073504,
    sha256: "731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b", tag: "think" },
  { fam: "Llama 3", params: 1.2, repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", bytes: 807694464,
    sha256: "6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83" },
  { fam: "Llama 3", params: 3.2, repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", bytes: 2019377696,
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff" },
  { fam: "Llama 3", params: 8, repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf", bytes: 4920739232,
    sha256: "7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c" },
  { fam: "Gemma 3", params: 1, repo: "bartowski/google_gemma-3-1b-it-GGUF", file: "google_gemma-3-1b-it-Q4_K_M.gguf", bytes: 806058496,
    sha256: "12bf0fff8815d5f73a3c9b586bd8fee8e7b248c935de70dec367679873d0f29d" },
  { fam: "Gemma 3", params: 4, repo: "bartowski/google_gemma-3-4b-it-GGUF", file: "google_gemma-3-4b-it-Q4_K_M.gguf", bytes: 2489758112,
    sha256: "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94" },
  { fam: "Gemma 3", params: 12, repo: "bartowski/google_gemma-3-12b-it-GGUF", file: "google_gemma-3-12b-it-Q4_K_M.gguf", bytes: 7300575264,
    sha256: "fc57f67efa46d711c346e587cbef7d049e95f3df8db2eb2271153343ef0acc7b" },
  { fam: "Phi-4", params: 3.8, repo: "bartowski/microsoft_Phi-4-mini-instruct-GGUF", file: "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf", bytes: 2491874688,
    sha256: "01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2" },
  { fam: "Phi-4", params: 14.7, repo: "bartowski/phi-4-GGUF", file: "phi-4-Q4_K_M.gguf", bytes: 9053114816,
    sha256: "009aba717c09d4a35890c7d35eb59d54e1dba884c7c526e7197d9c13ab5911d9" },
  { fam: "Mistral", params: 7.2, repo: "bartowski/Mistral-7B-Instruct-v0.3-GGUF", file: "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf", bytes: 4372812000,
    sha256: "1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6" },
  { fam: "GLM-4", params: 9.4, repo: "bartowski/THUDM_GLM-4-9B-0414-GGUF", file: "THUDM_GLM-4-9B-0414-Q4_K_M.gguf", bytes: 6166574464,
    sha256: "2b95f0b88eca423bfb874c4f8e7b9574ec76acab2befd272076e8a8dce31216a" },
  { fam: "Granite", params: 2.5, repo: "bartowski/ibm-granite_granite-3.3-2b-instruct-GGUF", file: "ibm-granite_granite-3.3-2b-instruct-Q4_K_M.gguf", bytes: 1545303616,
    sha256: "555b91485955bc96eb445b57dd4bbf8809aa7d8cce7c313f4f8bc5b2340896b4" },
  { fam: "SmolLM2", params: 1.7, repo: "bartowski/SmolLM2-1.7B-Instruct-GGUF", file: "SmolLM2-1.7B-Instruct-Q4_K_M.gguf", bytes: 1055609824,
    sha256: "77665ea4815999596525c636fbeb56ba8b080b46ae85efef4f0d986a139834d7" },
].map((e) => ({ ...e, id: e.file.replace(/\.gguf$/i, "") }));
// 模型目录：优先用组件签名索引里 llama-cpp 带的 models（组件市场 recipes/llama-cpp/models.json，改目录不用发 App）；
// 索引没取到、没这个字段或有一条不合格，就用上面内置的这份。repo / file 拿来拼下载地址，规则和市场的 tools/lib.mjs 一致
const MODEL_OK = (m) => m && typeof m === "object" && typeof m.fam === "string" && /^[\w .+-]{1,40}$/.test(m.fam) &&
  typeof m.params === "number" && m.params > 0 && m.params < 1000 &&
  typeof m.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repo) &&
  typeof m.file === "string" && /^[A-Za-z0-9_.-]+\.gguf$/i.test(m.file) &&
  Number.isInteger(m.bytes) && m.bytes > 0 && typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) &&
  (m.tag === undefined || m.tag === "think" || m.tag === "code") && (m.ms === undefined || m.ms === 1);
function modelCatalog() {
  const list = compIndexCache.data && compIndexCache.data.components["llama-cpp"] && compIndexCache.data.components["llama-cpp"].models;
  if (Array.isArray(list) && list.length && list.length <= 100 && list.every(MODEL_OK))
    return list.map((m) => ({ fam: m.fam, params: m.params, repo: m.repo, file: m.file, bytes: m.bytes, sha256: m.sha256, tag: m.tag, ms: m.ms, id: m.file.replace(/\.gguf$/i, "") }));
  return LOCAL_CATALOG;
}
const modelUrls = (e) => [
  ...(e.ms ? [`https://modelscope.cn/models/${e.repo}/resolve/master/${e.file}`] : []),
  `https://huggingface.co/${e.repo}/resolve/main/${e.file}`,
  `https://hf-mirror.com/${e.repo}/resolve/main/${e.file}`,
];
const MDL = new Map();     // id → { phase: downloading|verifying|error, done, total, err, cancelled, child }

/** 模型下到哪：优先共享目录（和 llama-run 一处），写不进就放 home/models */
function modelDir() {
  for (const d of LOCAL_MODEL_DIRS) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch {}
  }
  throw new Error(tz("模型目录写不进去"));
}
function localCatalog() {
  const have = new Map(localModels().map((m) => [m.id, m]));
  const inUse = (h) => !!(h && LL.child && LL.file === h.file);
  const jobView = (j) => j ? { phase: j.phase, done: j.done, total: j.total, err: j.err || "" } : null;
  const items = modelCatalog().map((e) => {
    const h = have.get(e.id);
    return { id: e.id, fam: e.fam, params: e.params, tag: e.tag || "", bytes: e.bytes, repo: e.repo,
      have: !!h, inUse: inUse(h), job: jobView(MDL.get(e.id)) };
  });
  // 贴链接下载的：进行中 / 失败的任务也列出来
  for (const [id, j] of MDL) if (j.url) items.push({ id, fam: "", params: 0, tag: "", bytes: j.total, repo: j.url, custom: true, have: false, inUse: false, job: jobView(j) });
  return { ram: Math.round(memTotalKB() / 104857.6) / 10, big: 6, items };
}
/** 下载一个模型。e：{ id, file, bytes?, sha256?, url? }；没有 sha256 的只核对 GGUF 文件头 */
function modelFetch(e, urls) {
  const cur = MDL.get(e.id);
  if (cur && cur.phase !== "error") return;
  const dir = modelDir(), dst = path.join(dir, e.id + ".gguf"), part = dst + ".part";
  if (fs.existsSync(dst)) throw new Error(tz("已经有同名模型了"));
  const job = { phase: "downloading", done: 0, total: e.bytes || 0, err: "", cancelled: false, child: null, url: e.url || "" };
  MDL.set(e.id, job);
  const tick = setInterval(() => { if (job.phase === "downloading") { try { job.done = fs.statSync(part).size; } catch {} } }, 500);
  (async () => {
    try {
      let lastErr = null;
      for (const url of urls) {
        for (let i = 0; i < 3 && !job.cancelled; i++) {
          try {
            await compRun(job, path.join(PREFIX, "bin", "curl"), ["-fL", "-sS", "-C", "-", "--retry", "3", "--speed-limit", "20000", "--speed-time", "60", "-o", part, url]);
            lastErr = null; break;
          } catch (er) { lastErr = er; }
          // 下全了没改名（续传回 416）：直接去校验
          let n = 0; try { n = fs.statSync(part).size; } catch {}
          if (e.bytes && n === e.bytes) { lastErr = null; break; }
          if (/ 22：|404|403|401/.test(lastErr.message)) break;    // 这个源没有这个文件：别重试，换源
        }
        if (!lastErr || job.cancelled) break;
        log(`[local] 模型下载换源：${lastErr.message}`);
      }
      if (job.cancelled) throw new Error("cancelled");
      if (lastErr) throw lastErr;
      job.phase = "verifying"; job.done = 0;
      if (e.sha256) {
        if ((await sha256File(part, job)) !== e.sha256) { fs.rmSync(part, { force: true }); throw new Error(tz("下载的文件校验不符（已删除，重试会重新下载）")); }
      } else {
        const fd = fs.openSync(part, "r"), head = Buffer.alloc(4);
        try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (head.toString("latin1") !== "GGUF") { fs.rmSync(part, { force: true }); throw new Error(tz("下下来的不是 GGUF 模型文件（已删除）")); }
      }
      fs.renameSync(part, dst);
      MDL.delete(e.id);
      MODELS_AT = 0;
      log(`[local] 模型已下载 ${e.id}`);
    } catch (er) {
      if (job.cancelled) { MDL.delete(e.id); try { fs.rmSync(part, { force: true }); } catch {} return; }
      Object.assign(job, { phase: "error", err: er.message });
      log(`[local] 模型下载失败 ${e.id}：${er.message}`);
    } finally { clearInterval(tick); }
  })();
}
function modelDownload(id) {
  const e = modelCatalog().find((x) => x.id === id);
  if (e) return modelFetch(e, modelUrls(e));
  const j = MDL.get(id);
  if (j && j.url) return modelFetch({ id, url: j.url }, [j.url]);     // 贴链接下载的重试
  throw new Error(tz("目录里没有这个模型"));
}
/** 贴 .gguf 直链下载：只认 https，文件名只留安全字符 */
function modelFromUrl(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch { throw new Error(tz("链接不对")); }
  if (u.protocol !== "https:") throw new Error(tz("只支持 https 链接"));
  // HuggingFace 的 blob 页面换成真正的下载地址
  if (/(^|\.)(huggingface\.co|hf-mirror\.com)$/.test(u.hostname)) u.pathname = u.pathname.replace("/blob/", "/resolve/");
  const name = decodeURIComponent(u.pathname.split("/").pop() || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}\.gguf$/i.test(name)) throw new Error(tz("链接要指向一个 .gguf 文件"));
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(name)) throw new Error(tz("分卷模型（…-00001-of-0000N.gguf）不支持，请找单文件版本"));
  if (/^mmproj/i.test(name)) throw new Error(tz("mmproj 是多模态投影文件，不能单独对话"));
  const id = name.replace(/\.gguf$/i, "");
  MDL.delete(id);
  return modelFetch({ id, url: u.href }, [u.href]);
}
function modelCancel(id) {
  const j = MDL.get(id);
  if (!j) return;
  if (j.phase === "error") return MDL.delete(id);
  j.cancelled = true;
  if (j.child) { try { killTree(j.child); } catch {} }
}
/** 删模型：只删模型目录里的 .gguf；正在用就先卸载 */
function modelRemove(id) {
  const m = localModels().find((x) => x.id === id);
  if (!m) throw new Error(tz("没有这个模型"));
  if (!LOCAL_MODEL_DIRS.includes(path.dirname(m.file))) throw new Error(tz("不在模型目录里"));
  if (LL.child && LL.file === m.file) llamaStop("删除模型");
  fs.rmSync(m.file, { force: true });
  MODELS_AT = 0;
}

// 配自定义模式的技能：随包带着，启动时装进 ~/.claude/skills（云端 Claude 读它帮用户配）。
// 装过的文件里还留着托管标记才覆盖更新；用户删了标记就当是他自己的版本，不动
const LOCAL_SKILL_FILE = path.join(CFG.home, ".claude", "skills", "local-model-mode", "SKILL.md");
function installLocalSkill() {
  try {
    const src = fs.readFileSync(path.join(HERE, "web", "skills", "local-model-mode", "SKILL.md"), "utf8");
    let cur = null; try { cur = fs.readFileSync(LOCAL_SKILL_FILE, "utf8"); } catch {}
    if (cur === src || (cur != null && !cur.includes("cccodroid:managed"))) return;
    fs.mkdirSync(path.dirname(LOCAL_SKILL_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_SKILL_FILE, src);
    log("[local] 已装 local-model-mode 技能");
  } catch (e) { log(`[local] 技能没装上：${e.message}`); }
}
if (PREFIX) installLocalSkill();

/** 把应用界面叫回前台。cccodroid 由 App 进程做（Shizuku 或通知）；开发端直接 priv am start */
function toFront(text) {
  if (PREFIX) return privCall({ op: "to_front", text }, 8000);
  return new Promise((ok) => execFile("priv", ["am start --activity-reorder-to-front -n li.dsh.claudecli/.MainActivity"],
    { timeout: 8000, env: process.env }, (e) => ok(e ? { message: e.message.slice(0, 120) } : { via: "priv" })));
}

// ── 本应用耗电统计（设置页「耗电」卡）──────────────────────────────────────────
// 应用身份能直接量的只有自己进程的 CPU 时间（/proc/<pid>/stat，同 uid 的进程才看得见）；
// 电量、充电、亮屏和前台时长由 Java（Battery.java，经 Priv 套接字 op=battery）给，开发端没有这一层就只记 CPU。
// 每 5 分钟采一次，按「小时」「天」两级桶存（8 天 / 120 天），周由天现算。
// 系统自己的估算（dumpsys batterystats，按电源模型折成 mAh）要 Shizuku，只在用户点了才查一次 —— 那条命令本身就不轻。
const ENERGY_FILE = path.join(CFG.home, ".cache", "ccapp-energy.json");
const ENERGY_STEP = 5 * 60e3, ENERGY_HOUR = 3600e3;
const energy = { v: 1, last: null, hours: {}, days: {}, levels: [], sys: null };
try { Object.assign(energy, JSON.parse(fs.readFileSync(ENERGY_FILE, "utf8"))); } catch {}
const MY_UID = process.getuid();
const CLK_TCK = 100;   // 安卓内核一律 100

/** 本 uid 所有进程：pid → [启动时刻(tick), 自身+已回收子进程的 CPU(tick), ppid] */
function energyProcs() {
  const pids = {};
  let total = 0;
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.statSync("/proc/" + d).uid !== MY_UID) continue;
      const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
      const v = +f[11] + +f[12] + +f[13] + +f[14];   // utime stime cutime cstime
      pids[d] = [+f[19], v, +f[1]];
      total += v;
    } catch {}
  }
  return { pids, total };
}

const energyDayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const energyHourStart = (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };

/** 把一段时间 [a, b) 里的量按时长摊进各小时桶和天桶 */
function energySpread(a, b, add) {
  if (!(b > a)) return;
  for (let t = a; t < b;) {
    const h = energyHourStart(t), end = Math.min(b, h + ENERGY_HOUR), frac = (end - t) / (b - a);
    for (const box of [energy.hours[h] ||= {}, energy.days[energyDayKey(t)] ||= {}]) {
      for (const [k, v] of Object.entries(add)) if (v) box[k] = Math.round(((box[k] || 0) + v * frac) * 1000) / 1000;
    }
    t = end;
  }
}

async function energySample() {
  const now = Date.now();
  const cur = energyProcs();
  const bat = PREFIX ? await privCall({ op: "battery" }, 5000) : null;
  const prev = energy.last;
  if (prev) {
    // CPU 增量：活着的进程看差值；退出的进程时间会并进父进程的 cutime（父进程也是我们的，就已经在 total 里），
    // 父进程不在了（被 init 收养）它的时间就跟着消失，要补回来
    let d = cur.total - prev.total;
    for (const [pid, [start, v, ppid]] of Object.entries(prev.pids || {})) {
      const n = cur.pids[pid];
      if (n && n[0] === start) continue;
      const par = cur.pids[ppid], parPrev = (prev.pids || {})[ppid];
      if (!par || !parPrev || par[0] !== parPrev[0]) d += v;
    }
    // 中间断了很久（网关没跑 / 关机）：只摊到现存最老的进程起来以后
    let from = prev.ts;
    if (now - prev.ts > 2 * ENERGY_STEP) {
      try {
        const up = parseFloat(fs.readFileSync("/proc/uptime", "utf8")) * 1000, boot = now - up;
        const oldest = Math.min(...Object.values(cur.pids).map((x) => x[0])) * (1000 / CLK_TCK) + boot;
        if (oldest > from) from = Math.min(oldest, now - 1000);
      } catch {}
    }
    const add = { c: Math.max(0, d) / CLK_TCK };
    if (bat && bat.ok && prev.bat) {
      const df = (o, k) => (o[k] >= prev.bat[k] ? o[k] - prev.bat[k] : o[k]) / 1000;   // 变小 = 应用进程重启过，从零数
      add.f = df(bat, "fgMs");
      add.s = df(bat, "screenMs");
      // 整机掉电（百分点）：两头都没在充电才算
      if (!bat.charging && !prev.bat.charging && bat.level >= 0 && prev.bat.level > bat.level) add.d = prev.bat.level - bat.level;
    }
    energySpread(from, now, add);
  }
  energy.last = { ts: now, total: cur.total, pids: cur.pids, bat: bat && bat.ok ? { fgMs: bat.fgMs, screenMs: bat.screenMs, level: bat.level, charging: bat.charging } : null };
  if (bat && bat.ok && bat.level >= 0) energy.levels.push([now, Math.round(bat.level * 10) / 10, bat.charging ? 1 : 0]);
  // 修剪：小时桶 8 天、天桶 120 天、电量曲线 26 小时
  const hCut = now - 8 * 86400e3, dCut = energyDayKey(now - 120 * 86400e3), lCut = now - 26 * ENERGY_HOUR;
  for (const k of Object.keys(energy.hours)) if (+k < hCut) delete energy.hours[k];
  for (const k of Object.keys(energy.days)) if (k < dCut) delete energy.days[k];
  while (energy.levels.length && energy.levels[0][0] < lCut) energy.levels.shift();
  try {
    fs.mkdirSync(path.dirname(ENERGY_FILE), { recursive: true });
    fs.writeFileSync(ENERGY_FILE + ".tmp", JSON.stringify(energy));
    fs.renameSync(ENERGY_FILE + ".tmp", ENERGY_FILE);
  } catch {}
  return bat;
}
let energyBusy = null;
const energySampleOnce = () => (energyBusy ||= energySample().finally(() => { energyBusy = null; }));
setTimeout(() => energySampleOnce().catch(() => {}), 20e3).unref();
setInterval(() => energySampleOnce().catch(() => {}), ENERGY_STEP).unref();

/** 给设置页：view = hour（近 24 小时）/ day（近 14 天）/ week（近 12 周，周一起） */
async function energyReport(view) {
  const bat = await energySampleOnce().catch(() => null);
  const now = Date.now(), bars = [];
  const sum = (to, o) => { for (const k of ["c", "f", "s", "d"]) to[k] = (to[k] || 0) + (o[k] || 0); return to; };
  if (view === "day" || view === "week") {
    const n = view === "day" ? 14 : 12, d0 = new Date(now); d0.setHours(12, 0, 0, 0);
    if (view === "week") d0.setDate(d0.getDate() - ((d0.getDay() + 6) % 7));   // 本周一
    for (let i = n - 1; i >= 0; i--) {
      const s = new Date(d0); s.setDate(s.getDate() - i * (view === "day" ? 1 : 7));
      const b = { t: energyDayKey(s.getTime()) };
      for (let j = 0; j < (view === "day" ? 1 : 7); j++) {
        const x = new Date(s); x.setDate(x.getDate() + j);
        const o = energy.days[energyDayKey(x.getTime())];
        if (o) sum(b, o);
      }
      bars.push(b);
    }
  } else {
    const h0 = energyHourStart(now);
    for (let i = 23; i >= 0; i--) {
      const h = h0 - i * ENERGY_HOUR;   // 夏令时那天会有一格错位，不影响看趋势
      bars.push(sum({ t: h }, energy.hours[h] || {}));
    }
  }
  const first = Math.min(...Object.keys(energy.hours).map(Number), now);
  return {
    ok: true, view, now, bars, since: first,
    levels: view === "hour" || !view ? energy.levels.filter((l) => l[0] >= now - 24 * ENERGY_HOUR) : [],
    battery: bat && bat.ok ? { level: bat.level, charging: bat.charging, currentUa: bat.currentUa, temp: bat.temp, screen: bat.screen } : null,
    native: !!PREFIX, sys: energy.sys,
  };
}

/** 系统自己的账（dumpsys batterystats --checkin，自上次充满起）：本应用折算多少 mAh、在所有应用里排第几 */
function energySystem() {
  return new Promise((resolve) => {
    // 两路输出并成一路：开发端的 priv（rish）在没有终端时会把一部分 stdout 吐到 stderr，分开收就是两半残缺的行
    execFile("sh", ["-c", "priv \"dumpsys batterystats --checkin\" 2>&1 </dev/null"], { env: { ...process.env, PATH: claudeEnv().PATH }, timeout: 60000, maxBuffer: 32 << 20 }, (err, out, errOut) => {
      if (!out || !out.includes(",l,pwi,")) return resolve({ ok: false, message: (errOut || (err && err.message) || tz("没拿到数据")).trim().slice(0, 300) });
      const apps = {}, names = {};
      let cap = 0, used = 0, since = 0, me = null;
      for (const line of out.split("\n")) {
        const f = line.split(",");
        if (f[0] !== "9") continue;
        const uid = +f[1];
        if (f[2] === "i" && f[3] === "uid") (names[f[4]] ||= f[5]);
        if (f[2] !== "l") continue;
        if (f[3] === "pwi" && f[4] === "uid" && uid >= 10000) apps[uid] = { mah: +f[5], screen: +f[7] || 0 };
        else if (f[3] === "pws") { cap = +f[4]; used = +f[5]; }
        else if (f[3] === "bt" && uid === 0) since = +f[3 + 2] || 0;
        else if (f[3] === "cpu" && uid === MY_UID) (apps[uid] ||= { mah: 0, screen: 0 }).cpuMs = +f[4] + +f[5];
        else if (f[3] === "fg" && uid === MY_UID) (apps[uid] ||= { mah: 0, screen: 0 }).fgMs = +f[4];
      }
      const rank = Object.entries(apps).sort((a, b) => b[1].mah - a[1].mah);
      const i = rank.findIndex(([u]) => +u === MY_UID);
      if (i >= 0) me = { ...apps[MY_UID], rank: i + 1 };
      energy.sys = {
        at: Date.now(), cap, used, sinceMs: since, me,
        apps: rank.length, top: rank.slice(0, 5).map(([u, a]) => ({ name: names[u] || "uid " + u, mah: a.mah, me: +u === MY_UID })),
      };
      try { fs.writeFileSync(ENERGY_FILE, JSON.stringify(energy)); } catch {}
      resolve({ ok: true, sys: energy.sys });
    });
  });
}

/** 问应用进程里的提权中转（Priv.java）。只在 cccodroid 布局下存在 */
/** 内存管家：跑 cc-mem 拿 JSON。cccodroid 里它和网关同在 app/bin；开发端在 files/opt/ccmem */
function ccMem(args, timeoutMs = 90000) {
  const bin = [path.join(HERE, "bin", "cc-mem.mjs"), path.join(CFG.home, "..", "opt", "ccmem", "cc-mem.mjs")].find((f) => fs.existsSync(f));
  if (!bin) return Promise.resolve({ ok: false, message: tz("找不到 cc-mem") });
  const env = claudeEnv();
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE)_/.test(k)) delete env[k];
  env.CCAPP_HOME = CFG.home;
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env, timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, out, errOut) => {
      try { return resolve({ ok: true, ...JSON.parse(out) }); } catch {}
      resolve({ ok: false, message: (errOut || out || (err && err.message) || "").trim().slice(0, 400) });
    });
  });
}

function privCall(req, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!PREFIX) {
      if (req.op === "status") return devPrivStatus().then(resolve);
      return resolve({ ok: false, state: "unsupported", message: tz("开发端的 Shizuku 由 Shizuku 应用自己管理（priv 走 rish）") });
    }
    const s = net.connect({ path: "\0cc.codroid.priv" }, () => s.write(JSON.stringify(req) + "\n"));
    let buf = "";
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, message: tz("超时") }); }, timeoutMs);
    s.on("data", (d) => (buf += d));
    s.on("end", () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, message: buf.slice(0, 200) }); } });
    s.on("error", (e) => { clearTimeout(t); resolve({ ok: false, state: "unreachable", message: e.message }); });
  });
}

// ── 开发端（非 cccodroid 布局）：没有 Java 那一层，更新和 Shizuku 状态由网关自己做 ──────────
// cccodroid 里这些在 App 进程（Updater / ShizukuSetup）；开发端只有一个 runtime/claude 二进制，priv 走 rish。

const DEV_UPD_FILE = path.join(CFG.home, "ccapp-update.json");
const CC_BASE = "https://downloads.claude.ai/claude-code-releases";
const devUpd = {
  auto: true, channel: "stable", lastCheck: 0, checking: false, error: "",
  claude: { id: "claude", name: "Claude Code", current: "", latest: "", state: "unknown", message: "", done: 0, total: 0 },
};
try { Object.assign(devUpd, JSON.parse(fs.readFileSync(DEV_UPD_FILE, "utf8")), { checking: false, error: "" }); devUpd.claude.state = devUpd.claude.state === "installing" ? "unknown" : devUpd.claude.state; } catch {}
const devUpdSave = () => { try { fs.writeFileSync(DEV_UPD_FILE, JSON.stringify(devUpd)); } catch {} };
const cmpVer = (a, b) => {
  const x = String(a).split(/[^0-9]+/).map(Number), y = String(b).split(/[^0-9]+/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};

/** 跑某个 claude 二进制的 --version（新下载的那个在换上去之前先这样试跑一次） */
function claudeVersionOf(bin) {
  return new Promise((ok) => {
    const pre = PATHS.preload && fs.existsSync(PATHS.preload) ? ["--preload", PATHS.preload] : [];
    execFile(PATHS.loader, ["--library-path", PATHS.glibcLib, ...pre, bin, "--version"], { timeout: 30000 }, (e, out) => {
      const m = String(out || "").match(/\d+\.\d+\.\d+/);
      ok(m ? m[0] : "");
    });
  });
}

async function devUpdCheck() {
  if (devUpd.checking) return;
  devUpd.checking = true; devUpd.error = "";
  const c = devUpd.claude;
  try {
    if (!c.current || c.state !== "installing") c.current = await claudeVersionOf(PATHS.claude);
    const r = await fetch(`${CC_BASE}/${devUpd.channel}`, { signal: AbortSignal.timeout(20000) });
    const v = (await r.text()).trim();
    if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(tz("版本号不对：{v}", { v: v.slice(0, 40) }));
    c.latest = v;
    // 已装版本要和所选渠道「一致」：从 latest 切回 stable 时版本号变小，以前判成「已是最新」就一直停在 latest 上
    if (c.state !== "installing") {
      const d = cmpVer(v, c.current);
      c.state = d === 0 ? "uptodate" : "available";
      c.message = d < 0 && c.current ? `切回 ${devUpd.channel} 渠道：将换成 ${v}（比当前的 ${c.current} 旧）` : devUpd.channel === "latest" ? "latest 渠道" : "";
    }
    devUpd.lastCheck = Date.now();
  } catch (e) { devUpd.error = tz("连不上 downloads.claude.ai：{err}", { err: e.message }); }
  finally { devUpd.checking = false; devUpdSave(); }
}

/**
 * 换新版：下到 claude.part（断点续传）→ 按官方清单核 sha256 → 试跑 --version → 旧的改名 claude.prev（留一版可回退）→ 新的换上。
 * 正在跑的 claude 已经映射了旧文件，换名不影响它；下一轮对话起用新版。
 */
async function devUpdInstall() {
  const c = devUpd.claude;
  if (c.state === "installing" || !c.latest) return;
  c.state = "installing"; c.message = ""; c.done = 0; c.total = 0;
  const part = PATHS.claude + ".part", tag = PATHS.claude + ".part.sha256";
  try {
    const man = await (await fetch(`${CC_BASE}/${c.latest}/manifest.json`, { signal: AbortSignal.timeout(20000) })).json();
    const plat = man.platforms && man.platforms["linux-arm64"];
    if (!plat || !/^[a-f0-9]{64}$/.test(plat.checksum)) throw new Error(tz("清单里没有 linux-arm64"));
    c.total = plat.size;
    let have = 0;
    try { if (fs.readFileSync(tag, "utf8").trim() === plat.checksum) have = fs.statSync(part).size; } catch {}
    if (!have) { fs.rmSync(part, { force: true }); fs.writeFileSync(tag, plat.checksum); }
    for (let attempt = 1; have < plat.size; attempt++) {
      try {
        const r = await fetch(`${CC_BASE}/${c.latest}/linux-arm64/claude`, { headers: have ? { range: `bytes=${have}-` } : {} });
        if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
        if (r.status === 200) { have = 0; fs.rmSync(part, { force: true }); }
        const out = fs.openSync(part, "a");
        try { for await (const chunk of r.body) { fs.writeSync(out, chunk); have += chunk.length; c.done = have; } }
        finally { fs.closeSync(out); }
      } catch (e) {
        if (attempt >= 8) throw e;
        c.message = `网络中断（${e.message}），${attempt * 3} 秒后续传…`;
        await new Promise((ok) => setTimeout(ok, attempt * 3000));
        have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      }
    }
    c.message = "校验 sha256…";
    const h = crypto.createHash("sha256");
    for await (const b of fs.createReadStream(part)) h.update(b);
    const got = h.digest("hex");
    if (got !== plat.checksum) { fs.rmSync(part, { force: true }); throw new Error(tz("sha256 不符（期望 {want}…，实得 {got}…）", { want: plat.checksum.slice(0, 12), got: got.slice(0, 12) })); }
    fs.chmodSync(part, 0o755);
    const v = await claudeVersionOf(part);
    if (v !== c.latest) throw new Error(tz("新版试跑失败（--version 得到「{v}」）", { v }));
    fs.rmSync(PATHS.claude + ".prev", { force: true });
    fs.renameSync(PATHS.claude, PATHS.claude + ".prev");
    fs.renameSync(part, PATHS.claude);
    fs.rmSync(tag, { force: true });
    log(`Claude Code 已更新 ${c.current} → ${v}`);
    c.current = v; c.state = "uptodate"; c.message = `已更新到 ${v}（下一轮对话起生效；旧版留在 claude.prev）`;
  } catch (e) {
    c.state = "error"; c.message = e.message;
  } finally { devUpdSave(); }
}

function devUpdStatus() {
  const { claude, ...rest } = devUpd;
  return { ok: true, ...rest, items: [claude] };
}

// 自动：启动 1 分钟后、之后每 30 分钟看一眼，距上次检查超过 6 小时就查；有新版且开着自动就装
if (!PREFIX) {
  const tick = async () => {
    if (!devUpd.auto || Date.now() - devUpd.lastCheck < 6 * 3600_000) return;
    await devUpdCheck();
    if (devUpd.auto && devUpd.claude.state === "available") devUpdInstall();
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 30 * 60_000);
}

/** 开发端的 priv 状态：真跑一次 priv 'id -u'（rish → Shizuku），拿到 2000/0 才算就绪 */
function devPrivStatus() {
  return new Promise((ok) => {
    execFile("priv", ["id -u"], { timeout: 8000, env: process.env }, (e, out, err) => {
      const uid = String(out || "").trim();
      if (uid === "2000" || uid === "0") return ok({ state: "ok", installed: true, running: true, granted: true, uid: +uid, wireless: false, paired: true, dev: true });
      const msg = String(err || out || (e && e.message) || "").trim();
      ok({ state: /not running|binder|没在运行|isn't running/i.test(msg) ? "not_running" : "no_permission", installed: true, running: false, granted: false,
        wireless: false, paired: true, dev: true, message: msg.slice(0, 200) });
    });
  });
}

async function devApp(op, b) {
  if (op === "upd_status") {
    if (!devUpd.lastCheck && !devUpd.checking) devUpdCheck();
    else if (!devUpd.claude.current) devUpd.claude.current = await claudeVersionOf(PATHS.claude);
    return devUpdStatus();
  }
  if (op === "upd_check") { devUpdCheck(); await new Promise((r) => setTimeout(r, 200)); return devUpdStatus(); }
  if (op === "upd_set") {
    if (typeof b.auto === "boolean") devUpd.auto = b.auto;
    // 换渠道 = 明说要那个渠道的版本：查完对不上就直接换（自动更新关着也换）
    if ((b.channel === "stable" || b.channel === "latest") && b.channel !== devUpd.channel) {
      devUpd.channel = b.channel;
      devUpdCheck().then(() => { if (devUpd.claude.state === "available") devUpdInstall(); }).catch(() => {});
    }
    devUpdSave();
    return devUpdStatus();
  }
  if (op === "upd_apply") {
    if (b.item !== "claude") return { ok: false, message: tz("开发端只管 Claude Code（应用本体由你在本机构建安装）") };
    if (devUpd.claude.state !== "available" && devUpd.claude.state !== "error") return { ok: false, message: tz("没有可装的新版，先检查更新") };
    devUpdInstall();
    return { ok: true, message: tz("开始更新 Claude Code") };
  }
  return { ok: false, message: tz("开发端不支持：{op}", { op }) };
}

// ── 本机实况：TOOLS.md 是打包时在测试机上测的，这里补上「这台设备上实际怎样」 ──
// 自检（cccodroid-selftest）在本机跑一遍，失败项和 INFO（比如有没有硬件编码器）接在 TOOLS.md 后面；
// 装了哪些组件、用 pkg 装了哪些包，每轮现读。自检只在工具包或应用版本变了之后、空闲时重跑（要一两分钟 CPU）
const ENV_FACTS = PREFIX ? path.join(CFG.home, ".cccodroid-env.json") : "";
function envFactsKey() {
  const dk = devkitIdentity() || {};
  let tag = ""; try { tag = fs.readFileSync(path.join(HERE, "TAG"), "utf8").trim(); } catch {}
  return `${dk.sha256 || dk.tag || "?"}|${tag}`;
}
let envFactsJob = null;
function envFactsRun() {
  const st = path.join(process.env.CCAPP_BIN || "", "cccodroid-selftest");
  if (!PREFIX || envFactsJob || !fs.existsSync(st)) return;
  const key = envFactsKey(), nice = path.join(PREFIX, "bin", "nice");
  // 经 Claude 用的同一个 shell 包装起（挂着 termux-exec）：直接调 bash 的话 #!/usr/bin/env 一类脚本全报 bad interpreter，
  // 自检就会把「这台设备上 shebang 不能用」这种假结论告诉 Claude
  const sh = ensureShell();
  const argv = fs.existsSync(nice) ? [nice, "-n", "10", sh, st] : [sh, st];
  let out = "";
  log("[env] 本机自检开始（工具包或应用换了版本）");
  envFactsJob = spawn(argv[0], argv.slice(1), { env: termEnv(), cwd: CFG.home, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  envFactsJob.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
  envFactsJob.stderr.on("data", () => {});
  const t = setTimeout(() => { try { killTree(envFactsJob); } catch {} }, 15 * 60e3);
  envFactsJob.on("close", () => {
    clearTimeout(t); envFactsJob = null;
    const r = { key, at: Date.now(), pass: 0, fail: [], info: [] };
    for (const l of out.split("\n")) {
      if (l.startsWith("PASS ")) r.pass++;
      else if (l.startsWith("FAIL ")) r.fail.push(l.slice(5, 260));
      else if (l.startsWith("INFO ")) r.info.push(l.slice(5, 260));
    }
    if (!r.pass) { log("[env] 自检没跑出结果，下次再试"); return; }
    try { fs.writeFileSync(ENV_FACTS, JSON.stringify(r, null, 1)); } catch {}
    log(`[env] 本机自检：通过 ${r.pass} 项，失败 ${r.fail.length} 项`);
  });
}
// 空闲（没有 claude 在跑）且结果过期时才跑：启动 2 分钟后看一次，之后每 5 分钟
function envFactsTick() {
  if (RUNS.size || envFactsJob) return;
  let cur = null; try { cur = JSON.parse(fs.readFileSync(ENV_FACTS, "utf8")); } catch {}
  if (!cur || cur.key !== envFactsKey()) envFactsRun();
}
if (PREFIX) { setTimeout(envFactsTick, 2 * 60e3).unref?.(); setInterval(envFactsTick, 5 * 60e3).unref?.(); }

function envFacts() {
  const out = [];
  const dk = devkitIdentity();
  if (dk && dk.tag) out.push(`- 工具包：${dk.tag}`);
  // 扩展页装的组件
  try {
    const comps = fs.readdirSync(COMP_DIR).filter((f) => f.endsWith(".json")).map((f) => compRecord(f.slice(0, -5)))
      .filter((r) => r && r.state === "ok").map((r) => `${r.id} ${r.version}${r.bin && r.bin.length ? `（命令：${r.bin.join("、")}）` : ""}`);
    if (comps.length) out.push(`- 已装组件：${comps.join("；")}`);
  } catch {}
  // pkg 装的包（只列用户点名装的，依赖不列）
  try {
    const db = JSON.parse(fs.readFileSync(path.join(path.dirname(PREFIX), "pkg", "installed.json"), "utf8")).pkgs || {};
    const have = new Set(fs.readdirSync(path.join(PREFIX, "var/lib/dpkg/info")).filter((f) => f.endsWith(".list")).map((f) => f.slice(0, -5)));
    const mine = Object.entries(db).filter(([, r]) => !r.auto);
    const ok = mine.filter(([n]) => have.has(n)).map(([n, r]) => `${n} ${r.version}`), lost = mine.filter(([n]) => !have.has(n)).map(([n]) => n);
    if (ok.length) out.push(`- 用 pkg 装过：${ok.join("、")}`);
    if (lost.length) out.push(`- 工具包更新后这些 pkg 包已不在：${lost.join("、")}（要用就先 \`pkg restore\`）`);
  } catch {}
  let r = null; try { r = JSON.parse(fs.readFileSync(ENV_FACTS, "utf8")); } catch {}
  if (r) {
    const stale = r.key !== envFactsKey() ? "（工具包或应用更新前测的）" : "";
    out.push(`- 本机自检${stale}：通过 ${r.pass} 项${r.fail.length ? `，**失败 ${r.fail.length} 项 —— 下列功能在这台设备上不能用，别依赖，需要时如实告诉用户**：` : "，全部通过"}`);
    for (const f of r.fail.slice(0, 12)) out.push(`  - ${f}`);
    for (const i of r.info.slice(0, 8)) out.push(`- ${i}`);
  }
  return out.length ? "## 本机实况（自动生成）\n\n" + out.join("\n") : "";
}

// ── 反馈：拼一个预先填好的 GitHub Issue 链接 ─────────────────────────────
// 用户点「到 GitHub 反馈」：机型、系统、各家 ROM 版本、自检结果、装了哪些组件都填好，用户只写遇到了什么。
// 只放设备与版本信息，不放日志、密钥、账号、对话（那些走「打包诊断」私下发）。链接有长度上限，自检明细超了就截
const ISSUE_REPO = "https://github.com/greyoak111/cccodroid/issues/new";
// 各家 ROM 自己的版本号属性：杀后台、权限路径都跟着 ROM 走，比机型更有用
const ROM_PROPS = [
  ["ro.mi.os.version.name", "HyperOS"], ["ro.miui.ui.version.name", "MIUI"], ["ro.build.version.oplusrom", "ColorOS"],
  ["ro.build.version.opporom", "ColorOS"], ["ro.vivo.os.version", "OriginOS/Funtouch"], ["ro.build.version.magic", "MagicOS"],
  ["ro.build.version.emui", "EMUI"], ["ro.build.version.oneui", "One UI"], ["ro.zui.version", "ZUI"], ["ro.build.MiFavor_version", "MyOS"],
  ["ro.flyme.version.id", "Flyme"], ["ro.build.version.realmeui", "realme UI"], ["ro.rom.version", "ROM"],
];
async function issueDraft(lang) {
  const L = (k) => tr(lang, tz(k));   // 正文不经 sendJson 的 message 翻译，这里按请求语言自己翻
  const props = {};
  try {
    const out = await new Promise((ok) => execFile("/system/bin/getprop", [], { timeout: 5000, maxBuffer: 4 << 20 }, (e, so) => ok(String(so || ""))));
    for (const m of out.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)) props[m[1]] = m[2];
  } catch {}
  const g = (k) => props[k] || "";
  const upd = PREFIX ? await privCall({ op: "upd_status" }, 5000) : {};
  const ver = (id) => ((upd.items || []).find((i) => i.id === id) || {}).current || "";
  const shz = PREFIX ? await privCall({ op: "status" }, 5000) : {};
  const rom = ROM_PROPS.filter(([k]) => g(k)).map(([k, n]) => `${n} ${g(k)}`).slice(0, 2).join(" · ") || g("ro.build.display.id");
  const gpu = fs.existsSync("/dev/kgsl-3d0") ? "Adreno (kgsl)" : fs.existsSync("/dev/mali0") ? "Mali" : fs.existsSync("/dev/pvrsrvkm") ? "PowerVR" : "?";
  let ram = ""; try { ram = (Number(/MemTotal:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))[1]) / 1048576).toFixed(1) + " GB"; } catch {}
  let disk = ""; try { const st = fs.statfsSync(CFG.home); disk = ((st.bavail * st.bsize) / 2 ** 30).toFixed(0) + " GB"; } catch {}
  const dk = devkitIdentity() || {};
  const row = (k, v) => (v ? `| ${k} | ${String(v).replace(/[|\n]/g, " ")} |` : "");
  const dev = [
    "| | |", "|---|---|",
    row("cccodroid", ver("app") || (PREFIX ? "?" : "dev")),
    row("Toolchain", ver("devkit") || dk.tag),
    row("Claude Code", ver("claude")),
    row("Android", `${g("ro.build.version.release")} (SDK ${g("ro.build.version.sdk")})`),
    row("Device", `${g("ro.product.manufacturer")} ${g("ro.product.model")}${g("ro.product.brand") && g("ro.product.brand").toLowerCase() !== g("ro.product.manufacturer").toLowerCase() ? ` (${g("ro.product.brand")})` : ""}`),
    row("ROM", rom),
    row("SoC", [g("ro.soc.manufacturer"), g("ro.soc.model")].filter(Boolean).join(" ") || g("ro.hardware") || g("ro.board.platform")),
    row("GPU", gpu),
    row("ABI", g("ro.product.cpu.abi")),
    row("RAM / free space", [ram, disk].filter(Boolean).join(" · ")),
    row("Shizuku", shz.state || ""),
    row("Killed in background", shz.frozen && shz.frozen.count ? `${shz.frozen.count}×` : ""),
  ].filter(Boolean).join("\n");
  let st = "";
  let r = null; try { r = JSON.parse(fs.readFileSync(ENV_FACTS, "utf8")); } catch {}
  if (r) {
    st = `Passed ${r.pass}, failed ${r.fail.length}${r.key !== envFactsKey() ? " (before the last update)" : ""}`;
    if (r.fail.length) st += "\n\n" + r.fail.slice(0, 15).map((x) => "- " + x).join("\n");
    if (r.info.length) st += "\n\n<details><summary>Info</summary>\n\n" + r.info.slice(0, 10).map((x) => "- " + x).join("\n") + "\n</details>";
  } else st = PREFIX ? "Not run yet" : "n/a";
  let comps = "";
  try {
    comps = fs.readdirSync(COMP_DIR).filter((f) => f.endsWith(".json")).map((f) => compRecord(f.slice(0, -5)))
      .filter((c) => c && c.state === "ok").map((c) => `${c.id} ${c.version}`).join(", ");
  } catch {}
  const build = (stx) => [
    "### " + L("遇到了什么"), "", "<!-- " + L("做了什么、想要什么结果、实际怎样。截图可以直接拖进来。") + " -->", "", "",
    "### " + L("怎么复现"), "", "1. ", "",
    "### Device", "", dev, "",
    "### Self-test", "", stx, "",
    comps ? "### Components\n\n" + comps + "\n" : "",
    "<sub>Filled in by cccodroid. No logs, keys, account or conversation content.</sub>",
  ].join("\n");
  let body = build(st);
  if (encodeURIComponent(body).length > 7000) body = build(r ? `Passed ${r.pass}, failed ${r.fail.length}` + (r.fail.length ? "\n\n" + r.fail.slice(0, 5).map((x) => "- " + x.slice(0, 120)).join("\n") : "") : st);
  const title = `[${g("ro.product.manufacturer")} ${g("ro.product.model")} · Android ${g("ro.build.version.release")}] `;
  return { title, body, url: `${ISSUE_REPO}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` };
}

/** 给 claude 的工具说明。两种布局装的东西不一样，各说各的，别把没有的命令告诉它 */
// 第三方模型的清单提醒（见 providerEnv 里的 CLAUDE_CODE_ENABLE_TODO_TOOLS）；Claude 型号自己会用，不用提醒
// 查看器能直接预览 HTML：告诉 Claude 静态网页写好给路径就行，别动不动起 http.server（还得用户自己找端口）
const PREVIEW_HINT = "In this app, file paths you mention in a reply are tappable and open in a file viewer, where .html files render as a live preview (relative CSS, JS and images load, and it reloads when the file changes). For a static web page or browser game, write the file and give the user its full path instead of starting a local web server; start a server only when the page needs a backend.";
const TASKS_HINT = "When a request has 3 or more distinct steps, track them with the TaskCreate and TaskUpdate tools: create the tasks first, mark each in_progress when you start it and completed when it is done. The user sees this list as a live progress panel.";
function toolsHint() {
  if (PREFIX) {
    // 随包的 TOOLS.md 是逐项实测过的工具清单与用法（cccodroid-selftest 验证），优先用它；后面接本机实况
    try {
      const t = fs.readFileSync(path.join(HERE, "TOOLS.md"), "utf8")
        .replaceAll("{{WORKSPACE}}", CFG.workspace).replaceAll("{{SHARED}}", process.env.CCAPP_SHARED || "（无存储权限，不可用）");
      if (t.trim()) return [t.trim(), envFacts()].filter(Boolean).join("\n\n");
    } catch {}
    return [
      "这是一台安卓设备，原生运行（不是 chroot/proot/虚拟机）。开发工具包已在 PATH 中（前缀 $PREFIX，来自 Termux 官方仓库）：",
      "clang/clang++/lld、make、cmake、ninja、pkg-config、gdb、strace、patchelf；git、ssh；python、node、npm；",
      "openjdk-21(java/javac)、aapt2、d8、apksigner；rg、fd、bat、delta、hx、yq、jq、sqlite3、typst、duckdb、ImageMagick(magick)；",
      "以及 curl、zip/unzip、xz、zstd 等常用命令。cc/c++ 即 clang。",
      "/tmp 不可用，临时文件写 $TMPDIR；/sdcard 不支持符号链接、不可执行。",
      "需要系统权限（pm/am/settings/dumpsys/screencap/logcat 等）时用 priv '<命令>'，经 Shizuku 以 shell 身份执行；priv --status 看是否可用。",
      "工具链出问题先跑 cccodroid-selftest（逐项检查编译器、Python、Node、Java、Git 等是否可用）。",
    ].join(" ");
  }
  // 开发端：TOOLS-dev.md 是按本机实测写的工具清单与用法（比公开版多 Blender/Godot/Wine/priv 等）
  try {
    const t = fs.readFileSync(path.join(HERE, "TOOLS-dev.md"), "utf8").replaceAll("{{WORKSPACE}}", CFG.workspace);
    if (t.trim()) return t.trim();
  } catch {}
  return [
    "本机（安卓）已接入一套命令行工具链，已加入 PATH：",
    "git/ssh、gcc(cc4)/g++(cxx4)/make(mk4)、rg/fd/bat/yq/typst、",
    "ImageMagick(magick/identify)、duckdb、delta、hx、gdb、sqlite3、",
    "node，以及 blender / godot / wine(wp) / aapt2 / mkapk 等启动器。",
    "直接调用命令名即可；工具链根目录在 $CCAPP_TOOLCHAIN。",
  ].join(" ");
}

/** result 事件里带了各模型的上下文窗口，取来给前端的用量条用。
 *  claude 报不出来时回落到 DeepSeek /models 给的真实窗口 —— 绝不写死数值。 */
function contextWindowOf(result) {
  learnWindow(result);
  try {
    const mu = result.modelUsage || {};
    for (const k of Object.keys(mu)) {
      if (mu[k] && mu[k].contextWindow) return mu[k].contextWindow;
    }
  } catch {}
  return Number(currentModelInfo().context_window) || 0;
}

/** 生效的自动压缩窗口。
 *  设这个值有两条路：网关设置面板（进 SETTINGS，靠环境变量下发），
 *  或者在对话里打 `/autocompact 400k`（那条命令写进的是 Claude Code 自己的
 *  ~/.claude/settings.json，网关这边看不见）。两条都要认，否则界面上的刻度会失真。 */
function effectiveAutoCompact() {
  if (SETTINGS.autoCompactWindow) return SETTINGS.autoCompactWindow;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CFG.home, ".claude", "settings.json"), "utf8"));
    const n = Number(j.autoCompactWindow);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  } catch {}
  return null;
}

/** 一次 API 调用的【提示词总量】= 那一刻的上下文占用。
 *  三部分相加才是完整提示词：未命中缓存的 + 命中缓存的 + 本次写入缓存的。
 *  ⚠️ 千万不要拿 result 事件里的 usage 当上下文用 —— 那是整轮所有调用的累计和，
 *  一轮里几十次工具调用加起来能报出比窗口还大好几倍的数字。 */
const promptTokens = (u) => u
  ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  : 0;

/** 把 claude 的 stream-json 事件翻译成前端事件 */
function translate(ev, { sse, onInit, onResult, onReplay, flags }) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") onInit(ev);
      else if (ev.subtype === "status" && ev.status === "compacting") sse({ type: "compacting" });
      // 请求失败、claude 自己在退避重试：界面据此说「连接出错，重试 3/10」，而不是一直转圈让人猜
      else if (ev.subtype === "api_retry" && !ev.parent_tool_use_id) {
        sse({ type: "phase", phase: "retry", attempt: ev.attempt || 0, max: ev.max_retries || 0,
              status: ev.error_status ?? null, error: String(ev.error || "").slice(0, 200), delayMs: ev.retry_delay_ms || 0 });
      }
      // 子代理进度：在干什么（Reading a.txt）、用了多少 token / 几次工具；跑完（含后台子代理）报一次结果
      else if (ev.subtype === "task_progress" && ev.tool_use_id) {
        const u = ev.usage || {};
        sse({ type: "sub_progress", parent: ev.tool_use_id, desc: String(ev.description || "").slice(0, 200),
              tokens: u.total_tokens || 0, tools: u.tool_uses || 0 });
      }
      else if (ev.subtype === "task_notification" && ev.tool_use_id) {
        sse({ type: "sub_done", parent: ev.tool_use_id, status: String(ev.status || "") });
      }
      else if (ev.subtype === "compact_boundary") {
        // 压缩（手动 /compact 或自动）完成。以前不认这条：界面显示「无输出」，上下文条要等下一轮才变
        const m = ev.compact_metadata || ev.compactMetadata || {};
        const pre = m.pre_tokens ?? m.preTokens, post = m.post_tokens ?? m.postTokens;
        if (flags && post != null) flags.contextTokens = post;
        sse({ type: "compacted", trigger: m.trigger || "", pre: pre ?? null, post: post ?? null });
      }
      break;

    case "stream_event": {
      // --include-partial-messages：逐字增量
      const e = ev.event;
      // 每次 API 调用开头都有 message_start，它的 usage 就是【当时】的上下文占用。
      // 取最后一次 = 当前真实占用。这条同时也是「按钮刚按下就更新」的来源。
      if (e?.type === "message_start" && e.message?.usage) {
        const n = promptTokens(e.message.usage);
        if (flags) flags.contextTokens = n;
        if (flags && !ev.parent_tool_use_id) {
          flags.mainCtx = n;
          const cc = e.message.usage.cache_creation;
          if (cc && cc.ephemeral_1h_input_tokens > 0) flags.cache1h = true;
          if (cc && cc.ephemeral_5m_input_tokens > 0) flags.cache5m = true;
        }
        sse({ type: "usage", contextTokens: n, outputTokens: e.message.usage.output_tokens || 0 });
        if (!ev.parent_tool_use_id) sse({ type: "phase", phase: "wait" });   // 请求已被接住，模型还没出第一个字
        break;
      }
      // 进行到哪一步（界面回复末尾的小字）：思考块、工具参数、正文各自开始时报一声。
      // 思考块不管有没有吐原文都会有 content_block_start，所以「思考中」不依赖能不能看到思考内容。
      // 工具参数（比如 Write 一个大文件）可能流几十秒，只报字数、节流到 0.4 秒一次。子代理的不报。
      if (!ev.parent_tool_use_id && flags) {
        if (e?.type === "content_block_start") {
          const k = e.content_block?.type;
          if (k === "thinking" || k === "redacted_thinking") sse({ type: "phase", phase: "think" });
          else if (k === "tool_use" || k === "server_tool_use") {
            flags.toolName = e.content_block.name || ""; flags.toolChars = 0; flags.toolAt = Date.now();
            sse({ type: "phase", phase: "tool", name: flags.toolName, chars: 0 });
          } else if (k === "text") sse({ type: "phase", phase: "text" });
        } else if (e?.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
          flags.toolChars = (flags.toolChars || 0) + String(e.delta.partial_json || "").length;
          const emit = () => { flags.toolTimer = null; flags.toolAt = Date.now(); sse({ type: "phase", phase: "tool", name: flags.toolName || "", chars: flags.toolChars }); };
          if (Date.now() - (flags.toolAt || 0) >= 400) emit();
          else if (!flags.toolTimer) flags.toolTimer = setTimeout(emit, 400 - (Date.now() - (flags.toolAt || 0)));   // 节流期间的最后一个数也要报出去
        } else if (e?.type === "content_block_stop" && flags.toolTimer) { clearTimeout(flags.toolTimer); flags.toolTimer = null; }
      }
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
        if (flags) flags.gotDelta = true;
        sse({ type: "delta", text: e.delta.text });
      } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
        if (flags) flags.gotThinkDelta = true;
        sse({ type: "thinking_delta", text: e.delta.thinking });
      }
      break;
    }

    case "assistant": {
      // 子代理的消息（parent_tool_use_id = 主流程里那张 Agent 卡的 id）：工具调用和最后的汇报挂到那张卡下面，
      // 不混进主流程；子代理没有逐字增量，思考不转
      if (ev.parent_tool_use_id) {
        for (const c of ev.message?.content || []) {
          if (c.type === "tool_use") sse({ type: "tool_use", id: c.id, name: c.name, input: c.input, parent: ev.parent_tool_use_id });
          else if (c.type === "text" && c.text) sse({ type: "sub_text", parent: ev.parent_tool_use_id, text: String(c.text).slice(0, 20000) });
        }
        break;
      }
      // 逐字增量已发过就别重复整段文本
      const content = ev.message?.content || [];
      for (const c of content) {
        // 本地命令（/context /cost /compact …）的正文 claude 会发两遍：一条合成的 assistant 消息 + result。
        // 界面拿 result 画命令卡片，这里再发就重复了（以前 /context 显示两次）
        if (c.type === "text" && flags?.isCmd && ev.message?.model === "<synthetic>") continue;
        if (c.type === "text" && c.text) {
          // 逐字增量发过就不重复整段；没发过（增量没到）才补完整文本
          if (!flags || !flags.gotDelta) sse({ type: "assistant_text", text: c.text });
        } else if (c.type === "thinking" && c.thinking) {
          // 同理：思考也逐字发过了。以前这里无条件再发整段，思考块里每段都重复两遍
          if (!flags || !flags.gotThinkDelta) sse({ type: "thinking", text: c.thinking });
        } else if (c.type === "tool_use") {
          sse({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        }
      }
      break;
    }

    case "user": {
      if (ev.isReplay) { if (onReplay) onReplay(ev); break; }
      for (const c of ev.message?.content || []) {
        if (c.type === "tool_result") {
          let txt = "";
          if (typeof c.content === "string") txt = c.content;
          else if (Array.isArray(c.content)) {
            txt = c.content.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
          }
          sse({ type: "tool_result", id: c.tool_use_id, ok: !c.is_error, text: String(txt).slice(0, 20000), ...(ev.parent_tool_use_id ? { parent: ev.parent_tool_use_id } : {}) });
        }
      }
      break;
    }

    case "result":
      onResult(ev);
      if (ev.is_error && ev.result) sse({ type: "error", message: String(ev.result).slice(0, 1500) });
      break;

    case "rate_limit_event":
      noteRateLimit(ev.rate_limit_info);
      break;

    default:
      break;
  }
}

/** 订阅额度（5 小时 / 每周）。
 *  claude 每轮都会在 stream-json 里报一条 rate_limit_event，unifiedWindows 里就是两个窗口的占用比例和重置时间。
 *  网关只是记下 claude 自己吐出来的这条 —— 不拿令牌去查任何接口。
 *  所以额度要「发过一条消息」之后才有，之后每轮刷新；记下当时的账户，换账户就不显示旧数。 */
const RL_FILE = path.join(CFG.home, ".cache", "ccapp-ratelimits.json");
let RATE_LIMITS = (() => { try { return JSON.parse(fs.readFileSync(RL_FILE, "utf8")); } catch { return null; } })();
function noteRateLimit(info) {
  const w = info && info.unifiedWindows;
  if (!w || !isLoginMode()) return;
  const win = (x) => x && Number.isFinite(+x.utilization)
    ? { used: +x.utilization <= 1 ? Math.round(+x.utilization * 1000) / 10 : +x.utilization, resetsAt: x.resetsAt || null }
    : null;
  RATE_LIMITS = {
    at: Date.now(),
    email: AUTH_CACHE?.v?.email || null,
    status: info.status || null,
    fiveHour: win(w.five_hour), sevenDay: win(w.seven_day),
  };
  saveRateLimits();
  // 账户缓存是冷的就补查一次，把这份额度钉到账户上（换账户后不显示旧数）
  if (!RATE_LIMITS.email) authStatus().then((v) => { if (RATE_LIMITS && v.email) { RATE_LIMITS.email = v.email; saveRateLimits(); } }).catch(() => {});
}
function saveRateLimits() {
  try {
    fs.mkdirSync(path.dirname(RL_FILE), { recursive: true });
    fs.writeFileSync(RL_FILE, JSON.stringify(RATE_LIMITS));
  } catch {}
}

// ── 扩展：插件 / 技能 / MCP ───────────────────────────────────────────
// 全部转给 claude 自己的命令行（claude plugin … / claude mcp …），网关不自己改它的配置文件 ——
// 格式随 claude 版本变，自己写迟早写坏。技能目录（~/.claude/skills）例外：它就是一堆文件夹，没有命令。
// 同一时刻只跑一个改配置的命令，免得两个安装同时写 settings.json。
let EXT_LOCK = Promise.resolve();
function extRun(args, timeoutMs = 180000) {
  const job = EXT_LOCK.then(() => new Promise((resolve) => {
    const [cmd0, args0] = claudeCmd(args);
    const child = spawn(cmd0, args0, {
      cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home,
      env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => killTree(child), timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
  }));
  EXT_LOCK = job.catch(() => {});
  return job;
}
const lastJson = (s) => {
  const lines = String(s).trim().split("\n").reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch {} }
  try { return JSON.parse(String(s).slice(String(s).indexOf("{"))); } catch {}
  try { return JSON.parse(String(s).slice(String(s).indexOf("["))); } catch {}
  return null;
};
const cliMsg = (r) => (r.err || r.out || "").replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-600);

let PLUGIN_CATALOG = null;   // 可安装清单有三千多条，缓存 10 分钟，搜索在网关这边做
async function pluginState(withAvailable) {
  const fresh = PLUGIN_CATALOG && Date.now() - PLUGIN_CATALOG.at < 600000;
  const r = await extRun(["plugin", "list", "--json", ...(withAvailable && !fresh ? ["--available"] : [])], 120000);
  const j = lastJson(r.out);
  if (!j) throw new Error(cliMsg(r) || "claude plugin list 没有输出");
  const installed = Array.isArray(j) ? j : j.installed || [];
  if (!Array.isArray(j) && j.available) PLUGIN_CATALOG = { at: Date.now(), list: j.available };
  return installed;
}

async function listPlugins(q, offset, withAvailable) {
  const installed = await pluginState(withAvailable);
  const ids = new Set(installed.map((p) => p.id));
  const res = {
    installed: installed.map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled !== false, installedAt: p.installedAt })),
  };
  if (withAvailable && PLUGIN_CATALOG) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hit = PLUGIN_CATALOG.list.filter((p) => {
      if (ids.has(p.pluginId)) return false;
      const hay = (p.name + " " + (p.description || "") + " " + p.marketplaceName).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    res.total = hit.length;
    res.available = hit.slice(offset, offset + 40).map((p) => ({
      id: p.pluginId, name: p.name, description: String(p.description || "").slice(0, 300),
      marketplace: p.marketplaceName, version: p.version || null,
    }));
  }
  return res;
}

/** 安装：有的插件要靠执行一条命令装（或拉包时要跑 headersHelper）。claude 会先把这条命令亮出来，
 *  不经人点头不装 —— 这里也一样：先不带确认跑一次，拿到命令和它的 sha256 交给界面，用户同意后再带 --accept-command 装。 */
async function installPlugin(id, accept) {
  const r = await extRun(["plugin", "install", id, "--json", ...(accept ? ["--accept-command", accept] : [])], 600000);
  const j = lastJson(r.out) || {};
  const shown = j.shownCommand || j.command;
  if (r.code !== 0 && shown && shown.sha256 && !accept) {
    return { ok: false, needConfirm: true, command: shown.command || shown.display || JSON.stringify(shown), sha256: shown.sha256 };
  }
  return r.code === 0 ? { ok: true } : { ok: false, message: j.error || j.message || cliMsg(r) };
}

async function pluginOp(op, id) {
  const args = op === "uninstall" ? ["plugin", "uninstall", id, "--json"] : ["plugin", op, id];
  const r = await extRun(args, 120000);
  const j = lastJson(r.out) || {};
  return r.code === 0 ? { ok: true } : { ok: false, message: j.error || j.message || cliMsg(r) };
}

async function listMarketplaces() {
  const r = await extRun(["plugin", "marketplace", "list", "--json"], 60000);
  const j = lastJson(r.out);
  return Array.isArray(j) ? j.map((m) => ({ name: m.name, source: m.source?.repo || m.source?.url || m.source?.path || m.url || "" })) : [];
}

async function marketplaceOp(op, arg) {
  const r = await extRun(["plugin", "marketplace", op, arg], 300000);
  if (r.code === 0) PLUGIN_CATALOG = null;
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

/** claude mcp list 只有给人看的文本：「名字: 目标 - ✔ Connected」。顺带做了连通检查，所以慢几秒 */
async function listMcp() {
  const r = await extRun(["mcp", "list"], 90000);
  const out = [];
  for (const line of r.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const m = line.match(/^(.+?): (.+) - ([✔✗⚠!]|[^\s]+)\s*(.*)$/u);
    if (!m) continue;
    const name = m[1].trim();
    out.push({ name, target: m[2].trim(), ok: m[3] === "✔", status: (m[3] + " " + m[4]).trim().slice(0, 200), cloud: name.startsWith("claude.ai ") });
  }
  return out;
}

async function addMcp(b) {
  const name = String(b.name || "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, message: tz("名字只能用字母、数字、点、下划线、横线") };
  const transport = ["stdio", "http", "sse"].includes(b.transport) ? b.transport : "stdio";
  const target = String(b.target || "").trim();
  if (!target) return { ok: false, message: tz("缺少命令或地址") };
  // -e / --header 是可变参数，会把后面的名字吞掉：名字放前面，选项跟在后面、用 -- 收尾
  const args = ["mcp", "add", "-s", "user", "--transport", transport, name];
  if (transport !== "stdio") args.push(target);
  for (const kv of [].concat(b.env || [])) if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(kv)) args.push("-e", kv);
  for (const h of [].concat(b.headers || [])) if (String(h).includes(":")) args.push("--header", String(h));
  if (transport === "stdio") {
    // 命令行按空白切开；带空格的参数用引号括起来
    const parts = target.match(/"[^"]*"|'[^']*'|\S+/g).map((x) => x.replace(/^(["'])(.*)\1$/, "$2"));
    args.push("--", ...parts);
  }
  const r = await extRun(args, 60000);
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

async function removeMcp(name) {
  const r = await extRun(["mcp", "remove", String(name)], 60000);
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

// 技能：~/.claude/skills/<名字>/SKILL.md（开头 YAML 里有 name / description）
// ── Hooks：到某个时刻自动跑的命令（claude 的 settings.json 里 "hooks" 一个键） ──
// claude 没有管 hooks 的命令行，只能直接改 settings.json：只动 hooks / disableAllHooks 两个键，其余原样保留；
// 写前留一份 .bak，和插件安装共用 EXT_LOCK，免得两边同时写。三处配置：用户级（所有项目）、项目级、项目本机级。
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "UserPromptSubmit", "Stop",
  "SubagentStart", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact", "PostCompact",
  "InstructionsLoaded", "ConfigChange", "TaskCompleted", "TeammateIdle", "WorktreeCreate", "Setup"];
const HOOK_SCRIPTS_DIR = path.join(CFG.home, ".claude", "hooks");
// 常用规则用到的小脚本（源码在 claude-apk/hooks/，用 hooks/embed.mjs 生成这一行）；添加规则时写进 ~/.claude/hooks/
const HOOK_SCRIPTS = {"cc-autosave.mjs":"// cccodroid 内置 hook（Claude 答完一轮时）：项目是 git 仓库、且有改动，就自动提交一次存档。只提交，不推送。\n// 用法：node cc-autosave.mjs '自动存档'   （参数是提交说明的前缀，后面自动加时间）\nimport fs from \"node:fs\";\nimport { execFileSync } from \"node:child_process\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cwd = j.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();\nconst git = (...a) => execFileSync(\"git\", a, { cwd, encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] });\ntry { if (git(\"rev-parse\", \"--is-inside-work-tree\").trim() !== \"true\") process.exit(0); } catch { process.exit(0); }\ntry {\n  if (!git(\"status\", \"--porcelain\").trim()) process.exit(0);\n  git(\"add\", \"-A\");\n  const id = [];\n  try { git(\"config\", \"user.name\"); } catch { id.push(\"-c\", \"user.name=cccodroid\"); }\n  try { git(\"config\", \"user.email\"); } catch { id.push(\"-c\", \"user.email=autosave@cccodroid.local\"); }\n  const d = new Date(), p = (n) => String(n).padStart(2, \"0\");\n  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;\n  git(...id, \"commit\", \"-q\", \"-m\", `${process.argv[2] || \"自动存档\"} ${when}`);\n} catch (e) {\n  process.stderr.write(\"自动存档失败：\" + String(e.stderr || e.message).slice(0, 300) + \"\\n\");\n}\n","cc-bash-log.mjs":"// cccodroid 内置 hook（用完工具之后，只管 Bash）：把 Claude 跑过的命令记进日志，方便事后翻看。\n// 用法：node cc-bash-log.mjs [日志文件]   默认 ~/.claude/bash-history.log\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cmd = String((j.tool_input || {}).command || \"\");\nif (!cmd) process.exit(0);\nconst file = process.argv[2] || path.join(process.env.HOME || \".\", \".claude\", \"bash-history.log\");\nconst d = new Date(), p = (n) => String(n).padStart(2, \"0\");\nconst when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;\ntry {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.appendFileSync(file, `${when}\\t${j.cwd || \"\"}\\n  ${cmd.replace(/\\n/g, \"\\n  \")}\\n`);\n} catch {}\n","cc-format.mjs":"// cccodroid 内置 hook（用完工具之后，管改文件的工具）：Claude 改完代码文件，用本机已装的格式化工具整理一遍。\n// 按扩展名找：ruff / black、prettier、gofmt、rustfmt、clang-format、shfmt，没装就什么也不做。\n// Markdown 和纯文本不碰（写作的稿子不该被工具改排版）。\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nimport { spawnSync } from \"node:child_process\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst f = String((j.tool_input || {}).file_path || \"\");\nif (!f || !fs.existsSync(f)) process.exit(0);\nconst ext = path.extname(f).toLowerCase();\nconst T = {\n  \".py\": [[\"ruff\", \"format\", \"-q\"], [\"black\", \"-q\"]],\n  \".js\": [[\"prettier\", \"--write\", \"--log-level\", \"warn\"]], \".mjs\": 0, \".cjs\": 0, \".jsx\": 0, \".ts\": 0, \".tsx\": 0,\n  \".json\": 0, \".css\": 0, \".scss\": 0, \".html\": 0, \".vue\": 0, \".yaml\": 0, \".yml\": 0,\n  \".go\": [[\"gofmt\", \"-w\"]], \".rs\": [[\"rustfmt\", \"-q\"]],\n  \".c\": [[\"clang-format\", \"-i\"]], \".h\": 0, \".cc\": 0, \".cpp\": 0, \".hpp\": 0,\n  \".sh\": [[\"shfmt\", \"-w\"]],\n};\nlet list = T[ext];\nif (list === 0) list = [\".c\", \".h\", \".cc\", \".cpp\", \".hpp\"].includes(ext) ? T[\".c\"] : T[\".js\"];\nif (!list) process.exit(0);\nconst has = (b) => (process.env.PATH || \"\").split(\":\").some((d) => { try { fs.accessSync(path.join(d, b), fs.constants.X_OK); return true; } catch { return false; } });\nconst tool = list.find(([b]) => has(b));\nif (tool) spawnSync(tool[0], [...tool.slice(1), f], { stdio: \"ignore\", timeout: 20000 });\n","cc-guard-bash.mjs":"// cccodroid 内置 hook（用工具之前，只管 Bash）：命令里出现这些内容就拦下。\n// 用法：node cc-guard-bash.mjs 'git push --force' '/git\\s+reset\\s+--hard/'\n// 普通写法按字面查找（空白宽松匹配）；写成 /…/ 就当正则。命中退出码 2，并告诉 Claude 原因。\nimport fs from \"node:fs\";\nconst pats = process.argv.slice(2).filter(Boolean);\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cmd = String((j.tool_input || {}).command || \"\");\nif (!cmd) process.exit(0);\nconst flat = cmd.replace(/\\s+/g, \" \");\nconst hit = pats.find((p) => {\n  const m = /^\\/(.+)\\/([a-z]*)$/.exec(p);\n  if (m) { try { return new RegExp(m[1], m[2]).test(cmd); } catch { return false; } }\n  return flat.includes(p.replace(/\\s+/g, \" \"));\n});\nif (hit) {\n  process.stderr.write(`这条命令触发了禁止规则「${hit}」，已拦下：\\n${cmd.slice(0, 300)}\\n换一种更安全的做法；如果确实需要，请让用户自己执行。\\n`);\n  process.exit(2);\n}\n","cc-guard-files.mjs":"// cccodroid 内置 hook（用工具之前）：不许 Claude 改动匹配这些模式的文件。\n// 用法：node cc-guard-files.mjs '.env' '*.pem' 'secrets/**'\n// 模式不带 / 时比对文件名，带 / 时比对完整路径；* 不跨目录，** 跨目录。命中就退出码 2 拦下，并告诉 Claude 原因。\nimport fs from \"node:fs\";\nconst pats = process.argv.slice(2).filter(Boolean);\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst i = j.tool_input || {};\nconst f = String(i.file_path || i.notebook_path || \"\");\nif (!f) process.exit(0);\nconst rx = (p) => new RegExp(\"^\" + p.replace(/[.+^${}()|[\\]\\\\]/g, \"\\\\$&\").replace(/\\*\\*/g, \"\\0\").replace(/\\*/g, \"[^/]*\")\n  .replace(/\\?/g, \"[^/]\").replace(/\\0/g, \".*\") + \"$\");\nconst base = f.split(\"/\").pop();\nconst hit = pats.find((p) => rx(p).test(p.includes(\"/\") ? f : base) || (p.includes(\"/\") && rx(\"**/\" + p).test(f)));\nif (hit) {\n  process.stderr.write(`这个文件受保护（规则「${hit}」），不要修改：${f}\\n如果确实需要改，请告诉用户，让用户自己处理。\\n`);\n  process.exit(2);\n}\n"};

function hookSettingsFile(scope, dir) {
  if (scope === "user") return path.join(CFG.home, ".claude", "settings.json");
  const d = path.resolve(String(dir || CFG.workspace));
  let ok = false;
  try { ok = fs.statSync(d).isDirectory(); } catch {}
  if (!ok) throw new Error("project dir not found: " + d);
  return path.join(d, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}
function readSettingsFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { j: {}, exists: false }; return { error: e.message, exists: true }; }
  if (!txt.trim()) return { j: {}, exists: true };
  try {
    const j = JSON.parse(txt);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
    return { j, exists: true };
  } catch (e) { return { error: e.message, badJson: true, exists: true }; }
}
function listHooks(dir) {
  const scopes = [];
  for (const scope of ["user", "project", "local"]) {
    let file;
    try { file = hookSettingsFile(scope, dir); } catch (e) { scopes.push({ scope, error: e.message }); continue; }
    const r = readSettingsFile(file);
    const h = r.j && r.j.hooks;
    scopes.push({ scope, file, exists: r.exists, error: r.error, badJson: !!r.badJson,
      hooks: h && typeof h === "object" && !Array.isArray(h) ? h : {}, disableAll: !!(r.j && r.j.disableAllHooks) });
  }
  return { scopes, events: HOOK_EVENTS, workspace: CFG.workspace, dir: path.resolve(String(dir || CFG.workspace)), scriptsDir: HOOK_SCRIPTS_DIR };
}
/** 界面送回来的整份 hooks：结构不对就拒绝；空组、空命令剔掉；不认识的字段（prompt / http 类 hook 等）原样留着 */
function cleanHooks(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("hooks must be an object");
  const out = {};
  for (const [ev, groups] of Object.entries(h)) {
    if (!/^[A-Za-z]+$/.test(ev)) throw new Error("bad event name: " + ev);
    if (!Array.isArray(groups)) throw new Error(ev + " must be an array");
    const gs = [];
    for (const g of groups) {
      if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) throw new Error(ev + ": every entry needs a hooks array");
      const hs = g.hooks.filter((x) => x && typeof x === "object" && x.type && !(x.type === "command" && !String(x.command || "").trim()));
      if (!hs.length) continue;
      const ng = { ...g, hooks: hs };
      if (ng.matcher === "" || ng.matcher == null) delete ng.matcher;
      gs.push(ng);
    }
    if (gs.length) out[ev] = gs;
  }
  return out;
}
function saveHooks({ scope, dir, hooks, disableAll }) {
  if (!["user", "project", "local"].includes(scope)) throw new Error("bad scope");
  const file = hookSettingsFile(scope, dir);
  const clean = hooks === undefined ? undefined : cleanHooks(hooks);
  const job = EXT_LOCK.then(() => {
    const r = readSettingsFile(file);
    if (r.error) { const e = new Error(r.error); e.code = r.badJson ? "badjson" : "read"; throw e; }
    const j = r.j;
    if (clean !== undefined) { if (Object.keys(clean).length) j.hooks = clean; else delete j.hooks; }
    if (disableAll !== undefined) { if (disableAll) j.disableAllHooks = true; else delete j.disableAllHooks; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (r.exists) { try { fs.copyFileSync(file, file + ".bak"); } catch {} }
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
    fs.renameSync(tmp, file);
    log(`hooks 已保存：${file}`);
    return { ok: true, file };
  });
  EXT_LOCK = job.catch(() => {});
  return job;
}
function installHookScripts() {
  fs.mkdirSync(HOOK_SCRIPTS_DIR, { recursive: true });
  for (const [name, src] of Object.entries(HOOK_SCRIPTS)) fs.writeFileSync(path.join(HOOK_SCRIPTS_DIR, name), src);
  return { ok: true, dir: HOOK_SCRIPTS_DIR };
}
/** 试运行用的 stdin：照 claude 真实传给 hook 的 JSON 造一份（工具类事件按匹配规则挑个像样的工具） */
function hookSample(ev, matcher, cwd) {
  const base = { session_id: "cccodroid-test", transcript_path: "", cwd, permission_mode: "default", hook_event_name: ev };
  const m = String(matcher || "");
  const tool = !m || m === "*" || /Bash/.test(m) ? "Bash" : /Write/.test(m) ? "Write" : /Edit/.test(m) ? "Edit" : (m.match(/[A-Za-z_]+/) || ["Bash"])[0];
  const input = tool === "Bash" ? { command: "echo hello", description: "test" }
    : tool === "Write" ? { file_path: path.join(cwd, "hook-test.txt"), content: "hello\n" }
    : tool === "Edit" ? { file_path: path.join(cwd, "hook-test.txt"), old_string: "hello", new_string: "hi" } : {};
  switch (ev) {
    case "PreToolUse": case "PermissionRequest": return { ...base, tool_name: tool, tool_input: input };
    case "PostToolUse": return { ...base, tool_name: tool, tool_input: input, tool_response: tool === "Bash" ? { stdout: "hello", stderr: "", interrupted: false } : { success: true } };
    case "PostToolUseFailure": return { ...base, tool_name: tool, tool_input: input, error: "test error" };
    case "UserPromptSubmit": return { ...base, prompt: "这是一条测试消息" };
    case "Stop": case "SubagentStop": return { ...base, stop_hook_active: false };
    case "SessionStart": return { ...base, source: m && !/[|*]/.test(m) ? m : "startup" };
    case "SessionEnd": return { ...base, reason: "other" };
    case "Notification": return { ...base, message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" };
    case "PreCompact": case "PostCompact": return { ...base, trigger: "manual", custom_instructions: "" };
    default: return base;
  }
}
function testHook({ command, event, matcher, dir, input, timeout }) {
  command = String(command || "");
  if (!command.trim()) throw new Error("empty command");
  let cwd = path.resolve(String(dir || CFG.workspace));
  try { if (!fs.statSync(cwd).isDirectory()) cwd = CFG.home; } catch { cwd = CFG.home; }
  let stdin = input != null && String(input).trim() ? String(input) : JSON.stringify(hookSample(String(event || ""), matcher, cwd), null, 2);
  const ms = Math.max(1, Math.min(60, Number(timeout) || 30)) * 1000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(ensureShell(), ["-c", command], {
      cwd, env: { ...termEnv(), CLAUDE_PROJECT_DIR: cwd }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let out = "", err = "", timedOut = false;
    const cap = (s, d) => (s.length < 64 * 1024 ? s + d : s);
    child.stdout.on("data", (d) => (out = cap(out, d)));
    child.stderr.on("data", (d) => (err = cap(err, d)));
    const tm = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    child.on("close", (code) => { clearTimeout(tm); resolve({ ok: true, code, stdout: out, stderr: err, ms: Date.now() - t0, timedOut, input: stdin }); });
    child.on("error", (e) => { clearTimeout(tm); resolve({ ok: true, code: -1, stdout: out, stderr: err + e.message, ms: Date.now() - t0, timedOut, input: stdin }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

const SKILLS_DIR = path.join(CFG.home, ".claude", "skills");
// SKILL.md 开头的 YAML：只取顶层的单个键；支持 description: > / | 这类多行块
function fmField(md, k) {
  const fm = String(md).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const lines = fm[1].split("\n"), i = lines.findIndex((l) => l.startsWith(k + ":"));
  if (i < 0) return "";
  const v = lines[i].slice(k.length + 1).trim();
  if (!/^[>|][+-]?$/.test(v)) return v.replace(/^["']|["']$/g, "").trim();
  const body = [];
  for (const l of lines.slice(i + 1)) { if (l.trim() && !/^\s/.test(l)) break; body.push(l.trim()); }
  return (v[0] === ">" ? body.join(" ") : body.join("\n")).replace(/\s+$/, "").trim();
}
function skillMeta(dir) {
  try {
    const s = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").slice(0, 4000);
    return { name: fmField(s, "name"), description: fmField(s, "description").slice(0, 300) };
  } catch { return null; }
}
function listSkills() {
  let ents = [];
  try { ents = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  // 哪些是组件带来的：组件的安装记录里有 skill 名（分类索引条分「组件自带 / 自己装的」）
  const fromComp = new Map();
  try { for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) { const r = compRecord(f.slice(0, -5)); if (r && r.skill) fromComp.set(r.skill, f.slice(0, -5)); } } catch {}
  return ents.filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => {
    const m = skillMeta(path.join(SKILLS_DIR, d.name));
    // 组件技能的 SKILL.md 是中文写的（给 Claude 看的触发说明）：非中文界面显示组件索引里的英文简介
    const cid = fromComp.get(d.name) || "", ce = cid && compIndexCache.data && compIndexCache.data.components[cid];
    return m ? { dir: d.name, name: m.name || d.name, description: m.description, descEn: (ce && ce.desc && ce.desc.en) || "", component: cid, official: (skillSource(d.name) || {}).repo === SKILL_REPO } : null;
  }).filter(Boolean);
}
function deleteSkill(dir) {
  if (!SID_RE.test(dir)) return { ok: false, message: "bad name" };
  const p = path.join(SKILLS_DIR, dir);
  if (!fs.existsSync(path.join(p, "SKILL.md"))) return { ok: false, message: "not found" };
  fs.rmSync(p, { recursive: true, force: true });
  return { ok: true };
}
// ── 官方目录：技能（anthropics/skills）与 MCP 注册表（registry.modelcontextprotocol.io）──
// 只读公开目录；装卸都落在用户自己的 ~/.claude：技能拷进 skills/，MCP 走 claude mcp add（见 addMcp）。
const SKILL_REPO = "anthropics/skills";
let skillCat = null;                 // { at, sha, items }：一小时内复用，GitHub 未登录的 API 一小时只给 60 次
const ghGet = async (url, json) => {
  const r = await fetch(url, { headers: { "User-Agent": "cccodroid", ...(json ? { Accept: "application/vnd.github+json" } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return json ? r.json() : Buffer.from(await r.arrayBuffer());
};
async function skillCatalog(force) {
  if (!force && skillCat && Date.now() - skillCat.at < 3600e3) return skillCat;
  const tree = await ghGet(`https://api.github.com/repos/${SKILL_REPO}/git/trees/HEAD?recursive=1`, true);
  const blobs = (tree.tree || []).filter((e) => e.type === "blob");
  const names = [...new Set(blobs.map((e) => /^skills\/([^/]+)\/SKILL\.md$/.exec(e.path)?.[1]).filter((n) => n && SID_RE.test(n)))].sort();
  const items = await Promise.all(names.map(async (n) => {
    const files = blobs.filter((e) => e.path.startsWith(`skills/${n}/`)).map((e) => ({ path: e.path.slice(`skills/${n}/`.length), size: e.size || 0 }));
    let meta = { name: n, description: "" };
    try {
      const md = String(await ghGet(`https://raw.githubusercontent.com/${SKILL_REPO}/${tree.sha}/skills/${n}/SKILL.md`)).slice(0, 4000);
      meta = { name: fmField(md, "name") || n, description: fmField(md, "description").slice(0, 300) };
    } catch {}
    return { dir: n, ...meta, files, bytes: files.reduce((a, x) => a + x.size, 0), license: files.some((x) => /^LICENSE/i.test(x.path)) };
  }));
  return (skillCat = { at: Date.now(), sha: tree.sha, items });
}
const skillSource = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, dir, ".cc-source.json"), "utf8")); } catch { return null; } };
async function listSkillCatalog(force) {
  try {
    const c = await skillCatalog(force);
    return { ok: true, repo: SKILL_REPO, items: c.items.map(({ files, ...x }) => ({ ...x,
      installed: fs.existsSync(path.join(SKILLS_DIR, x.dir, "SKILL.md")), official: (skillSource(x.dir) || {}).repo === SKILL_REPO })) };
  } catch (e) { return { ok: false, message: tz("取不到官方技能目录：{err}", { err: e.message }) }; }
}
/** 装一个官方技能：按目录树逐个下载到临时目录，齐了再改名就位（不会留下半截）；超过 50 MB 不装 */
async function installCatalogSkill(dir) {
  if (!SID_RE.test(dir)) return { ok: false, message: "bad name" };
  const c = await skillCatalog().catch((e) => null);
  const it = c && c.items.find((x) => x.dir === dir);
  if (!it) return { ok: false, message: tz("官方目录里没有这个技能") };
  const dest = path.join(SKILLS_DIR, dir);
  if (fs.existsSync(dest)) return { ok: false, message: tz("已经有同名技能，先删掉再装") };
  if (it.bytes > 50 << 20) return { ok: false, message: tz("太大了（超过 50 MB）") };
  const tmp = path.join(SKILLS_DIR, `.tmp-${dir}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const f of it.files) {
      const out = path.resolve(tmp, f.path);
      if (!out.startsWith(tmp + path.sep)) throw new Error("bad path " + f.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, await ghGet(`https://raw.githubusercontent.com/${SKILL_REPO}/${c.sha}/skills/${dir}/${f.path.split("/").map(encodeURIComponent).join("/")}`));
    }
    fs.writeFileSync(path.join(tmp, ".cc-source.json"), JSON.stringify({ repo: SKILL_REPO, sha: c.sha, path: "skills/" + dir, at: new Date().toISOString() }) + "\n");
    fs.renameSync(tmp, dest);
    return { ok: true };
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, message: e.message }; }
}

// MCP 注册表：任何人都能发布，没人审 —— 界面写明，装 npm 包前把命令亮给人看。
// 本机能直接用的两种：远程（streamable-http / sse）和 npm 包（npx 起 stdio）。pypi / docker 的标成装不了
const onPath = (bin) => String(claudeEnv().PATH || "").split(":").some((d) => d && fs.existsSync(path.join(d, bin)));
async function listMcpCatalog(q, cursor) {
  const u = new URL("https://registry.modelcontextprotocol.io/v0/servers");
  u.searchParams.set("version", "latest"); u.searchParams.set("limit", "30");
  if (q) u.searchParams.set("search", String(q).slice(0, 100));
  if (cursor) u.searchParams.set("cursor", String(cursor).slice(0, 300));
  let j;
  try { j = await ghGet(u.href, true); } catch (e) { return { ok: false, message: tz("取不到 MCP 注册表：{err}", { err: e.message }) }; }
  const field = (x) => ({ name: String(x.name || ""), description: String(x.description || "").slice(0, 200), required: !!x.isRequired, secret: !!x.isSecret });
  const items = (j.servers || []).map(({ server: v }) => {
    const options = [
      ...(v.remotes || []).filter((r) => ["streamable-http", "sse"].includes(r.type) && /^https:\/\//.test(r.url || "")).map((r) => ({
        kind: "remote", transport: r.type === "sse" ? "sse" : "http", target: r.url, headers: (r.headers || []).map(field) })),
      ...(v.packages || []).filter((p) => p.registryType === "npm" && (p.transport?.type || "stdio") === "stdio" && /^[@a-z0-9][\w./@-]*$/i.test(p.identifier || "")).map((p) => ({
        kind: "npm", transport: "stdio", package: p.identifier, version: p.version || "",
        target: ["npx", "-y", p.identifier + (p.version ? "@" + p.version : ""),
          ...(p.packageArguments || []).filter((a) => a.type === "positional" && (a.value || a.default)).map((a) => String(a.value || a.default))].join(" "),
        env: (p.environmentVariables || []).map(field) })),
    ];
    const other = [...new Set((v.packages || []).filter((p) => p.registryType !== "npm").map((p) => p.registryType))];
    return { name: v.name, title: v.title || "", description: String(v.description || "").slice(0, 300), version: v.version || "",
      homepage: (v.repository && v.repository.url) || v.websiteUrl || "", options, other };
  });
  return { ok: true, items, next: (j.metadata && j.metadata.nextCursor) || "", npx: onPath("npx") };
}

/** 从 zip 装技能：包里找 SKILL.md，它所在的目录就是技能根（兼容「包一层文件夹」和「直接打包」两种） */
function importSkill(buf) {
  const files = zipRead(buf);
  const md = files.filter((f) => /(^|\/)SKILL\.md$/.test(f.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!md) throw new Error(tz("压缩包里没有 SKILL.md"));
  const root = md.name.slice(0, md.name.length - "SKILL.md".length);
  const text = md.data.toString("utf8");
  const nm = (text.match(/^---\n[\s\S]*?^name:\s*(.+)$/m) || [])[1];
  const dir = String(nm || root.replace(/\/$/, "").split("/").pop() || "skill").trim().replace(/^["']|["']$/g, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  if (!SID_RE.test(dir) || dir === "." || dir === "..") throw new Error(tz("技能名不合法"));
  const dst = path.join(SKILLS_DIR, dir);
  if (fs.existsSync(dst)) throw new Error(tz("已有同名技能「{name}」，先删掉旧的", { name: dir }));
  for (const f of files) {
    if (!f.name.startsWith(root)) continue;
    const rel = f.name.slice(root.length);
    if (!rel || rel.split("/").some((x) => !x || x === "." || x === "..")) continue;
    const out = path.join(dst, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data);
  }
  return { ok: true, dir };
}

// ── 访问控制 ──────────────────────────────────────────────────────────
// 只监听 127.0.0.1 在安卓上不是安全边界：同机任何有联网权限的应用都能连 127.0.0.1，
// 手机浏览器里的网页也能向它发"简单请求"（text/plain 的 POST 不触发 CORS 预检）。
// 而 /api/chat 等于本机任意命令执行，经 priv 还能拿到 Shizuku 的 shell 身份。所以：
//   1. Host 必须是 127.0.0.1:端口 / localhost:端口 —— 挡 DNS 重绑定；
//   2. 带 Origin 的请求必须来自本页 —— 挡网页跨站发请求；
//   3. /api/* 必须带令牌：X-CC-Token 头，或 cc_t_<端口> Cookie（宿主 WebView 首次加载首页时带 ?t=令牌 换来）。
//      令牌在应用私有目录里（0600），别的应用读不到；首页带对 ?t= 时种一个 HttpOnly + SameSite=Strict 的 Cookie，
//      之后界面的 fetch / EventSource / <img src> 都自动带上，前端不用改。
//   令牌跨网关重启保持不变（WebView 不会因为网关重启掉线）；删掉文件即轮换。
const TOKEN_FILE = process.env.CCAPP_TOKEN_FILE || path.join(CFG.home, ".gateway-token");
const TOKEN = (() => {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) { try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {} return t; }
  } catch {}
  const t = crypto.randomBytes(32).toString("hex");
  try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); } catch {}
  const tmp = TOKEN_FILE + ".tmp";
  fs.writeFileSync(tmp, t + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  return t;
})();
// Cookie 不按端口隔离：同一个浏览器里开着两个网关（开发端 8790 + cccodroid 8791）时，同名 Cookie 会互相覆盖，
// 所以名字里带上端口
const COOKIE = `cc_t_${CFG.port}`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${CFG.port}`, `localhost:${CFG.port}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

function tokenOk(t) {
  if (typeof t !== "string" || t.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
function cookieToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie || "");
  return m ? m[1] : "";
}
const denyLog = { at: 0, n: 0 };
/** 返回 null 表示放行；否则返回拒绝的状态码 */
function denyReason(req, u) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) return 421;
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) return 403;
  if (!u.pathname.startsWith("/api/")) return null;          // 静态页面与资源不含秘密
  if (tokenOk(String(req.headers["x-cc-token"] || "")) || tokenOk(cookieToken(req))) return null;
  return 403;
}

// ── 路由 ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${CFG.port}`);
  const p = u.pathname;

  const deny = denyReason(req, u);
  if (deny) {
    // 限流：别的应用能连上来狂刷，别让它把 gateway.log 撑爆
    const now = Date.now();
    if (now - denyLog.at > 10000) {
      log(`拒绝请求 ${req.method} ${p} → ${deny}（host=${req.headers.host || "-"} origin=${req.headers.origin || "-"}）` +
        (denyLog.n ? `；此前 10 秒内另有 ${denyLog.n} 次被拒` : ""));
      denyLog.at = now; denyLog.n = 0;
    } else denyLog.n++;
    req.resume();
    return sendJson(res, deny, { error: deny === 421 ? "bad host" : "forbidden" });
  }
  // 宿主 WebView 首次加载首页时带 ?t=令牌：种 Cookie，之后同源请求自动带上
  if (req.method === "GET" && (p === "/" || p === "/index.html") && tokenOk(u.searchParams.get("t") || "")) {
    res.setHeader("Set-Cookie", `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
  }

  try {
    if (req.method === "POST" && p === "/api/safe-mode") {
      const b = JSON.parse((await readBody(req)) || "{}");
      setSafeMode(!!b.on);
      return sendJson(res, 200, { ok: true, safeMode: safeMode() });
    }
    if (req.method === "GET" && p === "/api/issue-draft") return sendJson(res, 200, await issueDraft(reqLang(req)));
    if (req.method === "GET" && p === "/api/ledger") {
      return sendJson(res, 200, { items: readLedger(Number(u.searchParams.get("n")) || 100) });
    }

    if (req.method === "GET" && p === "/api/status") {
      return sendJson(res, 200, {
        app: "claude-cli",
        product: PREFIX ? "cccodroid" : "Claude CLI",   // 界面标题
        pid: process.pid,
        ready: fs.existsSync(PATHS.claude) && fs.existsSync(PATHS.loader),
        // 登录态厂商也算"就绪"：它不用密钥，用的是 claude 自己的 OAuth 登录
        hasKey: !!API_KEY || !!PROVIDER.login,
        keyMode: API_KEY ? "key" : (PROVIDER.login ? "login" : "none"),
        model: SETTINGS.model || PROVIDER.defaultModel || null,
        provider: PROVIDER.id,
        providerLabel: PROVIDER.label || PROVIDER.id,
        upstream: CFG.upstream,
        nativeModels: !!PROVIDER.nativeModels,
        workspace: CFG.workspace,
        runtime: CFG.runtime,
        bridge: await bridgeAlive(),
        uptimeMs: Math.round(process.uptime() * 1000),
        version: "3.0.0",
        busy: RUNS.size > 0,
        running: RUNS.size,
        queued: QUEUE.length,
        safeMode: safeMode(),
        hasLedger: !!process.env.CCAPP_LEDGER,
        uiTag: uiTag(),
        lastSessionId: LAST_SESSION ? LAST_SESSION.id : null,
        lastSessionAt: LAST_SESSION ? LAST_SESSION.at : null,
      });
    }

    // 老接口：只存密钥。新界面走 /api/providers/save
    if (req.method === "POST" && p === "/api/key") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const k = String(b.apiKey || "").trim();
      if (!k) return sendJson(res, 400, { error: "empty" });
      const r = upsertProvider(b.provider ? String(b.provider) : PROVIDER.id, { apiKey: k });
      return sendJson(res, r.error ? 400 : 200, r);
    }

    // ── 厂商列表（供界面切换用）──
    if (req.method === "GET" && p === "/api/providers") {
      const list = Object.entries(PROVIDERS_CFG.providers).map(([id, v]) => providerView(id, v));
      return sendJson(res, 200, {
        active: PROVIDER.id,
        configFile: PROVIDERS_FILE,
        configFound: fs.existsSync(PROVIDERS_FILE),
        providers: list,
      });
    }
    // 存一家：预置厂商只收密钥 / 线路 / 默认模型；自定义厂商收全部字段，id 为空就新建
    if (req.method === "POST" && p === "/api/providers/save") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const r = upsertProvider(b.id ? String(b.id) : null, b);
      return sendJson(res, r.error ? 400 : 200, r);
    }
    if (req.method === "POST" && p === "/api/providers/delete") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const id = String(b.id || "");
      if (id === PROVIDER.id && RUNS.size) return sendJson(res, 409, { error: "busy", message: tz("这一家正在用，等这一轮跑完再删。") });
      if (PRESETS[id]) {
        // 预置厂商删不掉，只清空用户字段（密钥等）
        delete PROVIDERS_RAW.providers[id];
      } else if (PROVIDERS_RAW.providers[id]) {
        delete PROVIDERS_RAW.providers[id];
        if (SETTINGS.provider === id) { SETTINGS.provider = null; SETTINGS.model = null; saveSettings(); }
      } else return sendJson(res, 404, { error: "unknown provider" });
      saveProvidersRaw();
      applyProvider();
      MODELS = null; MODELS_FOR = null;
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/providers/test") {
      const b = JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 200, await testProvider(String(b.id || PROVIDER.id)));
    }

    if (req.method === "GET" && p === "/api/billing") {
      return sendJson(res, 200, await billingInfo(String(u.searchParams.get("id") || PROVIDER.id), u.searchParams.get("refresh") === "1"));
    }

    // ── 设置 ──
    if (p === "/api/settings") {
      if (req.method === "GET") return sendJson(res, 200, { ...SETTINGS, maxParallel: maxParallel(), maxParallelCap: MAX_PARALLEL_CAP, workspace: CFG.workspace, outputStyles: outputStyles() });
      if (req.method === "POST") {
        const b = JSON.parse((await readBody(req)) || "{}");
        for (const k of ["model", "outputStyle", "effort", "appendSystemPrompt"]) {
          if (k in b) SETTINGS[k] = b[k] || null;
        }
        // 权限模式只收 claude 认的值；正在跑的那一轮也当场切过去
        if ("permissionMode" in b && b.permissionMode !== SETTINGS.permissionMode) setPermMode(String(b.permissionMode || "default"));
        if (b.permNotice === false) SETTINGS.permNotice = false;
        if (Array.isArray(b.addDirs)) SETTINGS.addDirs = b.addDirs.filter((d) => typeof d === "string");
        if (Array.isArray(b.allowedTools)) SETTINGS.allowedTools = b.allowedTools;
        if (Array.isArray(b.disallowedTools)) SETTINGS.disallowedTools = b.disallowedTools;
        if (b.memGuard && typeof b.memGuard === "object") {
          const g = SETTINGS.memGuard || {};
          SETTINGS.memGuard = {
            enabled: "enabled" in b.memGuard ? !!b.memGuard.enabled : !!g.enabled,
            whitelist: Array.isArray(b.memGuard.whitelist)
              ? [...new Set(b.memGuard.whitelist.map((x) => String(x).trim()).filter((x) => /^[A-Za-z][\w]*(\.[\w]+)+$/.test(x)))]
              : (g.whitelist || []),
          };
        }

        if ("staticCompat" in b) { SETTINGS.staticCompat = !!b.staticCompat; try { customRefresh(); } catch {} }   // 下一轮生效；自定义组件的入口立刻跟着改
        if ("idleCompaction" in b) { SETTINGS.idleCompaction = !!b.idleCompaction; if (!SETTINGS.idleCompaction) idleDisarmAll(); }

        if ("maxParallel" in b) {
          const n = Math.round(Number(b.maxParallel));
          SETTINGS.maxParallel = Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARALLEL_CAP, n)) : 3;
          setImmediate(() => { publishState(); pump(); });   // 调大了马上放行排着的
        }

        // 自动压缩窗口：数字就设，空/0 就清除（交回给 claude 自己决定）
        if ("autoCompactWindow" in b) {
          const n = Number(b.autoCompactWindow);
          SETTINGS.autoCompactWindow = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        }

        // ── 换厂商 ──
        //  正在生成时**不许切**：此刻 claude 进程肚子里还揣着上一家的密钥和模型名，
        //  它后续每一轮工具调用都要回网关 —— 桥一换上游，它就拿着 A 家的钥匙去敲 B 家的门。
        //  以前没这道闸，"连发消息 + 切厂商"叠在一起就是一场 401 暴雨。
        if ("provider" in b) {
          const want = b.provider ? String(b.provider) : null;
          const known = want && (want === BUILTIN_PROVIDER.id || (PROVIDERS_CFG && PROVIDERS_CFG.providers[want]));
          if (want && !known) return sendJson(res, 400, { error: "unknown provider", provider: want });

          if (want !== PROVIDER.id) {
            if (RUNS.size) {
              return sendJson(res, 409, {
                error: "busy",
                message: tz("这一轮还在生成中，等它跑完再切厂商（切换会换掉正在用的密钥与模型）。"),
              });
            }
            SETTINGS.provider = want;
            SETTINGS.model = null;          // 别把上一家的模型名带过去
            applyProvider();
            // 上游热切 —— 不重启桥，也就没有断流窗口
            await setBridgeUpstream(CFG.upstream);
            log(`已切换厂商 → ${PROVIDER.id}  上游 ${CFG.upstream}  ` +
                `${API_KEY ? "有密钥" : (PROVIDER.login ? "走登录态" : "无密钥")}`);
          }
        }

        saveSettings();
        log(`设置已更新 provider=${PROVIDER.id} model=${SETTINGS.model || "(默认)"} effort=${SETTINGS.effort} autoCompact=${SETTINGS.autoCompactWindow || "(默认)"}`);
        return sendJson(res, 200, { ok: true, settings: SETTINGS, provider: PROVIDER.id, upstream: CFG.upstream });
      }
    }

    // ── 会话 ──
    if (req.method === "GET" && p === "/api/sessions/search") {
      return sendJson(res, 200, await searchSessions(String(u.searchParams.get("q") || "")));
    }
    if (req.method === "GET" && p === "/api/sessions") {
      const list = listSessions();
      return sendJson(res, 200, { sessions: list, workspace: CFG.workspace, count: list.length });
    }

    // ── 扩展：插件 / 市场 / MCP / 技能 ──
    if (p.startsWith("/api/ext/")) {
      const body = req.method === "POST" && p !== "/api/ext/skills/import" ? JSON.parse((await readBody(req)) || "{}") : {};
      try {
        if (req.method === "GET" && p === "/api/ext/plugins") {
          return sendJson(res, 200, await listPlugins(u.searchParams.get("q"), Number(u.searchParams.get("offset")) || 0, u.searchParams.get("available") === "1"));
        }
        if (req.method === "POST" && p === "/api/ext/plugins/install") {
          const r = await installPlugin(String(body.id || ""), body.accept ? String(body.accept) : null);
          if (r.ok) log(`装了插件 ${body.id}`);
          return sendJson(res, 200, r);
        }
        const op = p.match(/^\/api\/ext\/plugins\/(uninstall|enable|disable)$/);
        if (req.method === "POST" && op) {
          const r = await pluginOp(op[1], String(body.id || ""));
          if (r.ok) log(`插件 ${op[1]} ${body.id}`);
          return sendJson(res, 200, r);
        }
        if (req.method === "GET" && p === "/api/ext/marketplaces") return sendJson(res, 200, { items: await listMarketplaces() });
        if (req.method === "POST" && p === "/api/ext/marketplaces/add") return sendJson(res, 200, await marketplaceOp("add", String(body.source || "").trim()));
        if (req.method === "POST" && p === "/api/ext/marketplaces/remove") return sendJson(res, 200, await marketplaceOp("remove", String(body.name || "")));
        if (req.method === "GET" && p === "/api/ext/mcp") return sendJson(res, 200, { items: await listMcp() });
        if (req.method === "POST" && p === "/api/ext/mcp/add") return sendJson(res, 200, await addMcp(body));
        if (req.method === "POST" && p === "/api/ext/mcp/remove") return sendJson(res, 200, await removeMcp(body.name));
        if (req.method === "GET" && p === "/api/ext/skills") {
          if (PREFIX) await compIndex(false).catch(() => {});   // 组件技能的英文简介来自索引（有缓存，一般不联网）
          return sendJson(res, 200, { items: listSkills(), dir: SKILLS_DIR });
        }
        if (req.method === "GET" && p === "/api/ext/catalog/skills") return sendJson(res, 200, await listSkillCatalog(u.searchParams.get("refresh") === "1"));
        if (req.method === "POST" && p === "/api/ext/catalog/skills/install") return sendJson(res, 200, await installCatalogSkill(String(body.dir || "")));
        if (req.method === "GET" && p === "/api/ext/catalog/mcp") return sendJson(res, 200, await listMcpCatalog(u.searchParams.get("q"), u.searchParams.get("cursor")));
        if (req.method === "POST" && p === "/api/ext/skills/delete") return sendJson(res, 200, deleteSkill(String(body.dir || "")));
        if (req.method === "GET" && p === "/api/ext/hooks") return sendJson(res, 200, listHooks(u.searchParams.get("dir")));
        if (req.method === "POST" && p === "/api/ext/hooks/save") {
          try { return sendJson(res, 200, await saveHooks(body)); }
          catch (e) { return sendJson(res, 200, { ok: false, code: e.code, message: e.message }); }
        }
        if (req.method === "POST" && p === "/api/ext/hooks/scripts") return sendJson(res, 200, installHookScripts());
        if (req.method === "POST" && p === "/api/ext/hooks/test") return sendJson(res, 200, await testHook(body));
        if (req.method === "POST" && p === "/api/ext/skills/import") return sendJson(res, 200, importSkill(await readBodyBuf(req, 64 * 1024 * 1024)));
      } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
      return sendJson(res, 404, { error: "not found" });
    }

    // ── 会话管理：批量进回收站 / 回收站 / 导出 / 导入 ──
    if (req.method === "POST" && p === "/api/sessions/trash") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const done = [], failed = [];
      for (const id of [].concat(b.ids || [])) {
        if (runOfSession(id)) { failed.push(id); continue; }
        try { (trashSession(String(id)).ok ? done : failed).push(id); } catch { failed.push(id); }
      }
      if (done.length) log(`${done.length} 个会话进回收站`);
      return sendJson(res, 200, { ok: true, done, failed });
    }
    if (req.method === "GET" && p === "/api/trash") {
      return sendJson(res, 200, { items: listTrash(), keepDays: TRASH_KEEP_DAYS });
    }
    if (req.method === "POST" && p === "/api/trash/restore") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const done = [], failed = [];
      for (const id of [].concat(b.ids || [])) {
        let r; try { r = restoreSession(String(id)); } catch (e) { r = { ok: false, error: e.message }; }
        (r.ok ? done : failed).push(r.ok ? id : { id, error: r.error });
      }
      return sendJson(res, 200, { ok: true, done, failed });
    }
    if (req.method === "POST" && p === "/api/trash/purge") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const ids = b.all ? listTrash().map((m) => m.id) : [].concat(b.ids || []).map(String);
      const n = purgeTrash(ids);
      log(`回收站：彻底删除 ${n} 个会话`);
      return sendJson(res, 200, { ok: true, purged: n });
    }
    if (req.method === "POST" && p === "/api/sessions/export") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const ids = b.all ? listSessions(100000).map((x) => x.id) : [].concat(b.ids || []).map(String);
      try {
        const r = exportSessions(ids);
        log(`导出 ${r.count} 个会话 → ${r.file}`);
        return sendJson(res, 200, { ok: true, ...r, shared: !!process.env.CCAPP_SHARED && r.file.startsWith(process.env.CCAPP_SHARED) });
      } catch (e) { return sendJson(res, 400, { ok: false, message: e.message }); }
    }
    if (req.method === "POST" && p === "/api/sessions/import") {
      try {
        const r = importSessions(await readBodyBuf(req, 512 * 1024 * 1024));
        log(`导入会话：${r.imported.length} 个，跳过 ${r.skipped.length} 个`);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) { return sendJson(res, 400, { ok: false, message: e.message }); }
    }

    if (p.startsWith("/api/session/")) {
      const rest = decodeURIComponent(p.slice("/api/session/".length));
      const [id, action] = rest.split("/");
      const found = findSessionFile(id);

      if (req.method === "GET" && !action) {
        if (!found) return sendJson(res, 404, { error: "not found" });
        const meta = peekSession(found.file);
        const live = runOfSession(id);
        const page = await readSessionPage(found.file, {
          before: u.searchParams.has("before") ? Number(u.searchParams.get("before")) : null,
          limit: Math.min(200, Math.max(10, Number(u.searchParams.get("limit")) || 40)),
          // 正在生成的那一轮走事件总线，这里不重复给
          excludeFrom: Number(u.searchParams.get("exclude")) || (live ? live.startedAt : 0),
        });
        // 有子代理记录的 Agent 卡打个标，前端据此给「查看过程」
        const subs = agentFilesOf(found.file);
        if (subs.size) for (const it of page.items) if (it.role === "tool_use" && subs.has(it.id)) it.sub = true;
        return sendJson(res, 200, {
          id,
          title: NAMES[id] || meta.title,
          cwd: meta.cwd,
          items: page.items,
          cursor: page.cursor,
          size: page.size,
          contextTokens: page.contextTokens,
          liveRunId: live ? live.id : null,
          goal: u.searchParams.has("before") ? undefined : goalStateOf(found.file),
          tasks: u.searchParams.has("before") ? undefined : tasksOf(id),
        });
      }

      // 子代理的过程（按需取：点开 Agent 卡的「过程」才读）
      if (req.method === "GET" && action === "agent") {
        if (!found) return sendJson(res, 404, { error: "not found" });
        const f = agentFilesOf(found.file).get(String(u.searchParams.get("tool") || ""));
        if (!f) return sendJson(res, 200, { items: [] });
        const items = [];
        try {
          for (const l of fs.readFileSync(f, "utf8").split("\n")) {
            if (!l) continue;
            let ev; try { ev = JSON.parse(l); } catch { continue; }
            if (ev.type === "user" && typeof ev.message?.content === "string") continue;   // 第一条是主代理给它的提示，Agent 卡参数里已有
            for (const it of transcriptItems({ ...ev, isSidechain: false })) if (it.role !== "thinking" && it.role !== "user") items.push(it);
            if (items.length > 400) break;
          }
        } catch {}
        return sendJson(res, 200, { items });
      }

      if (req.method === "DELETE" && !action) {
        if (!found) return sendJson(res, 404, { error: "not found" });
        if (runOfSession(id)) return sendJson(res, 409, { error: "busy", message: tz("这个会话正在生成中。") });
        // 删除先进回收站（30 天内可恢复），彻底删除走 /api/trash/purge
        let r;
        try { r = trashSession(id); } catch (e) { return sendJson(res, 500, { error: e.message }); }
        if (r.ok) log(`会话进回收站 ${id.slice(0, 8)}`);
        return sendJson(res, r.ok ? 200 : 404, r);
      }

      if (req.method === "POST" && action === "rename") {
        const b = JSON.parse((await readBody(req)) || "{}");
        const name = String(b.title || "").trim().slice(0, 120);
        if (!name) return sendJson(res, 400, { error: "empty" });
        NAMES[id] = name; saveNames();
        return sendJson(res, 200, { ok: true, title: name });
      }

      // 回退到某条用户消息之前：文件（claude 检查点）+ 可选连对话一起（截到这条之前另起一个会话，原会话不动）
      if (req.method === "POST" && action === "rewind") {
        const b = JSON.parse((await readBody(req)) || "{}");
        if (runOfSession(id)) return sendJson(res, 409, { error: "busy", message: tz("这个会话正在生成中，等它答完再回退。") });
        const loc = locateUserTurn(id, String(b.userText || ""), b.after);
        if (!loc.ok) return sendJson(res, loc.status || 400, { error: "locate", message: loc.message });
        const uuid = loc.users[loc.best].uuid;
        // 真回退也先试算一次：要拿到会动哪些文件，回退后逐个核对（见 rewindFixup）
        const dry = uuid ? await rewindFiles(id, uuid, true) : { ok: false, error: "no uuid" };
        let files = dry;
        if (!b.dryRun && dry.ok && dry.canRewind !== false && (dry.filesChanged || []).length) {
          files = await rewindFiles(id, uuid, false);
          const fx2 = rewindFixup(loc.found.file, id, uuid, dry.filesChanged);
          if (fx2.fixed || fx2.failed) log(`回退补救：补写 ${fx2.fixed} 个，失败 ${fx2.failed} 个`);
          if (fx2.failed) files = { ok: false, error: tz("有 {n} 个文件没能还原", { n: fx2.failed }) };
          else files = { ...files, ok: true, canRewind: true, filesChanged: dry.filesChanged, insertions: dry.insertions, deletions: dry.deletions };
        }
        // 早于检查点的消息（或这一轮之后根本没改文件）claude 会说不能回退：代码这块就当「没有可撤销的」
        const fx = files.ok && files.canRewind !== false
          ? { canRewind: true, files: files.filesChanged || null, insertions: files.insertions || 0, deletions: files.deletions || 0 }
          : { canRewind: false, reason: String(files.error || "").slice(0, 300) };
        if (b.dryRun) return sendJson(res, 200, { ok: true, ...fx });
        if (!fx.canRewind && !b.conversation) return sendJson(res, 409, { error: "cannot", message: tz("这条消息之后的文件改动没有留底，没法撤销。") + (fx.reason ? "（" + fx.reason + "）" : "") });
        log(`回退 ${id.slice(0, 8)}：文件${fx.canRewind ? "已撤销" : "未动"}${b.conversation ? "，对话截到这条之前" : ""}`);
        let fork = null;
        if (b.conversation && loc.best === 0) fork = { ok: true, fresh: true };   // 退到第一条之前 = 空会话，前端直接开新会话
        else if (b.conversation) {
          fork = forkSession(id, String(b.userText || ""), b.after, { before: true });
          if (!fork.ok) return sendJson(res, fork.status || 400, { error: "fork", message: fork.message, files: fx });
        }
        return sendJson(res, 200, { ok: true, files: fx, fork });
      }

      if (req.method === "POST" && action === "fork") {
        const b = JSON.parse((await readBody(req)) || "{}");
        let r;
        try { r = forkSession(id, String(b.userText || ""), Number(b.after) || 0); }
        catch (e) { r = { ok: false, status: 500, message: e.message }; }
        return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { ok: false, error: "fork", message: tr(LAST_LANG, r.message) });
      }

      if (req.method === "POST" && action === "pin") {
        const b = JSON.parse((await readBody(req)) || "{}");
        if (b.pin === false) delete PINS[id]; else PINS[id] = Date.now();
        savePins();
        return sendJson(res, 200, { ok: true, pinned: PINS[id] || 0 });
      }
    }

    // ── DeepSeek 模型清单 ──
    if (req.method === "GET" && p === "/api/models") {
      const ms = withWindows(await fetchModels(u.searchParams.get("refresh") === "1"));
      const cur = ms.find((m) => m.id === SETTINGS.model) || ms[0] || {};
      return sendJson(res, 200, {
        models: ms,
        current: SETTINGS.model,
        // 给前端判"这家用不用得着挑模型"：官方账户不挑就是用它的默认
        provider: PROVIDER.id,
        nativeModels: !!PROVIDER.nativeModels,
        defaultModel: PROVIDER.defaultModel || null,
        effort: SETTINGS.effort || null,
        effortLevels: effortLevelsOf(cur),
        // 原生厂商的默认档位由 claude 按模型定，我们不知道就别瞎报
        effortDefault: (cur.effort && cur.effort.default_level) || (PROVIDER.nativeModels ? null : "high"),
        // 真实窗口 —— 前端用量条和门限都按它算，不写死
        contextWindow: Number(cur.context_window) || 0,
        maxOutputTokens: Number(cur.max_output_tokens) || 0,
        autoCompactWindow: effectiveAutoCompact(),
      });
    }

    // ── 应用内终端 ──
    if (p.startsWith("/api/term/")) return handleTerm(req, res, p);

    // ── 可选组件（浏览器组件等）──
    if (p === "/api/components" || p.startsWith("/api/components/")) return handleComponents(req, res, p, u);
    if (p === "/api/custom" || p.startsWith("/api/custom/")) return handleCustom(req, res, p, u);
    if (p.startsWith("/api/gh/")) return handleGh(req, res, p);
    if (p.startsWith("/api/git/")) return handleGit(req, res, p, u);

    // ── 能力清单 ──
    if (req.method === "GET" && p === "/api/capabilities") {
      return sendJson(res, 200, capabilities());
    }

    // ── 端侧小模型：状态 / 切模式 / 停服务 ──
    if (req.method === "GET" && p === "/api/local") return sendJson(res, 200, llamaInfo());
    if (req.method === "POST" && p === "/api/local") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.mode === "chat" || b.mode === "custom") { SETTINGS.localMode = b.mode; saveSettings(); }
      if (b.stop) llamaStop("用户停止");
      return sendJson(res, 200, llamaInfo());
    }
    // 前端滚动冻结脱困前报一声：写进网关日志，事后对时间线（前端自己只在 localStorage 留最近 5 次）
    if (req.method === "POST" && p === "/api/freeze") {
      let j = {};
      try { j = JSON.parse(await readBody(req)); } catch {}
      const touch = Array.isArray(j.touch) ? j.touch.slice(-40).map((x) => String(x).slice(0, 80)).join(" | ") : "";
      log(`滚动冻结脱困（${j.why === "auto" ? "自动" : "手动"}）${touch ? "，触摸：" + touch : ""}`);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/local/catalog") {
      if (PREFIX) await compIndex(false).catch(() => {});   // 目录在组件索引里（有缓存）
      return sendJson(res, 200, PREFIX ? localCatalog() : { ram: 0, items: [] });
    }
    if (req.method === "POST" && p === "/api/local/model") {
      if (!PREFIX) return sendJson(res, 400, { ok: false, message: "unsupported" });
      const b = JSON.parse((await readBody(req)) || "{}");
      try {
        if (b.op === "download") modelDownload(String(b.id || ""));
        else if (b.op === "url") modelFromUrl(b.url || "");
        else if (b.op === "cancel") modelCancel(String(b.id || ""));
        else if (b.op === "remove") modelRemove(String(b.id || ""));
        else throw new Error("bad op");
        return sendJson(res, 200, { ok: true, ...localCatalog() });
      } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    }

    // ── Office：LibreOffice 在不在、一键安装、转 PDF（结果按文件缓存）──
    if (req.method === "GET" && p === "/api/office/info") {
      return sendJson(res, 200, { have: officeHave(), can: !!PREFIX, install: officeInst });
    }
    if (req.method === "POST" && p === "/api/office/install") {
      if (!PREFIX) return sendJson(res, 400, { error: "unsupported" });
      if (officeHave()) return sendJson(res, 200, { have: true });
      return sendJson(res, 200, { have: false, install: officeInstall() });
    }
    if (p === "/api/office/pdf") {
      const r = safeFilePath(req.method === "GET" ? u.searchParams.get("path") : JSON.parse((await readBody(req)) || "{}").path);
      if (r.error) return sendJson(res, r.status || 404, { error: r.error });
      if (req.method === "GET") {
        const out = path.join(OFFICE_DIR, officeKey(r.file, fs.statSync(r.file)) + ".pdf");
        let st; try { st = fs.statSync(out); } catch { return sendJson(res, 404, { error: "not converted" }); }
        res.writeHead(200, { "content-type": "application/pdf", "content-length": st.size, "cache-control": "no-store" });
        const rs = fs.createReadStream(out);
        rs.on("error", () => { try { res.destroy(); } catch {} });
        rs.pipe(res);
        return;
      }
      if (!officeHave()) return sendJson(res, 200, { ok: false, missing: true, can: !!PREFIX });
      try { await officePdf(r.file); } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
      return sendJson(res, 200, { ok: true, url: "/api/office/pdf?path=" + encodeURIComponent(r.file) });
    }

    // ── 取文件内容（消息里的图片、文件预览、下载都走这里）──
    if (req.method === "GET" && p === "/api/file") {
      const r = safeFilePath(u.searchParams.get("path"));
      if (r.error) return sendJson(res, r.status || 404, { error: r.error, detail: r.detail });
      const head = {
        "content-type": mimeOf(r.file),
        "content-length": r.size,
        "cache-control": "no-store",
        "x-mtime": String(r.mtime),     // 编辑器保存时带回来做冲突检测
      };
      if (u.searchParams.get("download") === "1") {
        head["content-disposition"] =
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(r.file))}`;
      }
      res.writeHead(200, head);
      const st = fs.createReadStream(r.file);
      st.on("error", () => { try { res.destroy(); } catch {} });
      st.pipe(res);
      return;
    }

    // ── 回复里的路径被点了：先问一下是什么（文件 / 目录 / 不存在），前端再决定开查看器还是文件面板 ──
    if (req.method === "POST" && p === "/api/preview") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const r = await previewGrant(b.path);
      return sendJson(res, r.error ? r.status || 404 : 200, r);
    }
    if (req.method === "GET" && p === "/api/file/stat") {
      let q = String(u.searchParams.get("path") || "").trim();
      if (!path.isAbsolute(q)) return sendJson(res, 400, { error: "absolute path required" });
      let real;
      try { real = fs.realpathSync(q); } catch { return sendJson(res, 404, { error: "not found", path: q }); }
      let st; try { st = fs.statSync(real); } catch (e) { return sendJson(res, 404, { error: e.message }); }
      if (st.isDirectory()) return sendJson(res, 200, { path: real, dir: true });
      const r = safeFilePath(real);
      if (r.error) return sendJson(res, r.status || 404, { error: r.error });
      return sendJson(res, 200, { path: r.file, dir: false, size: r.size, mtime: r.mtime, kind: fileKind(r.file, false) });
    }

    // ── 文件编辑器保存：带上打开时的 mtime，磁盘上的已经被别人（多半是 Claude）改过就拒绝，免得互相覆盖 ──
    if (req.method === "POST" && p === "/api/file/save") {
      const r = safeWritePath(u.searchParams.get("path"));
      if (r.error) return sendJson(res, r.status || 400, { error: r.error });
      const base = Number(u.searchParams.get("mtime") || 0);
      if (!r.fresh && base && Math.abs(r.mtime - base) > 1 && u.searchParams.get("force") !== "1") {
        return sendJson(res, 409, { error: "changed on disk", mtime: r.mtime, size: r.size });
      }
      const buf = await readBodyBuf(req, 16 * 1024 * 1024);
      try { fs.writeFileSync(r.file, buf); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      const st = fs.statSync(r.file);
      log(`[file] 保存 ${r.file} ${buf.length}B`);
      return sendJson(res, 200, { ok: true, path: r.file, size: st.size, mtime: st.mtimeMs });
    }

    // ── 文件面板：新建文件 / 新建文件夹 / 重命名。都不覆盖已有的东西，防呆规则同保存 ──
    if (req.method === "POST" && (p === "/api/file/new" || p === "/api/file/mkdir")) {
      const r = safeWritePath(u.searchParams.get("path"));
      if (r.error) return sendJson(res, r.status || 400, { error: r.error });
      if (!r.fresh) return sendJson(res, 409, { error: "exists" });
      try {
        if (p === "/api/file/mkdir") fs.mkdirSync(r.file);
        else fs.writeFileSync(r.file, "", { flag: "wx" });
      } catch (e) { return sendJson(res, e.code === "EEXIST" ? 409 : 500, { error: e.code === "EEXIST" ? "exists" : e.message }); }
      const st = fs.statSync(r.file);
      log(`[file] 新建${p === "/api/file/mkdir" ? "目录" : ""} ${r.file}`);
      return sendJson(res, 200, { ok: true, path: r.file, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, kind: fileKind(r.file, st.isDirectory()) });
    }
    if (req.method === "POST" && p === "/api/file/rename") {
      const from = String(u.searchParams.get("from") || "");
      const name = String(u.searchParams.get("name") || "").trim();
      if (!path.isAbsolute(from)) return sendJson(res, 400, { error: "absolute path required" });
      if (!name || name === "." || name === ".." || /[\/\0]/.test(name)) return sendJson(res, 400, { error: "bad name" });
      let st; try { st = fs.lstatSync(from); } catch { return sendJson(res, 404, { error: "not found" }); }
      // 源：文件走 safeFilePath；目录借它父目录下的一个虚拟子路径过一遍 safeWritePath 的根目录检查
      const src = st.isDirectory() ? safeWritePath(path.join(from, ".probe-" + Date.now())) : safeFilePath(from);
      if (src.error) return sendJson(res, src.status || 400, { error: src.error });
      if (st.isDirectory()) {      // 也别把装着应用私有目录的上级挪走
        let rf; try { rf = fs.realpathSync(from); } catch { rf = from; }
        for (const root of [CFG.home, CFG.runtime]) {
          let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
          if (rr && rr.startsWith(rf + path.sep)) return sendJson(res, 403, { error: "forbidden" });
        }
      }
      const dst = safeWritePath(path.join(path.dirname(from), name));
      if (dst.error) return sendJson(res, dst.status || 400, { error: dst.error });
      if (!dst.fresh) return sendJson(res, 409, { error: "exists" });
      try { fs.renameSync(from, dst.file); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      log(`[file] 重命名 ${from} → ${dst.file}`);
      return sendJson(res, 200, { ok: true, path: dst.file, kind: fileKind(dst.file, st.isDirectory()) });
    }

    // ── 把界面拿到的东西落盘（粘贴 / 拖放 / 选择文件共用）──
    if (req.method === "POST" && p === "/api/upload") {
      const rawName = u.searchParams.get("name") || "";
      const safe = path.basename(rawName)
        .replace(/[^\w.\-()一-鿿]+/g, "_")   // 空格也换成 _：路径带空格在提示词里很难引用
        .replace(/^[.\s]+/, "")
        .slice(0, 120);
      const buf = await readBodyBuf(req);
      if (!buf.length) return sendJson(res, 400, { error: "empty body" });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const out = path.join(UPLOAD_DIR, `${stamp}-${safe || "upload.bin"}`);
      try { fs.writeFileSync(out, buf); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      const kind = fileKind(out, false);
      log(`[upload] ${safe || "upload.bin"} ${buf.length}B → ${out}`);
      return sendJson(res, 200, {
        ok: true, path: out, name: path.basename(out),
        size: buf.length, mime: mimeOf(out), kind,
      });
    }

    // ── 截屏给 Claude：经 priv 以 shell 身份 screencap，存进 uploads 当附件。delay 秒后再截（先切到要截的应用），截完叫回前台 ──
    if (req.method === "POST" && p === "/api/screenshot") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const delay = Math.max(0, Math.min(30, Number(b.delay) || 0));
      if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
      let png;
      try { png = await screencap(); } catch (e) { return sendJson(res, 500, { ok: false, message: e.message }); }
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const out = path.join(UPLOAD_DIR, `${stamp}-screen.png`);
      fs.writeFileSync(out, png);
      log(`[screenshot] ${png.length}B → ${out}`);
      if (delay) toFront(tz("截好了")).catch(() => {});
      return sendJson(res, 200, { ok: true, path: out, name: path.basename(out), size: png.length, mime: "image/png", kind: "image" });
    }

    // ── 目录浏览（@ 引用文件 + 文件面板共用）──
    if (req.method === "GET" && p === "/api/files") {
      const dir = u.searchParams.get("path") || CFG.workspace;
      const q = (u.searchParams.get("q") || "").toLowerCase();
      const showHidden = u.searchParams.get("hidden") === "1";
      const out = { path: dir, parent: path.dirname(dir), entries: [], roots: fileRoots() };
      try {
        const real = fs.realpathSync(dir);
        out.path = real;
        if (real !== dir) out.parent = path.dirname(real);
        const items = fs.readdirSync(real, { withFileTypes: true });
        for (const it of items) {
          if (!showHidden && it.name.startsWith(".")) continue;
          if (q && !it.name.toLowerCase().includes(q)) continue;
          const isDir = it.isDirectory();
          let size = 0, mtime = 0;
          try { const st = fs.statSync(path.join(real, it.name)); size = isDir ? 0 : st.size; mtime = st.mtimeMs; } catch {}
          out.entries.push({ name: it.name, dir: isDir, size, mtime, kind: fileKind(it.name, isDir) });
          if (out.entries.length >= 1000) break;
        }
        out.entries.sort((a, b) => {
          if (a.dir !== b.dir) return a.dir ? -1 : 1;
          if (a.dir) return a.name.localeCompare(b.name);
          if (a.kind === "image" && b.kind !== "image") return -1;
          if (b.kind === "image" && a.kind !== "image") return 1;
          return b.mtime - a.mtime || a.name.localeCompare(b.name);
        });
      } catch (e) { out.error = e.message; }
      return sendJson(res, 200, out);
    }

    // ── 运行 CLI 子命令取状态（mcp list / agents …）──
    if (req.method === "GET" && p === "/api/cli") {
      const sub = (u.searchParams.get("cmd") || "").trim();
      const ALLOW = new Set(["mcp list", "agents", "plugin list", "plugins", "doctor", "auth status", "auto-mode"]);
      if (!ALLOW.has(sub)) return sendJson(res, 400, { error: "command not allowed", cmd: sub });
      const r = await runClaude(sub.split(/\s+/), { timeoutMs: 45000 });
      return sendJson(res, 200, {
        cmd: sub,
        out: (r.out || "").slice(0, 30000),
        err: (r.err || "").slice(0, 4000),
        code: r.code ?? null,
        signal: r.signal || null,
        timeout: !!r.timeout,
      });
    }

    // ── 事件流：所有生成进度都从这里推，前端只订阅 ──
    if (req.method === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.socket?.setNoDelay?.(true);
      const lastId = String(req.headers["last-event-id"] || u.searchParams.get("since") || "");
      const m = lastId.match(/^([0-9a-z]+)\.(\d+)$/);
      const since = m && m[1] === BOOT ? Number(m[2]) : -1;
      const first = BUS.ring[0];
      const resume = since >= 0 && since <= BUS.seq && (since === BUS.seq || (first && first.seq <= since + 1));
      for (const r of RUNS.values()) flushPend(r);
      let out = "retry: 1500\n\n";
      out += `data: ${JSON.stringify({ type: "hello", boot: BOOT, resume, uiTag: uiTag(), ...snapshot() })}\n\n`;
      if (resume) {
        for (const r of BUS.ring) if (r.seq > since) out += r.line;
      } else {
        // 续不上（网关重启过 / 断得太久）：把正在跑的每一轮从头重放（前端按会话自己认领）
        for (const r of runList().sort((a, b) => a.startedAt - b.startedAt)) for (const ev of r.log) out += `data: ${JSON.stringify(ev)}\n\n`;
      }
      out += `id: ${BOOT}.${BUS.seq}\ndata: {"type":"sync"}\n\n`;
      res.write(out);
      BUS.clients.add(res);
      req.on("close", () => BUS.clients.delete(res));
      return;
    }

    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, snapshot());

    if (req.method === "POST" && p === "/api/chat") {
      let b;
      try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
      if (!String(b.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
      if (!API_KEY && !PROVIDER.login && !/^\/(model|models|effort|autocompact)\b/.test(String(b.message).trim())) {
        return sendJson(res, 503, {
          error: "no_api_key",
          message: tz("「{name}」还没填 Key。到 设置 → 接口 里填好保存，或换一个接口。", { name: PROVIDER.label || PROVIDER.id }),
        });
      }
      if (QUEUE.length >= 50) return sendJson(res, 429, { error: "queue_full", message: tz("排队的消息太多了。") });
      const item = enqueue(b);
      return sendJson(res, 200, { ok: true, id: item.id, injected: !!item.injected, started: RUNS.has(item.id) });
    }

    // ── 官方账户登录：就是在跑 `claude auth login`，网关只当终端用 ──
    // OAuth 全程由 claude 自己完成，令牌由它写进它自己的 ~/.claude/.credentials.json；
    // 我们只转交用户在授权页拿到的一次性授权码（等同于在终端里粘贴），不读、不存任何凭据。
    // ── Shizuku（调试提权）──
    // ── 内存管家 ──
    if (req.method === "GET" && p === "/api/energy") return sendJson(res, 200, await energyReport(u.searchParams.get("view") || "hour"));
    if (req.method === "POST" && p === "/api/energy/system") return sendJson(res, 200, await energySystem());
    if (req.method === "GET" && p === "/api/mem/status") return sendJson(res, 200, await ccMem(["status", "--json"]));
    if (req.method === "POST" && p === "/api/mem/clear") {
      const b = JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 200, await ccMem(["clear", "--json", ...(b.hard ? ["--hard"] : []), ...(b.dryRun ? ["--dry-run"] : [])]));
    }
    if (req.method === "GET" && p === "/api/priv/status") return sendJson(res, 200, await privCall({ op: "status" }));
    if (req.method === "POST" && p === "/api/priv/request") return sendJson(res, 200, await privCall({ op: "request" }));
    if (req.method === "POST" && p === "/api/priv/open") return sendJson(res, 200, await privCall({ op: "open_manager" }));
    // 特权命令记录：cccodroid 的 Priv.java 每执行一条就往 home/priv-audit.jsonl 记一行。最新的在前
    if (req.method === "GET" && p === "/api/priv/audit") {
      const f = path.join(CFG.home, "priv-audit.jsonl"), items = [];
      for (const ff of [f, f + ".1"]) {
        let txt = ""; try { txt = fs.readFileSync(ff, "utf8"); } catch {}
        for (const l of txt.split("\n").reverse()) { if (items.length >= 300) break; try { if (l) items.push(JSON.parse(l)); } catch {} }
        if (items.length >= 300) break;
      }
      return sendJson(res, 200, { ok: true, supported: !!PREFIX, items });
    }
    if (req.method === "POST" && p === "/api/priv/keepalive") {
      const b = JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 200, await privCall({ op: "keepalive", enable: b.enable !== false }, 60000));
    }
    // 更新（APK / 工具包 / Claude Code）与 Shizuku 一键安装激活：都在应用进程里做，这里只转话
    if (p.startsWith("/api/app/")) {
      const op = p.slice(9);
      const OPS = ["upd_status", "upd_check", "upd_apply", "upd_set", "upd_verify", "upd_repair", "share_logs", "share_file", "shz_install", "shz_activate", "shz_pair", "shz_autostart", "shz_repair", "open_app_settings", "freeze_ack", "notify_status", "notify_set", "notify_settings"];
      if (!OPS.includes(op)) return sendJson(res, 404, { ok: false, message: tz("未知操作") });
      const b = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
      if (!PREFIX) return sendJson(res, 200, await devApp(op, b));
      return sendJson(res, 200, await privCall({ ...b, op }));
    }

    if (req.method === "POST" && p === "/api/login/start") {
      const b = JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 200, await loginStart(b.method === "console" ? "--console" : "--claudeai"));
    }
    if (req.method === "GET" && p === "/api/login/status") {
      const st = await authStatus(u.searchParams.get("refresh") === "1" || (LOGIN && LOGIN.done && !LOGIN.reported));
      if (LOGIN && LOGIN.done) LOGIN.reported = true;
      return sendJson(res, 200, {
        ...st,
        pending: !!(LOGIN && !LOGIN.done),
        limits: st.loggedIn && RATE_LIMITS && (!RATE_LIMITS.email || RATE_LIMITS.email === st.email) ? RATE_LIMITS : null,
        last: LOGIN && LOGIN.done ? { ok: LOGIN.ok, output: LOGIN.ok ? "" : LOGIN.out.slice(-800) } : null,
      });
    }
    if (req.method === "POST" && p === "/api/login/cancel") {
      if (LOGIN && !LOGIN.done) try { LOGIN.child.kill("SIGKILL"); } catch {}
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/login/logout") {
      if (RUNS.size && isLoginMode()) return sendJson(res, 409, { error: "busy", message: tz("这一轮还在生成，等它跑完再退出登录。") });
      const r = await runAuth(["logout"]);
      AUTH_CACHE = null;
      RATE_LIMITS = null; try { fs.unlinkSync(RL_FILE); } catch {}
      return sendJson(res, 200, { ok: r.code === 0, output: r.out.slice(-500) });
    }

    // ── 权限确认：回答 claude 的 can_use_tool ──
    if (req.method === "POST" && p === "/api/perm/answer") {
      const b = JSON.parse((await readBody(req)) || "{}");
      // 不带 runId（通知里的「拒绝」）就按请求号找它属于哪一轮
      const run = b.runId ? RUNS.get(String(b.runId)) || null : runList().find((r) => r.perms && r.perms.has(String(b.id || ""))) || null;
      if (!run || !run.answerPerm) return sendJson(res, 409, { error: "gone", message: tz("这一轮已经结束了") });
      if (!run.answerPerm(String(b.id || ""), {
        behavior: b.behavior === "allow" ? "allow" : "deny",
        message: b.message, interrupt: !!b.interrupt, always: !!b.always,
        answers: b.answers, mode: b.mode ? String(b.mode) : null,
      })) return sendJson(res, 409, { error: "gone", message: tz("这项已经回答过了") });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/perm/mode") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (!setPermMode(String(b.mode || ""))) return sendJson(res, 400, { error: "bad mode" });
      return sendJson(res, 200, { ok: true, mode: SETTINGS.permissionMode, live: RUNS.size > 0 });
    }

    if (req.method === "POST" && p === "/api/task/stop") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const run = RUNS.get(String(b.runId || ""));
      if (!run || !run.stopTask || !run.stopTask(String(b.taskId || ""))) return sendJson(res, 409, { error: "gone", message: tz("这个后台任务已经结束了") });
      log(`■ 停后台任务 ${String(b.taskId).slice(0, 12)}`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/interrupted/dismiss") {
      setInterrupted(null);
      publishState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/abort") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.clearQueue) QUEUE.length = 0;
      // 带 id 只停那一轮；不带 id（旧前端）停掉全部
      const killed = b.id ? abortRun(RUNS.get(String(b.id))) : runList().map(abortRun).some(Boolean);
      if (b.clearQueue) publishState();
      return sendJson(res, 200, { ok: true, killed });
    }

    if (req.method === "POST" && p.startsWith("/api/queue/")) {
      const b = JSON.parse((await readBody(req)) || "{}");
      const act = p.slice("/api/queue/".length);
      const i = QUEUE.findIndex((q) => q.id === b.id);
      if (act === "clear") {
        // 带 ids 只清这些（前端只清当前会话的）；不带就全清
        if (Array.isArray(b.ids)) { const ids = new Set(b.ids.map(String)); for (let k = QUEUE.length - 1; k >= 0; k--) if (ids.has(QUEUE[k].id)) QUEUE.splice(k, 1); }
        else QUEUE.length = 0;
      } else if (i < 0) return sendJson(res, 404, { error: "not queued" });
      else if (act === "remove") QUEUE.splice(i, 1);
      else if (act === "promote") {          // ⚡ 插话：塞进正在跑的这一轮（不打断）；塞不进就挪到队首
        const it = QUEUE.splice(i, 1)[0];
        it.held = false;                      // 挂起的消息靠这个放行
        const lr = laneRun(laneOfItem(it));
        if (!(lr && tryInject(lr, it))) QUEUE.unshift(it);
      } else if (act === "edit") {
        const t = String(b.text || "").trim();
        if (!t) QUEUE.splice(i, 1); else QUEUE[i].message = t;
      } else return sendJson(res, 404, { error: "unknown action" });
      publishState();
      pump();
      return sendJson(res, 200, { ok: true, queue: snapshot().queue });
    }

    if (req.method === "GET") return serveStatic(req, res, p);

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    log(`请求处理异常 ${p}: ${e.stack || e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

// ── 启动 ──────────────────────────────────────────────────────────────
try { fs.mkdirSync(CFG.workspace, { recursive: true }); } catch {}
// /sdcard 上的文件属主是系统（media_rw），git 会以 "dubious ownership" 拒绝操作那里的仓库。
// 只对前缀布局（cccodroid 自己的 HOME）做，不碰别人的 git 配置。
if (PREFIX) {
  try {
    const gc = path.join(CFG.home, ".gitconfig");
    const cur = fs.existsSync(gc) ? fs.readFileSync(gc, "utf8") : "";
    if (!/directory\s*=\s*\*/.test(cur)) fs.appendFileSync(gc, "[safe]\n\tdirectory = *\n");
  } catch {}
}
try { fs.mkdirSync(CFG.home, { recursive: true }); } catch {}
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

server.listen(CFG.port, "127.0.0.1", () => {
  log(`claude-apk 网关 v3 已启动  http://127.0.0.1:${CFG.port}`);
  log(`  运行时 ${CFG.runtime}`);
  log(`  工作区 ${CFG.workspace}`);
  log(`  前端   ${PATHS.web}  存在=${fs.existsSync(PATHS.web)}`);
  log(`  密钥   ${API_KEY ? "已配置 (" + API_KEY.slice(0, 6) + "…)" : "缺失"}`);
  log(`  模型   ${SETTINGS.model}   权限 ${SETTINGS.permissionMode}`);
  if (!fs.existsSync(PATHS.claude)) log(`  ⚠️ 未找到 claude: ${PATHS.claude}`);
  if (!fs.existsSync(PATHS.loader)) log(`  ⚠️ 未找到 glibc loader: ${PATHS.loader}`);
  log(`  历史会话 ${listSessions(500).length} 个`);
  try { reapOrphans(); } catch (e) { log("孤儿进程清理失败: " + e.message); }
  try { expireTrash(); } catch (e) { log("回收站清理失败: " + e.message); }
  try { customRefresh(); } catch (e) { log("自定义组件入口重写失败: " + e.message); }
});

// 启动后校验一次模型名：不在清单里就落到默认。
// 只对【第三方厂商】做 —— 它们对未知模型名可能静默回落，留着会让人以为切成功了；
// 原生厂商（claude 自己认识模型）与没有清单的厂商一律跳过，别替它改配置。
setTimeout(async () => {
  try {
    if (PROVIDER.nativeModels) return;
    const ms = await fetchModels(true);
    if (!ms.length || !SETTINGS.model) return;
    if (!ms.some((m) => m.id === SETTINGS.model)) {
      const old = SETTINGS.model;
      SETTINGS.model = ms[0].id;
      SETTINGS.effort = normEffort(ms[0], SETTINGS.effort);
      saveSettings();
      log(`⚠️ 模型 "${old}" 不在 [${PROVIDER.id}] 清单里，已改回 ${SETTINGS.model}`);
    }
  } catch (e) { log(`模型校验失败: ${e.message}`); }
}, 2500);

process.on("SIGTERM", () => { for (const t of TERMS.values()) if (t.alive) killTree(t.child); try { bridgeProc?.kill(); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { bridgeProc?.kill(); } catch {} process.exit(0); });
