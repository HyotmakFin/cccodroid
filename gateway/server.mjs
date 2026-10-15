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
    login: !!v.login, nativeModels: !!v.nativeModels,
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
    if (!b.baseUrl) return { error: "need_baseUrl", message: "自定义接口至少要填端点地址" };
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
    if (!/^https?:\/\//.test(cur.baseUrl || "")) return { error: "bad_baseUrl", message: "端点地址要以 http:// 或 https:// 开头" };
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
  if (!v) return { ok: false, message: "没有这家厂商" };
  if (v.login) return { ok: false, message: "账户登录不用测密钥，看登录状态即可" };
  const key = String(v.apiKey || "").trim();
  if (!key) return { ok: false, message: "还没填密钥" };
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
      return { ok: true, message: `密钥有效（${how}${n ? "，" + n + " 个模型" : ""}）` };
    }
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.msg || msg; } catch {}
    const why = r.status === 401 || r.status === 403 ? "密钥无效或与线路不匹配" : `HTTP ${r.status}`;
    return { ok: false, status: r.status, message: `${why}：${msg}` };
  } catch (e) {
    return { ok: false, message: "连不上：" + e.message };
  }
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
  ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-sonnet-5", "Sonnet 5"], ["claude-haiku-4-5-20251001", "Haiku 4.5"],
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
    // 同理：把 ncurses 的 terminal database 指到我们自己的 prefix。
    // 死引用原本指向不存在的 Termux share/terminfo，TUI 程序（hx、gdb -tui…）拿不到
    // 终端能力；我们 prefix 里那份是齐的（221K），指过去就活了。
    TERMINFO_DIRS: PREFIX ? path.join(PREFIX, "share", "terminfo") : path.join(PATHS.toolchain, "dshtc", "prefix", "share", "terminfo"),
    // 工具链在前：这样 claude 调 git/gcc/rg/magick… 命中的是我们搬过来的包装脚本
    PATH: PREFIX ? [path.join(PREFIX, "bin"), process.env.CCAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean).join(":") : [
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
    const ctx = Number(info && info.context_window) || 0;
    if (ctx > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
  }
  // 注意：不注入 CLAUDE_CODE_MAX_OUTPUT_TOKENS —— 那是「单次输出上限」，
  // 不是上下文，claude 自己有合理默认，硬塞只会带来副作用。

  // 自动压缩窗口：用户设了才插，没设就让 claude 自己按窗口比例决定
  if (SETTINGS.autoCompactWindow) {
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
    const child = spawn(PATHS.loader, claudeArgv([...settingsArgs(), ...args]), {
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
  let title = "", cwd = "", firstMsg = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(196608);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.cwd && !cwd) cwd = ev.cwd;
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
  return { title: title || "(无标题)", cwd };
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
  return found.slice(0, limit).map((s) => {
    const meta = peekSession(s.file);
    return {
      id: s.id,
      title: NAMES[s.id] || meta.title,
      renamed: !!NAMES[s.id],
      cwd: meta.cwd,
      mtime: s.mtime,
      sizeKb: Math.round(s.size / 1024),
      currentProject: meta.cwd === CFG.workspace || meta.cwd === realWorkspace(),
    };
  });
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
    id, project: found.project, title: NAMES[id] || meta.title, renamed: !!NAMES[id],
    cwd: meta.cwd, mtime: st.mtimeMs, size: st.size, deletedAt: Date.now(),
  }));
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
  if (e < 0) throw new Error("不是 zip 文件");
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 目录损坏");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const body = buf.subarray(ds, ds + csize);
    if (method !== 0 && method !== 8) throw new Error("不支持的压缩方式：" + name);
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
  if (!list.length) throw new Error("没有可导出的会话");
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
  try { manifest = JSON.parse(man.data.toString("utf8")); } catch { throw new Error("缺少 manifest.json，不是会话包"); }
  if (manifest.format !== "cccodroid-sessions") throw new Error("不是 cccodroid 会话包");
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

/** transcript 的一行 → 0..n 条可渲染的消息 */
function transcriptItems(ev) {
  const out = [];
  if (!ev || ev.isSidechain || ev.isMeta) return out;
  if (ev.type === "user") {
    if (ev.isCompactSummary) { out.push({ role: "note", text: "（此前的对话已被压缩成摘要）" }); return out; }
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
let activeRun = null;
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
};

const EXT_KIND = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".heic"],
  video: [".mp4", ".webm", ".mkv", ".mov", ".3gp"],
  audio: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".opus"],
  text:  [".txt", ".md", ".log", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".js", ".mjs",
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

function safeFilePath(p) {
  if (!p) return { error: "path required" };
  let full = String(p).trim();
  if (full.startsWith("file://")) { try { full = fileURLToPath(full); } catch {} }
  if (!path.isAbsolute(full)) full = path.join(CFG.workspace, full);

  let real;
  try { real = fs.realpathSync(full); } catch (e) { return { error: "not found", detail: e.message }; }

  for (const root of [CFG.home, CFG.runtime, SEED_FILE]) {
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
  for (const root of [CFG.home, CFG.runtime]) {
    let rr; try { rr = fs.realpathSync(root); } catch { rr = root; }
    if (dir === rr || dir.startsWith(rr + path.sep)) return { error: "forbidden", status: 403 };
  }
  const name = path.basename(full);
  if (SECRET_NAMES.has(name) || SECRET_RE.test(path.join(dir, name))) return { error: "forbidden", status: 403 };
  return { file: path.join(dir, name), size: 0, mtime: 0, fresh: true };
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
/** 取一份索引并验签。unsigned 只在私有目录里有 allow-unsigned 开关文件时才放行（/sdcard 别的应用也能写） */
async function compFetchIndex(src) {
  const body = await compFetch(src);
  let sig = null;
  try { sig = Buffer.from(String(await compFetch(src + ".sig")).trim(), "base64"); } catch {}
  const ok = sig && sig.length === 64 && crypto.verify(null, body, COMP_INDEX_PUBKEY, sig);
  if (!ok && !fs.existsSync(path.join(COMP_DIR, "allow-unsigned"))) throw new Error(sig ? "索引签名不对，已拒绝" : "索引没有签名，已拒绝");
  return { ...JSON.parse(String(body)), signed: !!ok };
}

/** 两个来源合并：预置（cccodroid 仓库）在前，社区（cccodroid-components）在后；id 撞了以预置为准。
 *  共享目录里放了 components/components.json 就代替预置来源（离线 / 测试），同样要签名。 */
async function compIndex(force) {
  if (!force && compIndexCache.data && Date.now() - compIndexCache.at < 10 * 60e3) return compIndexCache;
  const local = process.env.CCAPP_SHARED && path.join(process.env.CCAPP_SHARED, "components", "components.json");
  const sources = [
    { source: "preset", url: local && fs.existsSync(local) ? "file://" + local : COMP_INDEX },
    { source: "community", url: COMP_COMMUNITY_INDEX },
  ];
  const got = await Promise.all(sources.map((s) => compFetchIndex(s.url).then((d) => ({ ...s, d }), (e) => ({ ...s, e }))));
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
      error: job && job.error ? job.error : "",
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
    child.on("exit", (code) => { job.child = null; job.cancelled ? reject(new Error("cancelled")) : code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.trim().split("\n").pop() || ""}`)); });
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
  for (const r of rec.files || []) {
    const keeper = others.find((o) => o.needs.has(r));
    if (keeper) { keeper.gained.push(r); continue; }
    try { fs.unlinkSync(path.join(PREFIX, r)); } catch {}
    for (let d = path.dirname(r); d && d !== "."; d = path.dirname(d)) dirs.add(d);
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
  if (!dk || !dk.sha256) return { ok: false, message: "工具包还没装好（或是本地文件装的，没有版本身份），装不了组件" };
  const ix = await compIndex(true);
  const entry = ix.data && ix.data.components && ix.data.components[id];
  if (!entry) return { ok: false, message: ix.error || "没有这个组件" };
  if (compUnsupported(entry)) return { ok: false, message: "这个组件只能用在高通骁龙（Adreno GPU）的设备上，本机用不了" };
  const miss = (entry.requires || []).filter((rid) => !compDepOk(rid, ix.data.components, dk));
  if (miss.length) return { ok: false, message: "要先装：" + miss.map((rid) => compName(rid, ix.data.components).zh || rid).join("、") };
  const b0 = compBuildFor(entry, dk), b = b0 && { ...b0, source: entry.source, requires: entry.requires || [] };
  if (!b) return { ok: false, message: "这个组件还没有对应当前工具包的版本，先更新工具包或稍后再试" };
  // 空间：压缩包 + 解开后的大小，再留 10%
  try {
    const sf = fs.statfsSync(path.dirname(PREFIX));
    const need = (b.bytes + b.installed) * 1.1;
    if (sf.bavail * sf.bsize < need) return { ok: false, message: `存储空间不够：需要约 ${Math.ceil(need / 1048576)} MB` };
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

async function compRunInstall(id, b, job) {
  const stage = path.join(COMP_DIR, ".staging"), gz = path.join(stage, `${id}-${b.sha256.slice(0, 12)}.tar.gz`), tree = path.join(stage, id);
  fs.mkdirSync(stage, { recursive: true });
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
    if (got !== b.sha256) { fs.rmSync(part, { force: true }); throw new Error("下载的文件校验不符（已删除，重试会重新下载）"); }
    fs.renameSync(part, gz);
  }
  if (job.cancelled) throw new Error("cancelled");
  // 2) 解到暂存区，按包内 MANIFEST 逐个核对
  job.phase = "verifying"; job.done = 0; job.total = b.installed || 0;
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  await compRun(job, path.join(PREFIX, "bin", "tar"), ["-xzf", gz, "-C", tree]);
  const lx = `libexec/devkit/components/${id}`;
  const man = fs.readFileSync(path.join(tree, "usr", lx, "MANIFEST"), "utf8").trim().split("\n");
  for (const line of man) {
    if (job.cancelled) throw new Error("cancelled");
    const [h, n, ...rest] = line.split(" "), rel = rest.join(" ");
    const f = path.join(tree, "usr", rel);
    let st; try { st = fs.statSync(f); } catch { throw new Error("组件包缺文件：" + rel); }
    if (st.size !== Number(n) || (await sha256File(f)) !== h) throw new Error("组件包里的文件校验不符：" + rel);
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
  if (job.phase === "installing") return { ok: false, message: "正在放进工具包，这一步不能中断" };
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
    return { ok: false, message: users.map((rid) => compName(rid, comps).zh || rid).join("、") + " 要用它，先卸载那些组件" };
  }
  compRemoveFiles(id, rec);
  fs.rmSync(compRecFile(id), { force: true });
  fs.rmSync(path.join(COMP_DIR, ".staging"), { recursive: true, force: true });
  COMP_JOBS.delete(id);
  log(`[comp] ${id} 已卸载（${(rec.files || []).length} 个文件）`);
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
  if (!bin || !fs.existsSync(bin)) return { ok: false, message: "gh 没装" };
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
      job.state = "error"; job.error = (last || "gh 退出码 " + code).slice(0, 300);
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

async function handleComponents(req, res, p, u) {
  if (req.method === "GET" && p === "/api/components") return sendJson(res, 200, await compList(u.searchParams.get("refresh") === "1"));
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const id = String(body.id || "");
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return sendJson(res, 400, { ok: false, message: "bad id" });
  if (p === "/api/components/install") return sendJson(res, 200, await compInstall(id));
  if (p === "/api/components/cancel") return sendJson(res, 200, compCancel(id));
  if (p === "/api/components/remove") return sendJson(res, 200, compRemove(id));
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
let RUN_N = 0;
const newRunId = () => `r${BOOT}${(++RUN_N).toString(36)}`;

const runInfo = (r) => r && {
  id: r.id, cid: r.cid, text: r.text.slice(0, 2000), sessionId: r.sessionId, follow: r.follow, startedAt: r.startedAt,
  perms: r.perms ? [...r.perms.values()] : [],
};

/** 改权限模式：存进设置（下一轮沿用），正在跑的那一轮当场切（set_permission_mode） */
function setPermMode(mode) {
  if (!PERM_MODES.includes(mode)) return false;
  SETTINGS.permissionMode = mode;
  saveSettings();
  if (activeRun && activeRun.setMode) activeRun.setMode(mode);
  publish({ type: "perm_mode", mode });
  return true;
}
function snapshot() {
  return {
    run: runInfo(activeRun),
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
    if (!activeRun && !QUEUE.length) return fs.rmSync(RUN_MARK, { force: true });
    const r = activeRun;
    fs.writeFileSync(RUN_MARK + ".tmp", JSON.stringify({
      run: r && !r.ended ? { id: r.id, sessionId: r.sessionId, text: r.text.slice(0, 4000), startedAt: r.startedAt } : null,
      // 已经写进 stdin、claude 还没吃进去的插话也算排队的：一起留下
      queue: [...(r && r.pendingInject || []).map((it) => ({ ...it, injected: false })), ...QUEUE],
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
  if (m.run && m.run.id) {
    setInterrupted({ ...m.run, at: Date.now() });
    if (m.run.sessionId) RUN_SESSIONS.set(m.run.id, m.run.sessionId);
    log(`⚠️ 上一轮没跑完就被结束了（会话 ${m.run.sessionId || "未建立"}），已标为中断`);
  }
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
  else run.log.push({ ...ev });
}

function endRun(run, fields = {}) {
  if (run.ended) return;
  flushPend(run);
  run.ended = true;
  if (activeRun === run) activeRun = null;
  if (!activeRun) runFlag(false);
  publish({ type: "run_end", runId: run.id, sessionId: run.sessionId, aborted: !!run.aborted, ...fields });
  run.log = [];
  publishState();
  setImmediate(pump);
}

function abortRun(run) {
  if (!run || run.ended) return false;
  run.aborted = true;
  // 停止要和排队的消息严格隔开：此刻排着的一律挂起，不许这一轮一结束就自动发出去
  // （以前点停止反而是"立刻发下一条"）。用户点 ⚡ 才发；停止之后新发的消息不受影响，照常先跑
  for (const q of QUEUE) { q.held = true; q.intr = false; }
  if (run.child) killTree(run.child);
  return true;
}

function pump() {
  if (activeRun) return;
  const qi = QUEUE.findIndex((q) => !q.held);     // 停止时挂起的不自动发
  if (qi < 0) return;
  const item = QUEUE.splice(qi, 1)[0];
  startRun(item).catch((e) => {
    log(`run 异常: ${e.stack || e.message}`);
    if (activeRun && activeRun.id === item.id) {
      runEmit(activeRun, { type: "error", message: `内部错误：${e.message}` });
      endRun(activeRun, { failed: true });
    }
  });
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
  };
  // 插话（"inject"，旧前端叫 "interrupt"）：不打断。消息直接写进正在跑的 claude 的 stdin，
  // claude 会在当前这一步（比如一次工具调用）结束后把它并进对话，同一轮里接着干 —— 和终端里边干边打字一样。
  // 塞不进去（这一轮已在收尾、或者不是同一个会话）就排到队首，这一轮一结束马上发。
  if ((body.mode === "inject" || body.mode === "interrupt") && activeRun) {
    if (tryInject(activeRun, item)) { item.injected = true; return item; }
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
          : { ok: false, message: "没拿到登录地址", output: L.out.slice(-1500) });
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
    startedAt: Date.now(),
    child: null, aborted: false, ended: false,
    log: [], pend: null, pendTimer: null,
  };
  activeRun = run;                       // 同步占槽，中间不许有 await
  runFlag(true);
  // 在被中断的那个会话里又跑起来了（点了「继续」或者直接接着聊）：中断提示就不用再挂着了
  if (INTERRUPTED && (INTERRUPTED.sessionId ? INTERRUPTED.sessionId === run.sessionId : !run.sessionId)) setInterrupted(null);
  if (run.sessionId) RUN_SESSIONS.set(run.id, run.sessionId);
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt });
  publishState();

  const message = run.text;
  const local = message.trim().match(/^\/(model|models|effort|autocompact)(?:\s+([\s\S]*))?$/);
  if (local) {
    log(`⌘ 本地命令 /${local[1]}${local[2] ? " " + local[2].trim() : ""}`);
    return handleLocalCommand(local[1], (local[2] || "").trim(),
      (text, cmd) => endRun(run, { localCommand: cmd || local[1], resultText: text, durationMs: 0, costUsd: 0 }));
  }

  if (!API_KEY && !PROVIDER.login) {
    emit({ type: "error", message: `未配置 API 密钥。请在设置里填入 ${PROVIDER.label || PROVIDER.id} 的密钥。` });
    return endRun(run, { failed: true });
  }
  if (!isLoginMode() && !(await ensureBridge())) {
    emit({ type: "error", message: "本地 DNS 桥启动失败，无法连接 API。" });
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
  const appendPrompt = [toolsHint(), SETTINGS.appendSystemPrompt].filter(Boolean).join("\n\n");
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

  const child = spawn(PATHS.loader, claudeArgv(argv), {
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
    if (!run.pendingInject.length) closeInput();
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
    if (ev.type === "control_response") return;          // 我们发的 set_permission_mode 的回执
    if (ev.type === "control_cancel_request") {           // claude 自己撤回了（比如被中断）
      if (run.perms.delete(ev.request_id)) { emit({ type: "perm_resolved", id: ev.request_id, behavior: "cancel" }); publishState(); }
      return;
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
    emit({ type: "error", message: `无法启动 claude: ${e.message}` });
    endRun(run, { failed: true });
  });
  child.on("close", finish);
}

/** 把应用界面叫回前台。cccodroid 由 App 进程做（Shizuku 或通知）；开发端直接 priv am start */
function toFront(text) {
  if (PREFIX) return privCall({ op: "to_front", text }, 8000);
  return new Promise((ok) => execFile("priv", ["am start --activity-reorder-to-front -n li.dsh.claudecli/.MainActivity"],
    { timeout: 8000, env: process.env }, (e) => ok(e ? { message: e.message.slice(0, 120) } : { via: "priv" })));
}

/** 问应用进程里的提权中转（Priv.java）。只在 cccodroid 布局下存在 */
function privCall(req, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!PREFIX) {
      if (req.op === "status") return devPrivStatus().then(resolve);
      return resolve({ ok: false, state: "unsupported", message: "开发端的 Shizuku 由 Shizuku 应用自己管理（priv 走 rish）" });
    }
    const s = net.connect({ path: "\0cc.codroid.priv" }, () => s.write(JSON.stringify(req) + "\n"));
    let buf = "";
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, message: "超时" }); }, timeoutMs);
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
    if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error("版本号不对：" + v.slice(0, 40));
    c.latest = v;
    // 已装版本要和所选渠道「一致」：从 latest 切回 stable 时版本号变小，以前判成「已是最新」就一直停在 latest 上
    if (c.state !== "installing") {
      const d = cmpVer(v, c.current);
      c.state = d === 0 ? "uptodate" : "available";
      c.message = d < 0 && c.current ? `切回 ${devUpd.channel} 渠道：将换成 ${v}（比当前的 ${c.current} 旧）` : devUpd.channel === "latest" ? "latest 渠道" : "";
    }
    devUpd.lastCheck = Date.now();
  } catch (e) { devUpd.error = "连不上 downloads.claude.ai：" + e.message; }
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
    if (!plat || !/^[a-f0-9]{64}$/.test(plat.checksum)) throw new Error("清单里没有 linux-arm64");
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
    if (got !== plat.checksum) { fs.rmSync(part, { force: true }); throw new Error(`sha256 不符（期望 ${plat.checksum.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`); }
    fs.chmodSync(part, 0o755);
    const v = await claudeVersionOf(part);
    if (v !== c.latest) throw new Error(`新版试跑失败（--version 得到「${v}」）`);
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
    if (b.item !== "claude") return { ok: false, message: "开发端只管 Claude Code（应用本体由你在本机构建安装）" };
    if (devUpd.claude.state !== "available" && devUpd.claude.state !== "error") return { ok: false, message: "没有可装的新版，先检查更新" };
    devUpdInstall();
    return { ok: true, message: "开始更新 Claude Code" };
  }
  return { ok: false, message: "开发端不支持：" + op };
}

/** 给 claude 的工具说明。两种布局装的东西不一样，各说各的，别把没有的命令告诉它 */
function toolsHint() {
  if (PREFIX) {
    // 随包的 TOOLS.md 是逐项实测过的工具清单与用法（cccodroid-selftest 验证），优先用它
    try {
      const t = fs.readFileSync(path.join(HERE, "TOOLS.md"), "utf8")
        .replaceAll("{{WORKSPACE}}", CFG.workspace).replaceAll("{{SHARED}}", process.env.CCAPP_SHARED || "（无存储权限，不可用）");
      if (t.trim()) return t.trim();
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
        sse({ type: "usage", contextTokens: n, outputTokens: e.message.usage.output_tokens || 0 });
        break;
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
          sse({ type: "tool_result", id: c.tool_use_id, ok: !c.is_error, text: String(txt).slice(0, 20000) });
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
    const child = spawn(PATHS.loader, claudeArgv(args), {
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
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, message: "名字只能用字母、数字、点、下划线、横线" };
  const transport = ["stdio", "http", "sse"].includes(b.transport) ? b.transport : "stdio";
  const target = String(b.target || "").trim();
  if (!target) return { ok: false, message: "缺少命令或地址" };
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
    return m ? { dir: d.name, name: m.name || d.name, description: m.description, component: fromComp.get(d.name) || "", official: (skillSource(d.name) || {}).repo === SKILL_REPO } : null;
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
  } catch (e) { return { ok: false, message: "取不到官方技能目录：" + e.message }; }
}
/** 装一个官方技能：按目录树逐个下载到临时目录，齐了再改名就位（不会留下半截）；超过 50 MB 不装 */
async function installCatalogSkill(dir) {
  if (!SID_RE.test(dir)) return { ok: false, message: "bad name" };
  const c = await skillCatalog().catch((e) => null);
  const it = c && c.items.find((x) => x.dir === dir);
  if (!it) return { ok: false, message: "官方目录里没有这个技能" };
  const dest = path.join(SKILLS_DIR, dir);
  if (fs.existsSync(dest)) return { ok: false, message: "已经有同名技能，先删掉再装" };
  if (it.bytes > 50 << 20) return { ok: false, message: "太大了（超过 50 MB）" };
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
  try { j = await ghGet(u.href, true); } catch (e) { return { ok: false, message: "取不到 MCP 注册表：" + e.message }; }
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
  if (!md) throw new Error("压缩包里没有 SKILL.md");
  const root = md.name.slice(0, md.name.length - "SKILL.md".length);
  const text = md.data.toString("utf8");
  const nm = (text.match(/^---\n[\s\S]*?^name:\s*(.+)$/m) || [])[1];
  const dir = String(nm || root.replace(/\/$/, "").split("/").pop() || "skill").trim().replace(/^["']|["']$/g, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  if (!SID_RE.test(dir) || dir === "." || dir === "..") throw new Error("技能名不合法");
  const dst = path.join(SKILLS_DIR, dir);
  if (fs.existsSync(dst)) throw new Error(`已有同名技能「${dir}」，先删掉旧的`);
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
        busy: !!activeRun,
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
      if (id === PROVIDER.id && activeRun) return sendJson(res, 409, { error: "busy", message: "这一家正在用，等这一轮跑完再删。" });
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

    // ── 设置 ──
    if (p === "/api/settings") {
      if (req.method === "GET") return sendJson(res, 200, { ...SETTINGS, workspace: CFG.workspace, outputStyles: outputStyles() });
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
            if (activeRun) {
              return sendJson(res, 409, {
                error: "busy",
                message: "这一轮还在生成中，等它跑完再切厂商（切换会换掉正在用的密钥与模型）。",
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
        if (req.method === "GET" && p === "/api/ext/skills") return sendJson(res, 200, { items: listSkills(), dir: SKILLS_DIR });
        if (req.method === "GET" && p === "/api/ext/catalog/skills") return sendJson(res, 200, await listSkillCatalog(u.searchParams.get("refresh") === "1"));
        if (req.method === "POST" && p === "/api/ext/catalog/skills/install") return sendJson(res, 200, await installCatalogSkill(String(body.dir || "")));
        if (req.method === "GET" && p === "/api/ext/catalog/mcp") return sendJson(res, 200, await listMcpCatalog(u.searchParams.get("q"), u.searchParams.get("cursor")));
        if (req.method === "POST" && p === "/api/ext/skills/delete") return sendJson(res, 200, deleteSkill(String(body.dir || "")));
        if (req.method === "POST" && p === "/api/ext/skills/import") return sendJson(res, 200, importSkill(await readBodyBuf(req, 64 * 1024 * 1024)));
      } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
      return sendJson(res, 404, { error: "not found" });
    }

    // ── 会话管理：批量进回收站 / 回收站 / 导出 / 导入 ──
    if (req.method === "POST" && p === "/api/sessions/trash") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const done = [], failed = [];
      for (const id of [].concat(b.ids || [])) {
        if (activeRun && activeRun.sessionId === id) { failed.push(id); continue; }
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
        const live = activeRun && activeRun.sessionId === id ? activeRun : null;
        const page = await readSessionPage(found.file, {
          before: u.searchParams.has("before") ? Number(u.searchParams.get("before")) : null,
          limit: Math.min(200, Math.max(10, Number(u.searchParams.get("limit")) || 40)),
          // 正在生成的那一轮走事件总线，这里不重复给
          excludeFrom: Number(u.searchParams.get("exclude")) || (live ? live.startedAt : 0),
        });
        return sendJson(res, 200, {
          id,
          title: NAMES[id] || meta.title,
          cwd: meta.cwd,
          items: page.items,
          cursor: page.cursor,
          size: page.size,
          contextTokens: page.contextTokens,
          liveRunId: live ? live.id : null,
        });
      }

      if (req.method === "DELETE" && !action) {
        if (!found) return sendJson(res, 404, { error: "not found" });
        if (activeRun && activeRun.sessionId === id) return sendJson(res, 409, { error: "busy", message: "这个会话正在生成中。" });
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
    if (p.startsWith("/api/gh/")) return handleGh(req, res, p);

    // ── 能力清单 ──
    if (req.method === "GET" && p === "/api/capabilities") {
      return sendJson(res, 200, capabilities());
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
      if (activeRun) flushPend(activeRun);
      let out = "retry: 1500\n\n";
      out += `data: ${JSON.stringify({ type: "hello", boot: BOOT, resume, uiTag: uiTag(), ...snapshot() })}\n\n`;
      if (resume) {
        for (const r of BUS.ring) if (r.seq > since) out += r.line;
      } else if (activeRun) {
        // 续不上（网关重启过 / 断得太久）：把正在跑的这一轮从头重放
        for (const ev of activeRun.log) out += `data: ${JSON.stringify(ev)}\n\n`;
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
          message: `「${PROVIDER.label || PROVIDER.id}」还没填 Key。到 设置 → 接口 里填好保存，或换一个接口。`,
        });
      }
      if (QUEUE.length >= 50) return sendJson(res, 429, { error: "queue_full", message: "排队的消息太多了。" });
      const item = enqueue(b);
      return sendJson(res, 200, { ok: true, id: item.id, injected: !!item.injected, started: !!activeRun && activeRun.id === item.id });
    }

    // ── 官方账户登录：就是在跑 `claude auth login`，网关只当终端用 ──
    // OAuth 全程由 claude 自己完成，令牌由它写进它自己的 ~/.claude/.credentials.json；
    // 我们只转交用户在授权页拿到的一次性授权码（等同于在终端里粘贴），不读、不存任何凭据。
    // ── Shizuku（调试提权）──
    if (req.method === "GET" && p === "/api/priv/status") return sendJson(res, 200, await privCall({ op: "status" }));
    if (req.method === "POST" && p === "/api/priv/request") return sendJson(res, 200, await privCall({ op: "request" }));
    if (req.method === "POST" && p === "/api/priv/open") return sendJson(res, 200, await privCall({ op: "open_manager" }));
    if (req.method === "POST" && p === "/api/priv/keepalive") {
      const b = JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 200, await privCall({ op: "keepalive", enable: b.enable !== false }, 60000));
    }
    // 更新（APK / 工具包 / Claude Code）与 Shizuku 一键安装激活：都在应用进程里做，这里只转话
    if (p.startsWith("/api/app/")) {
      const op = p.slice(9);
      const OPS = ["upd_status", "upd_check", "upd_apply", "upd_set", "upd_verify", "upd_repair", "share_logs", "share_file", "shz_install", "shz_activate", "shz_pair", "shz_autostart", "shz_repair", "open_app_settings", "freeze_ack", "notify_status", "notify_set", "notify_settings"];
      if (!OPS.includes(op)) return sendJson(res, 404, { ok: false, message: "未知操作" });
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
      if (activeRun && isLoginMode()) return sendJson(res, 409, { error: "busy", message: "这一轮还在生成，等它跑完再退出登录。" });
      const r = await runAuth(["logout"]);
      AUTH_CACHE = null;
      RATE_LIMITS = null; try { fs.unlinkSync(RL_FILE); } catch {}
      return sendJson(res, 200, { ok: r.code === 0, output: r.out.slice(-500) });
    }

    // ── 权限确认：回答 claude 的 can_use_tool ──
    if (req.method === "POST" && p === "/api/perm/answer") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const run = activeRun && (!b.runId || b.runId === activeRun.id) ? activeRun : null;
      if (!run || !run.answerPerm) return sendJson(res, 409, { error: "gone", message: "这一轮已经结束了" });
      if (!run.answerPerm(String(b.id || ""), {
        behavior: b.behavior === "allow" ? "allow" : "deny",
        message: b.message, interrupt: !!b.interrupt, always: !!b.always,
        answers: b.answers, mode: b.mode ? String(b.mode) : null,
      })) return sendJson(res, 409, { error: "gone", message: "这项已经回答过了" });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/perm/mode") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (!setPermMode(String(b.mode || ""))) return sendJson(res, 400, { error: "bad mode" });
      return sendJson(res, 200, { ok: true, mode: SETTINGS.permissionMode, live: !!activeRun });
    }

    if (req.method === "POST" && p === "/api/interrupted/dismiss") {
      setInterrupted(null);
      publishState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/abort") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.clearQueue) QUEUE.length = 0;
      const killed = activeRun && (!b.id || b.id === activeRun.id) ? abortRun(activeRun) : false;
      if (b.clearQueue) publishState();
      return sendJson(res, 200, { ok: true, killed });
    }

    if (req.method === "POST" && p.startsWith("/api/queue/")) {
      const b = JSON.parse((await readBody(req)) || "{}");
      const act = p.slice("/api/queue/".length);
      const i = QUEUE.findIndex((q) => q.id === b.id);
      if (act === "clear") QUEUE.length = 0;
      else if (i < 0) return sendJson(res, 404, { error: "not queued" });
      else if (act === "remove") QUEUE.splice(i, 1);
      else if (act === "promote") {          // ⚡ 插话：塞进正在跑的这一轮（不打断）；塞不进就挪到队首
        const it = QUEUE.splice(i, 1)[0];
        it.held = false;                      // 挂起的消息靠这个放行
        if (!(activeRun && tryInject(activeRun, it))) QUEUE.unshift(it);
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
