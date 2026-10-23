import fs from "node:fs";
import { PATHS, log } from "./config.mjs";
import { SETTINGS } from "./settings.mjs";
import { API_KEY, PROVIDER } from "./providers.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { localModels } from "./local.mjs";
import { effectiveModel } from "./sessmodel.mjs";
import { effectiveAutoCompact } from "./stream.mjs";

// ── 模型清单（按厂商拉，10 分钟缓存，失败用该厂商的 fallback）─────────
export let MODELS = null, MODELS_AT = 0, MODELS_FOR = null;

/** 把不同厂商的 /models 响应归一成同一种形状。
 *  两家形状不同：DeepSeek 用 context_window/max_output_tokens/effort.supported_levels，
 *  官方 /v1/models 用 max_input_tokens/max_tokens/capabilities.*（能力位里带 supported 标记）。 */
export function normalizeModels(j) {
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
export function isLoginMode(p = PROVIDER) { return !!(p && p.login && !API_KEY); }

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
export function effortLevelsOf(model) {
  return (model && model.effort && model.effort.supported_levels) ||
         (PROVIDER.nativeModels ? CLAUDE_EFFORT : ["low", "high", "max"]);
}

// 从 result.modelUsage 学到的真实窗口（按模型 id 记，落盘）—— 官方账户拿不到 /models，只能这样补
let WINDOWS = {};
try { WINDOWS = JSON.parse(fs.readFileSync(PATHS.windows, "utf8")); } catch {}
export function learnWindow(result) {
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
export const ALIAS_SEEN = {};
export function withWindows(list) {
  return list.map((m) => {
    const w = WINDOWS[m.id];
    return w && !m.context_window ? { ...m, ...w } : m;
  });
}

// 清空 / 让它过期：别的模块改不了这几个变量（ES 模块的导入是只读的），走这两个函数
export function dropModelCache() { MODELS = null; MODELS_AT = 0; MODELS_FOR = null; }
export function expireModelCache() { MODELS_AT = 0; }

export async function fetchModels(force) {
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
export function normEffort(model, want) {
  if (!want) return null;
  const ok = effortLevelsOf(model);
  if (ok.includes(want)) return want;
  return (model && model.effort && model.effort.default_level) || null;
}

// ── 路由：/api/models ──
export async function routeModels(req, res, u, p) {
  // ── DeepSeek 模型清单 ──
  if (req.method === "GET" && p === "/api/models") {
    const ms = withWindows(await fetchModels(u.searchParams.get("refresh") === "1"));
    // ?sid=：按这个会话记下的模型 / 档位回（0.3.16 起每个会话各用各的）；不给就是全局默认
    // ?model= / ?effort=：还没会话号的新会话在面板里先选了（前端暂存，随第一条消息带走），按选的回
    const now = effectiveModel(u.searchParams.get("sid") || "");
    if (u.searchParams.has("model")) now.model = u.searchParams.get("model");
    if (u.searchParams.has("effort")) now.effort = u.searchParams.get("effort");
    const cur = ms.find((m) => m.id === now.model) || ms[0] || {};
    return sendJson(res, 200, {
      models: ms,
      current: now.model || null,
      // 给前端判"这家用不用得着挑模型"：官方账户不挑就是用它的默认
      provider: PROVIDER.id,
      nativeModels: !!PROVIDER.nativeModels,
      defaultModel: PROVIDER.defaultModel || null,
      effort: now.effort || null,
      effortLevels: effortLevelsOf(cur),
      // 原生厂商的默认档位由 claude 按模型定，我们不知道就别瞎报
      effortDefault: (cur.effort && cur.effort.default_level) || (PROVIDER.nativeModels ? null : "high"),
      // 真实窗口 —— 前端用量条和门限都按它算，不写死
      contextWindow: Number(cur.context_window) || 0,
      maxOutputTokens: Number(cur.max_output_tokens) || 0,
      autoCompactWindow: effectiveAutoCompact(),
    });
  }
  return NEXT;
}
