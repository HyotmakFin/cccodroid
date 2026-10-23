// ── 每个会话自己的模型与思考强度（0.3.16 起）────────────────────────────
// 全局设置（SETTINGS.model / effort，设置页里改）是默认值；会话里在输入栏面板单独选过，才记一条它自己的，
// 没选过的会话一直跟着全局默认走（全局改了它也跟着变）。各会话按各自的模型并行跑（run.mjs 每轮按自己的模型起 claude）。
// 还没会话号的新会话：前端把选的值随第一条消息带来（/api/chat 的 pin），拿到会话号时记上。
// 接口（provider）也按会话：单独选过模型（含 "" = 接口默认）的会话钉在记下的那家，全局切了接口它也照旧用那家；
// 只选过思考强度的（model 为 null）模型和接口都跟着全局默认。记下的那家被删了，这条就当没有。
// 存储：home/ccapp-session-models.json  { 会话号: { model, effort, provider, at } }，留最近 3000 条。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { PROVIDER, providerById } from "./providers.mjs";
import { SETTINGS } from "./settings.mjs";

const FILE = path.join(CFG.home, "ccapp-session-models.json");
let DB = {};
try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch {}
let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const ids = Object.keys(DB);
    if (ids.length > 3000) for (const id of ids.sort((a, b) => (DB[a].at || 0) - (DB[b].at || 0)).slice(0, ids.length - 3000)) delete DB[id];
    try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB)); fs.renameSync(FILE + ".tmp", FILE); } catch {}
  }, 300);
}

/** 这个会话记下的选择；没记过、或记的那家已经不在了，返回 null */
export function sessModel(sid) {
  const r = sid && DB[sid];
  if (!r) return null;
  if (r.model != null && !providerById(r.provider)) return null;
  return r;
}
/** 这个会话用哪家：钉了模型就是记下的那家，否则全局生效的那家 */
export function sessProvider(sid) {
  const r = sessModel(sid);
  return (r && r.model != null && providerById(r.provider)) || PROVIDER;
}
/** 记下（只改给了的字段）。model 为 "" 表示「接口默认」，也是一种选择 */
export function clearSessModel(sid) { if (sid && DB[sid]) { delete DB[sid]; save(); } }
export function setSessModel(sid, patch) {
  if (!sid) return;
  const old = sessModel(sid) || {};
  // 没指明接口：沿用这个会话现在用的那家（钉过的那家，或全局生效的）
  const r = { model: old.model ?? null, effort: old.effort ?? null, provider: sessProvider(sid).id, at: Date.now() };
  // 指明了接口就钉住它（哪怕和全局是同一家：全局以后再切，这个会话也不跟）
  if (patch.provider && (patch.provider !== r.provider || r.model == null)) {
    r.provider = String(patch.provider);
    r.model = "";                  // 换了家：旧模型名对新家没意义，先用新家的默认，除非同时给了模型
  }
  if (patch.model !== undefined) r.model = patch.model == null ? null : String(patch.model);
  if (patch.effort !== undefined) r.effort = patch.effort == null ? null : String(patch.effort);
  DB[sid] = r;
  save();
}
/** 界面上显示的「这个会话现在用什么」：记过的 → 全局默认 */
export function effectiveModel(sid) {
  const r = sessModel(sid);
  const pin = r && r.model != null;
  return { model: pin ? r.model : SETTINGS.model || "", effort: r && r.effort != null ? r.effort : SETTINGS.effort || "",
    provider: pin ? r.provider : PROVIDER.id, ownProvider: !!(pin && r.provider !== PROVIDER.id), own: !!r };
}

// ── 路由：/api/session-model ──
//   GET  ?id=会话号                      → { model, effort, own }
//   POST { id, model?, effort?, provider? } → 记到这个会话上（不动全局默认）；只给 provider = 换家、用它的默认模型
//   POST { id, reset: true }             → 清掉，回到跟随全局默认
export async function routeSessModel(req, res, u, p) {
  if (p !== "/api/session-model") return NEXT;
  if (req.method === "GET") return sendJson(res, 200, effectiveModel(u.searchParams.get("id") || ""));
  if (req.method === "POST") {
    let b = {};
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const patch = {};
    if (typeof b.model === "string") patch.model = b.model.trim().slice(0, 200);
    if (typeof b.effort === "string") patch.effort = b.effort.trim().slice(0, 20);
    if (!b.id) return sendJson(res, 400, { error: "id" });
    if (typeof b.provider === "string" && b.provider) {
      if (!providerById(b.provider)) return sendJson(res, 400, { error: "provider" });
      patch.provider = b.provider;
    }
    if (b.reset) clearSessModel(String(b.id)); else setSessModel(String(b.id), patch);
    return sendJson(res, 200, { ok: true, ...effectiveModel(String(b.id)) });
  }
  return NEXT;
}
