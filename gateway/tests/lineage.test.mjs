// 脉络（gw/lineage-core.mjs + lineage.mjs）：读会话、推断亲缘、增量缓存、分叉时的显式记录
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scanSession, inferParents } from "../gw/lineage-core.mjs";

const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "lineage-"));
const T0 = Date.parse("2026-10-20T00:00:00Z");
const iso = (min) => new Date(T0 + min * 60000).toISOString();

/** 造一条链：n 轮问答，返回行数组；msgs 的 uuid 可预先给定（模拟分叉照抄） */
function chain(sid, turns, start = 0) {
  const out = [];
  let parent = null;
  for (let i = 0; i < turns; i++) {
    const u = { type: "user", uuid: crypto.randomUUID(), parentUuid: parent, sessionId: sid, timestamp: iso(start + i * 2), message: { role: "user", content: `问题 ${start + i}` } };
    const a = { type: "assistant", uuid: crypto.randomUUID(), parentUuid: u.uuid, sessionId: sid, timestamp: iso(start + i * 2 + 1), message: { role: "assistant", content: [{ type: "text", text: "答" }] } };
    out.push(u, a); parent = a.uuid;
  }
  return out;
}
/** 照 forkSession 的做法：抄前 keep 条（只改 sessionId），再接 more 轮新内容（时间在 at 分钟之后） */
function fork(lines, nid, keep, more, at) {
  const copied = lines.slice(0, keep).map((e) => ({ ...e, sessionId: nid }));
  let parent = copied.at(-1).uuid;
  const extra = chain(nid, more, at).map((e, i) => (i === 0 ? { ...e, parentUuid: parent } : e));
  return [...copied, ...extra];
}
const write = (id, lines) => { const f = path.join(DIR, id + ".jsonl"); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return f; };
async function recs(map) {
  const m = new Map();
  for (const [id, { lines, birth }] of Object.entries(map)) { const r = await scanSession(write(id, lines)); r.birth = birth || 0; m.set(id, r); }
  return m;
}
const id = () => crypto.randomUUID();

test("读会话：链上消息、真实提问轮数、第一句；工具结果和 <…> 注入不算提问", async () => {
  const sid = id();
  const lines = [
    ...chain(sid, 2),
    { type: "user", uuid: id(), sessionId: sid, timestamp: iso(10), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
    { type: "user", uuid: id(), sessionId: sid, timestamp: iso(11), message: { role: "user", content: "<system-reminder>别算</system-reminder>" } },
    { type: "user", uuid: id(), sessionId: sid, isCompactSummary: true, timestamp: iso(12), message: { role: "user", content: "摘要" } },
    { type: "file-history-snapshot", messageId: "m" },
  ];
  const r = await scanSession(write(sid, lines));
  assert.equal(r.turns, 2);
  assert.equal(r.first, "问题 0");
  assert.equal(r.uu.length, 7);
  assert.equal(r.compacts.length, 1);
  assert.equal(r.firstTs, T0);
});

test("增量：追加的部分接着读；没写完的最后一行留到下次；开头被改写就从头再读", async () => {
  const sid = id();
  const f = write(sid, chain(sid, 2));
  const r1 = await scanSession(f);
  assert.equal(r1.uu.length, 4);
  const more = chain(sid, 1, 20);
  fs.appendFileSync(f, JSON.stringify(more[0]) + "\n" + JSON.stringify(more[1]).slice(0, 30));   // 第二行没写完
  const r2 = await scanSession(f, r1);
  assert.equal(r2.uu.length, 5);
  assert.equal(r1.uu.length, 4, "不改上一次的结果");
  fs.appendFileSync(f, JSON.stringify(more[1]).slice(30) + "\n");
  const r3 = await scanSession(f, r2);
  assert.equal(r3.uu.length, 6);
  // 删消息会原地重写：开头变了，从头读
  const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(f, all.slice(2).join("\n") + "\n");
  const r4 = await scanSession(f, r3);
  assert.equal(r4.uu.length, 4);
});

test("分叉三代：子、孙都挂对；孙的分叉点早于子时取最近的祖先", async () => {
  const P = id(), C = id(), G = id();
  const p = chain(P, 10);
  const c = fork(p, C, 12, 2, 100);   // 从第 6 轮分
  const g = fork(c, G, 6, 1, 200);    // 从子会话的第 3 轮分（比子会话的分叉点早）
  const m = await recs({ [P]: { lines: p, birth: 1e12 }, [C]: { lines: c, birth: 1e12 + 5000 }, [G]: { lines: g, birth: 1e12 + 9000 } });
  const par = inferParents(m);
  assert.equal(par.get(C).parent, P);
  assert.equal(par.get(C).at, p[11].uuid);
  assert.equal(par.get(G).parent, C);
  assert.equal(par.has(P), false);
});

test("没有创建时间时：分叉后谁先有新内容谁是父", async () => {
  const P = id(), C = id();
  const p = chain(P, 6);            // 父会话分叉前就已经聊到第 6 轮
  const c = fork(p, C, 4, 2, 100);  // 从第 2 轮分，新内容在很久以后
  const m = await recs({ [C]: { lines: c }, [P]: { lines: p } });
  assert.equal(inferParents(m).get(C).parent, P);
});

test("导入的会话：创建时间骗人时，另两票一致就听它们", async () => {
  const P = id(), C = id();
  const p = chain(P, 6);
  const c = fork(p, C, 4, 2, 100);
  const m = await recs({ [P]: { lines: p, birth: 2e12 }, [C]: { lines: c, birth: 1e12 } });   // 父会话是后导入的
  const par = inferParents(m, { names: { [C]: "某会话 · 分叉" } });
  assert.equal(par.get(C).parent, P);
});

test("父会话分叉后删了共有部分里的一条消息：亲缘还在，分叉点取最后一条共有的", async () => {
  const P = id(), C = id();
  const p = chain(P, 6);
  const c = fork(p, C, 8, 1, 100);
  const pDel = p.filter((_, i) => i !== 2);
  const m = await recs({ [P]: { lines: pDel, birth: 1e12 }, [C]: { lines: c, birth: 1e12 + 5000 } });
  const e = inferParents(m).get(C);
  assert.equal(e.parent, P);
  assert.equal(e.at, p[7].uuid);
});

test("回退：标题带「· 回退」记成 rewind", async () => {
  const P = id(), C = id();
  const p = chain(P, 4);
  const c = fork(p, C, 4, 1, 100);
  const m = await recs({ [P]: { lines: p, birth: 1e12 }, [C]: { lines: c, birth: 1e12 + 5000 } });
  assert.equal(inferParents(m, { names: { [C]: "x · 回退" } }).get(C).kind, "rewind");
});

test("显式记录优先于推断；互指成环的记录会被断开", async () => {
  const A = id(), B = id();
  const m = await recs({ [A]: { lines: chain(A, 2) }, [B]: { lines: chain(B, 2) } });
  const par = inferParents(m, { explicit: { [B]: { primary: { id: A, at: "u", kind: "fork" } } } });
  assert.equal(par.get(B).parent, A);
  assert.equal(par.get(B).source, "explicit");
  const loop = inferParents(m, { explicit: { [A]: { primary: { id: B } }, [B]: { primary: { id: A } } } });
  assert.ok(!(loop.has(A) && loop.has(B)), "环至少断一边");
});

test("网关：分叉时写显式记录，/api/lineage 的图里能看到（含回收站里的父会话）", async () => {
  const home = process.env.CCAPP_HOME;
  const proj = path.join(home, ".claude", "projects", "-work");
  fs.mkdirSync(proj, { recursive: true });
  const P = id();
  fs.writeFileSync(path.join(proj, P + ".jsonl"), chain(P, 3).map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { forkSession, trashSession } = await import("../gw/sessionops.mjs");
  const r = forkSession(P, "问题 1", 1);
  assert.ok(r.ok, JSON.stringify(r));
  const db = JSON.parse(fs.readFileSync(path.join(home, "ccapp-lineage.json"), "utf8"));
  assert.equal(db.edges[r.id].primary.id, P);
  assert.equal(db.edges[r.id].primary.kind, "fork");
  assert.ok(db.edges[r.id].primary.at);
  trashSession(P);
  const { lineageGraph } = await import("../gw/lineage.mjs");
  const g = await lineageGraph();
  const e = g.edges.find((x) => x.child === r.id);
  assert.equal(e.parent, P);
  assert.equal(e.source, "explicit");
  assert.equal(e.missing, false);
  assert.equal(g.nodes.find((n) => n.id === P).trashed, true);
  assert.ok(fs.existsSync(path.join(home, ".cache", "ccapp-lineage-index.json")), "缓存落盘");
});
