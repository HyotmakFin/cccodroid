// 脉络 · 显式亲缘记录：home/ccapp-lineage.json。只记事实（谁从谁分出来、从哪条消息分），不记布局。
// 单独成一个小模块，是为了让 sessionops（分叉 / 回退）能直接写，不和 sessions / lineage 绕成循环引用。
// 格式见规划 §3.3：{ v: 1, edges: { <子会话>: { primary: { id, at, kind }, extra: [ { id, at, how, note } ] } } }
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";

const FILE = path.join(CFG.home, "ccapp-lineage.json");
let DB = null;

export function lineageDb() {
  if (DB) return DB;
  try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { DB = null; }
  if (!DB || typeof DB !== "object" || !DB.edges || typeof DB.edges !== "object") DB = { v: 1, edges: {} };
  return DB;
}

function save() {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB), { mode: 0o600 });
    fs.renameSync(FILE + ".tmp", FILE);
    return true;
  } catch (e) { log("写脉络记录失败: " + e.message); return false; }
}

/** 分叉 / 回退时记主父。at：子会话里最后一条和父会话共有的消息（分叉点） */
export function recordPrimary(child, parent, at, kind = "fork") {
  if (!child || !parent || child === parent) return;
  const db = lineageDb();
  db.edges[child] = { ...(db.edges[child] || {}), primary: { id: parent, at: at || null, kind } };
  save();
}

/** 汇合时记附加父（新会话拿到会话号那一刻，run.mjs 调）。how：compact | excerpt | summary | manual。
 *  manual 是「补记来源」：手动给已有会话连一条，和原有的合并去重。
 *  一个会话最多挂 EXTRA_MAX 个附加父（审查 v0.5.13 低6：接口刷不爆记录文件）；返回这次实际记上的条数 */
export const EXTRA_MAX = 32;
export function recordExtra(child, list) {
  if (!child || !Array.isArray(list)) return 0;
  let n = 0;
  const db = lineageDb(), cur = db.edges[child] || {};
  const extra = (cur.extra || []).slice();
  for (const x of list) {
    if (!x || !x.id || x.id === child) continue;
    const i = extra.findIndex((y) => y.id === x.id);
    const v = { id: x.id, at: x.at || null, how: x.how || "excerpt", note: x.note || "" };
    if (i >= 0) extra[i] = v; else if (extra.length < EXTRA_MAX) extra.push(v); else continue;
    n++;
  }
  if (!n) return 0;
  db.edges[child] = { ...cur, extra };
  save();
  return n;
}

/** 去掉一条附加父（补记错了） */
export function dropExtra(child, id) {
  const db = lineageDb(), cur = db.edges[child];
  if (!cur || !cur.extra) return;
  cur.extra = cur.extra.filter((x) => x.id !== id);
  save();
}

/** 会话彻底删掉时清掉它作为「子」的记录（它作为别人的父的记录留着：子会话那边画成「源自已删除的会话」） */
export function forgetChild(child) {
  const db = lineageDb();
  if (!db.edges[child]) return;
  delete db.edges[child];
  save();
}
