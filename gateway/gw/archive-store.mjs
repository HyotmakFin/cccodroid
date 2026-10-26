// 建档 · 档案文件：home/ccapp-archive.json。题名、章节状态、改动历史都在这里，会话记录（jsonl）一个字节都不改。
// 单独成一个小模块：会话列表（sessions.mjs）要读题名，不和 archive / lineage 绕成循环引用。
// 格式：{ v: 1, sessions: { <会话>: { title, chapters: { <章序>: { title, status, same, by, at, spec, locked, hist: [ { title, at, by } ] } } } } }
//   title：最新一章（卷）的题名，交档时算好存着，会话列表直接用
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";

const FILE = path.join(CFG.home, "ccapp-archive.json");
let DB = null;

export function archiveDb() {
  if (DB) return DB;
  try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { DB = null; }
  if (!DB || typeof DB !== "object" || !DB.sessions || typeof DB.sessions !== "object") DB = { v: 1, sessions: {} };
  return DB;
}

export function saveArchive() {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB), { mode: 0o600 });
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (e) { log("写档案失败: " + e.message); }
}

/** 会话列表用：建过档的会话的最新题名；没建过返回 null */
export const archivedTitle = (id) => archiveDb().sessions[id]?.title || null;
