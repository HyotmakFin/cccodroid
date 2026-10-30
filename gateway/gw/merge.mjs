// 脉络 · 汇合（规划书 §4 阶段 2、§11.3）：把几条会话的思路合进一个新会话。
// 这里管网关这一侧：
//   GET /api/lineage/turns?id=      最近几轮（给「摘录」挑：每轮的提问、回答开头、回答末条消息的 uuid）
//   POST /api/lineage/extra { child, add: [id…] } | { child, drop: id }
//                                   补记来源：贴文字交接的老会话推不出来，手动连一条（how:"manual"）；补错了撤掉
//   GET /api/lineage/material?id=&how=compact|excerpt[&uuids=a,b]
//                                   交接材料：compact = 最新那条压缩摘要（不花钱）；excerpt = 挑的几轮原文（默认最后一轮）
// 新会话本身照常经 /api/chat 开（带 mergeFrom），拿到会话号时 run.mjs 调 recordExtra 当场记下来源 ——
// 材料是贴进去的文字，和来源没有共享 uuid，事后推断不出来。第一条消息末尾的落款「（汇合自 0ab2·5、2f50·2）」是保险，
// 记录丢了 / 导到别的设备时 lineage.mjs 按落款重建（mergeSig）。
// 会话记录一个字节都不改。
import fs from "node:fs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { dropExtra, recordExtra } from "./lineage-store.mjs";
import { lineageFile, lineageRecord } from "./lineage.mjs";

const SID = /^[0-9a-f-]{36}$/i;
const TAIL0 = 4 << 20, TAIL_MAX = 32 << 20;   // 摘录从文件尾往回读：先 4 MB，轮数不够再翻倍，最多 32 MB
const PER_TURN = 20000, TOTAL = 60000;       // 一轮回答最多带这么多字；整份材料的上限（太长的交接反而把新会话塞满）

const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n") : "";
/** 用户提问原文：不是工具结果、不是系统注入（和 lineage-core 的 userText 同一个口径） */
function promptOf(e) {
  if (e.type !== "user" || e.isMeta || e.isCompactSummary || e.isSidechain) return "";
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return "";
  const t = textOf(c);
  return t && !t.startsWith("<") ? t : "";
}

/** 读文件尾部若干字节里的完整行（第一行可能是半截，丢掉） */
function tailLines(file, bytes) {
  const st = fs.statSync(file), n = Math.min(bytes, st.size), buf = Buffer.alloc(n);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buf, 0, n, st.size - n); } finally { fs.closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (n < st.size) lines.shift();
  return { lines, whole: n >= st.size };
}

/** 把记录切成轮：一句真实提问 + 之后直到下一句提问前的全部助手正文。返回从旧到新 */
export function turnsFromLines(lines) {
  const out = [];
  let cur = null;
  for (const s of lines) {
    if (!s || !s.includes('"uuid"')) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.isCompactSummary) { cur = null; continue; }   // 压缩处断开：摘要不算哪一轮的回答
    const q = promptOf(e);
    if (q) { cur = { q, a: [], uuid: e.uuid, ts: Date.parse(e.timestamp || "") || 0 }; out.push(cur); continue; }
    if (cur && e.type === "assistant") {
      const t = textOf(e.message && e.message.content).trim();
      if (t) cur.a.push(t);
      cur.uuid = e.uuid; cur.ts = Date.parse(e.timestamp || "") || cur.ts;
    }
  }
  return out.filter((x) => x.a.length);
}

async function recentTurns(file, want = 30) {
  for (let b = TAIL0; ; b *= 2) {
    const { lines, whole } = tailLines(file, b);
    const turns = turnsFromLines(lines);
    if (turns.length >= want || whole || b >= TAIL_MAX) return turns.slice(-want);
  }
}

const clipTo = (s, n) => (s.length > n ? s.slice(0, n) + "\n\n（……后面还有 " + (s.length - n) + " 字，没带过来）" : s);

/** 一个会话的交接材料：{ how, at, text, chars } 或 { error } */
export async function material(id, how, uuids = []) {
  const rec = await lineageRecord(id), file = lineageFile(id);
  if (!rec || !file) return { error: "not_found" };
  if (how === "compact") {
    const c = rec.compacts[rec.compacts.length - 1];
    if (!c || !(c.off >= 0)) return { error: "no_compact" };
    // 压缩摘要那一行：按扫描时记下的字节位置直接读，不从头翻
    const fd = fs.openSync(file, "r");
    let s = "";
    try {
      const chunks = [];
      for (let pos = c.off, got = 0; got < 64 << 20; ) {
        const buf = Buffer.alloc(1 << 20), n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (!n) break;
        const i = buf.subarray(0, n).indexOf(10);
        chunks.push(buf.subarray(0, i >= 0 ? i : n));
        if (i >= 0) break;
        pos += n; got += n;
      }
      s = Buffer.concat(chunks).toString("utf8");
    } finally { fs.closeSync(fd); }
    let e; try { e = JSON.parse(s); } catch { return { error: "bad_line" }; }
    if (!e.isCompactSummary) return { error: "moved" };   // 文件被改写过、位置对不上：下次刷新索引会重扫
    const text = clipTo(textOf(e.message && e.message.content).trim(), TOTAL);
    return { how, at: e.uuid, ts: c.ts, text, chars: text.length, chapter: rec.compacts.length };
  }
  if (how === "excerpt") {
    const turns = await recentTurns(file, 60);
    if (!turns.length) return { error: "no_turns" };
    const pick = uuids.length ? turns.filter((x) => uuids.includes(x.uuid)) : turns.slice(-1);
    if (!pick.length) return { error: "no_turns" };
    let text = "";
    for (const x of pick) {
      const part = `问：${x.q.trim()}\n\n答：${clipTo(x.a.join("\n\n"), PER_TURN)}`;
      text += (text ? "\n\n---\n\n" : "") + part;
    }
    text = clipTo(text, TOTAL);
    const last = pick[pick.length - 1];
    return { how, at: last.uuid, ts: last.ts, text, chars: text.length, turns: pick.length, chapter: rec.compacts.length + 1 };
  }
  return { error: "bad_how" };
}

export { MERGE_SIG, parseMergeSig } from "./lineage-core.mjs";

/** /api/chat 带来的 mergeFrom 只留认得的字段（新会话才收） */
export function cleanMergeFrom(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v.slice(0, 12)) {
    if (!x || !SID.test(String(x.id || ""))) continue;
    if (out.some((y) => y.id === x.id)) continue;
    out.push({ id: String(x.id), at: typeof x.at === "string" ? x.at.slice(0, 64) : null, how: ["compact", "excerpt", "summary", "manual"].includes(x.how) ? x.how : "excerpt" });
  }
  return out.length ? out : null;
}

export async function routeMerge(req, res, u, p) {
  if (p === "/api/lineage/extra") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const child = String(b.child || "");
    if (!SID.test(child) || !(await lineageRecord(child))) return sendJson(res, 404, { error: "not_found" });
    if (b.drop) { dropExtra(child, String(b.drop)); return sendJson(res, 200, { ok: true }); }
    // 防环（规划书 §2.2）：来源不能是自己；汇合只连已存在的会话。补记不造新会话，不查后代 —— 画图时 family() 按集合走，不会死循环
    const add = cleanMergeFrom((Array.isArray(b.add) ? b.add : []).map((x) => ({ id: x, how: "manual" })))?.filter((x) => x.id !== child && lineageFile(x.id)) || [];
    if (!add.length) return sendJson(res, 400, { error: "nothing" });
    recordExtra(child, add);
    return sendJson(res, 200, { ok: true, n: add.length });
  }
  if (p !== "/api/lineage/turns" && p !== "/api/lineage/material") return NEXT;
  if (req.method !== "GET") return sendJson(res, 405, { error: "method" });
  const id = u.searchParams.get("id") || "";
  if (!SID.test(id)) return sendJson(res, 400, { error: "bad id" });
  const file = (await lineageRecord(id)) && lineageFile(id);
  if (!file) return sendJson(res, 404, { error: "not_found" });
  try {
    if (p === "/api/lineage/turns") {
      const turns = await recentTurns(file, 30);
      return sendJson(res, 200, { turns: turns.map((x) => { const a = x.a.join("\n\n"); return { uuid: x.uuid, ts: x.ts, q: x.q.replace(/\s+/g, " ").slice(0, 200), a: a.replace(/\s+/g, " ").slice(0, 240), chars: a.length }; }) });
    }
    const uuids = (u.searchParams.get("uuids") || "").split(",").filter((x) => x && x.length <= 64).slice(0, 30);
    const r = await material(id, u.searchParams.get("how") || "excerpt", uuids);
    return sendJson(res, r.error ? (r.error === "not_found" ? 404 : 400) : 200, r);
  } catch (e) { return sendJson(res, 500, { error: e.message }); }
}
