// 建档 · 网关这一侧：交档接口、给 claude 的常驻规则与「该建档了」的提醒、压缩后的钩子。
// 规划见 claude-workspace/session-lineage-plan.md §9。谁来建档：会话里的 AI 自己（它最清楚这一章干了什么）。
//
// 权威与时机分开（2026-10-26 真机实测）：钩子输出里的指令模型不执行（当成可能的注入），所以
//   规则放在网关追加的系统提示里（应用方的话，模型认）；
//   时机：每次起 claude 时网关自己算（刚结束的章没题名 / 没压缩过的会话聊到第 3 轮），写进系统提示；
//   跑到一半自动压缩的，由 SessionStart:compact 钩子补一句「刚压缩过」—— 只陈述事实，不下指令。
// 交档：AI 在 Bash 里跑 archive/cc-archive.mjs → POST /api/archive（带网关令牌、本轮编号）→ 这里按规范校验，
//   不合格把原因退回去，AI 改了再交。
import path from "node:path";
import { HERE, LAST_LANG, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { RUNS } from "./runs.mjs";
import { NAMES } from "./sessions.mjs";
import { publish } from "./bus.mjs";
import { lineageRecord } from "./lineage.mjs";
import { archiveDb, saveArchive } from "./archive-store.mjs";
import { SPEC_VERSION, archiveNo, chapterView, normStatus, pickChapter, validateTitle } from "./archive-core.mjs";

const DIR = path.join(HERE, "archive");
export const ARCHIVE_CLI = path.join(DIR, "cc-archive.mjs");
const specFile = (lang) => path.join(DIR, /^zh/i.test(lang) ? "spec.zh.md" : "spec.en.md");
const LANG_NAME = { zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", ru: "Russian", ar: "Arabic" };
const langName = (l) => (/^zh-(Hant|TW|HK)/i.test(l) ? "Traditional Chinese" : LANG_NAME[String(l).slice(0, 2)] || "English");

/** 交一条档。who：ai / user。返回 { ok, n, no, title } 或 { ok: false, errors } */
export async function fileChapter(sid, { title, same, status, chapter, by = "ai" } = {}) {
  const rec = await lineageRecord(sid);
  if (!rec) return { ok: false, errors: ["session not found"] };
  const v = validateTitle(title, LAST_LANG);
  const st = normStatus(status);
  if (st === undefined) v.errors.push(/^zh/i.test(LAST_LANG) ? "状态只能是：进行中 / 已完成 / 搁置" : "status must be one of: ongoing / done / paused");
  if (v.errors.length) return { ok: false, errors: v.errors };
  const db = archiveDb();
  const entry = db.sessions[sid] || (db.sessions[sid] = { title: null, chapters: {} });
  const pick = pickChapter(rec, entry, chapter);
  if (pick.error) return { ok: false, errors: [pick.error] };
  const n = pick.n, old = entry.chapters[n];
  if (old?.locked && by === "ai") return { ok: false, errors: [/^zh/i.test(LAST_LANG) ? `第 ${n} 章的题名用户改过并锁定了，不用再建` : `chapter ${n} was titled by the user and is locked; nothing to do`] };
  const hist = old?.hist || [];
  if (old?.title && old.title !== v.title) hist.push({ title: old.title, at: old.at || 0, by: old.by || null });
  entry.chapters[n] = { title: v.title, status: st || old?.status || null, same: !!same && n > 1, by, at: Date.now(), spec: SPEC_VERSION, locked: by === "user" || !!old?.locked, hist: hist.slice(-20) };
  entry.title = chapterView(rec, entry).sessionTitle;
  saveArchive();
  log(`建档 ${archiveNo(sid, n)}「${v.title}」${same ? "（同上一章）" : ""}${by === "user" ? "（用户）" : ""}`);
  publish({ type: "archive", sessionId: sid, n, title: v.title, sessionTitle: NAMES[sid] || entry.title });
  return { ok: true, n, no: archiveNo(sid, n), title: v.title, sessionTitle: entry.title };
}

/** 章节一览（脉络页、档号解析用） */
export async function archiveView(sid) {
  const rec = await lineageRecord(sid);
  if (!rec) return null;
  const entry = archiveDb().sessions[sid];
  return { id: sid, renamed: NAMES[sid] || null, ...chapterView(rec, entry) };
}

/**
 * 每次起 claude 时追加的系统提示：常驻规则 + 这一轮该不该先建档。端侧小模型不挂（读不起、也不需要）。
 * sid 为空（新会话第一轮）时只给规则。
 */
export async function archiveHint(sid) {
  const lang = LAST_LANG;
  const rule = `Session archiving (cccodroid): this app keeps an archive of every session; each context compaction ends one chapter, and the session list shows the latest chapter's title. Whenever the context has just been compacted (you see a compaction summary, or a note saying so), first file the chapter that just ended, then continue your task: read ${specFile(lang)} once for the rules, then run \`node ${ARCHIVE_CLI} --title "<title>"\` (add --same if it continues the previous chapter's work). Write titles in ${langName(lang)}. If the command rejects the title, fix it as told and run it again. Don't mention archiving to the user unless asked.`;
  if (!sid) return rule;
  const rec = await lineageRecord(sid).catch(() => null);
  if (!rec) return rule;
  const entry = archiveDb().sessions[sid];
  const C = rec.compacts.length, has = (k) => !!entry?.chapters?.[k]?.title;
  let todo = "";
  if (C >= 1 && !has(C)) todo = `Archive note: chapter ${C} of this session has ended (at the last compaction) and is not filed yet. File it first, before anything else.`;
  else if (!entry?.title && !NAMES[sid] && rec.turns >= 2) todo = `Archive note: this session has no title yet. Before your final reply in this turn, file the current chapter (chapter ${C + 1}).`;
  return todo ? rule + "\n" + todo : rule;
}

export async function routeArchive(req, res, u, p) {
  if (p !== "/api/archive") return NEXT;
  if (req.method === "GET") {
    const sid = u.searchParams.get("session") || "";
    const v = sid ? await archiveView(sid) : null;
    return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: "not found" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  // AI 交档带的是本轮编号（环境变量 CCAPP_RUN_ID），网关换成会话号；界面上手改直接给会话号
  let sid = b.session ? String(b.session) : "", by = b.session ? "user" : "ai";
  if (!sid && b.run) sid = RUNS.get(String(b.run))?.sessionId || "";
  if (!sid) return sendJson(res, 400, { ok: false, errors: ["cannot tell which session this is (run not found)"] });
  const r = await fileChapter(sid, { title: b.title, same: !!b.same, status: b.status, chapter: b.chapter, by });
  return sendJson(res, r.ok ? 200 : 422, r);
}
