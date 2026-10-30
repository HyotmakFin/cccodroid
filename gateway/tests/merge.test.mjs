// 脉络阶段 2 · 汇合（gw/merge.mjs）：取交接材料、挑轮、新会话首条带 mergeFrom 时当场记来源、落款兜底
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cleanMergeFrom, material, parseMergeSig, routeMerge, turnsFromLines } from "../gw/merge.mjs";

const id = () => crypto.randomUUID();
const T0 = Date.parse("2026-10-20T00:00:00Z");
const iso = (min) => new Date(T0 + min * 60000).toISOString();
function chain(sid, turns, start = 0, ans = (i) => "答 " + i) {
  const out = [];
  for (let i = 0; i < turns; i++) {
    out.push({ type: "user", uuid: id(), sessionId: sid, timestamp: iso(start + i * 3), message: { role: "user", content: `问题 ${start + i}` } });
    out.push({ type: "assistant", uuid: id(), sessionId: sid, timestamp: iso(start + i * 3 + 1), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } });
    out.push({ type: "user", uuid: id(), sessionId: sid, timestamp: iso(start + i * 3 + 1), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
    out.push({ type: "assistant", uuid: id(), sessionId: sid, timestamp: iso(start + i * 3 + 2), message: { role: "assistant", content: [{ type: "text", text: ans(start + i) }] } });
  }
  return out;
}
function put(sid, lines, proj = "-merge") {
  const dir = path.join(process.env.CCAPP_HOME, ".claude", "projects", proj);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}
async function get(url) {
  const u = new URL("http://x" + url), res = fakeRes();
  await routeMerge({ method: "GET", headers: {} }, res, u, u.pathname);
  return res;
}

test("切轮：一句提问 + 之后全部助手正文；工具结果不算提问，压缩处断开", () => {
  const S = id(), L = chain(S, 2);
  L.push({ type: "user", uuid: id(), sessionId: S, isCompactSummary: true, timestamp: iso(20), message: { role: "user", content: "摘要" } });
  L.push(...chain(S, 1, 30));
  const turns = turnsFromLines(L.map((l) => JSON.stringify(l)));
  assert.deepEqual(turns.map((x) => x.q), ["问题 0", "问题 1", "问题 30"]);
  assert.deepEqual(turns[2].a, ["答 30"]);
  assert.equal(turns[2].uuid, L[L.length - 1].uuid, "一轮的位置 = 回答最后一条消息");
});

test("交接材料：压缩摘要按字节位置直接读；摘录默认最后一轮，可挑几轮", async () => {
  const S = id(), L = chain(S, 2);
  const sum = { type: "user", uuid: id(), sessionId: S, isCompactSummary: true, timestamp: iso(20), message: { role: "user", content: "这是第一章的压缩摘要：已经把 Mesa 换成补丁版。" } };
  L.push(sum, ...chain(S, 3, 30, (i) => "回答" + i));
  put(S, L);
  const c = await material(S, "compact");
  assert.equal(c.at, sum.uuid);
  assert.match(c.text, /补丁版/);
  assert.equal(c.chapter, 1);
  const e = await material(S, "excerpt");
  assert.match(e.text, /^问：问题 32\n\n答：回答32$/);
  assert.equal(e.chapter, 2);
  const r = await get("/api/lineage/turns?id=" + S);
  assert.equal(r.code, 200);
  const ts = r.body.turns;
  assert.equal(ts.length, 5);
  const two = await get(`/api/lineage/material?id=${S}&how=excerpt&uuids=${ts[2].uuid},${ts[3].uuid}`);
  assert.equal(two.body.turns, 2);
  assert.match(two.body.text, /问题 30[\s\S]*---[\s\S]*问题 31/);
  assert.equal(two.body.at, ts[3].uuid);
  const S2 = id(); put(S2, chain(S2, 1));
  assert.equal((await get(`/api/lineage/material?id=${S2}&how=compact`)).body.error, "no_compact");
  assert.equal((await get(`/api/lineage/material?id=../x&how=compact`)).code, 400);
});

test("mergeFrom 只收认得的：会话号格式、去重、how 白名单", () => {
  const a = id();
  const v = cleanMergeFrom([{ id: a, at: "u1", how: "compact" }, { id: a, how: "excerpt" }, { id: "../../etc", how: "x" }, { id: id(), how: "evil" }]);
  assert.equal(v.length, 2);
  assert.equal(v[0].how, "compact");
  assert.equal(v[1].how, "excerpt");
  assert.equal(cleanMergeFrom("x"), null);
  assert.equal(cleanMergeFrom([]), null);
});

test("落款：只认末尾那一句，档号格式要对", () => {
  assert.deepEqual(parseMergeSig("材料……\n\n（汇合自 0ab2·5、2f50·12）"), [{ short: "0ab2", n: 5 }, { short: "2f50", n: 12 }]);
  assert.equal(parseMergeSig("（汇合自 0ab2·5）然后又说了别的"), null);
  assert.equal(parseMergeSig("（汇合自 xyz·5）"), null);
});

test("记录与兜底：recordExtra 记进图；记录丢了按落款重建", async () => {
  const A = id(), B = id(), C = id(), D = id();
  const LA = chain(A, 1);
  LA.push({ type: "user", uuid: id(), sessionId: A, isCompactSummary: true, timestamp: iso(10), message: { role: "user", content: "摘要" } });
  LA.push(...chain(A, 1, 12));
  put(A, LA); put(B, chain(B, 2, 40));
  const { recordExtra } = await import("../gw/lineage-store.mjs");
  put(C, chain(C, 1, 60));
  recordExtra(C, [{ id: A, at: LA[LA.length - 1].uuid, how: "excerpt" }, { id: B, at: null, how: "compact" }]);
  // D：只有落款，没有记录
  const LD = chain(D, 1, 80);
  LD[0].message.content = `问：…\n\n（汇合自 ${A.slice(0, 4)}·1、${B.slice(0, 4)}·1）`;
  put(D, LD);
  const { lineageGraph } = await import("../gw/lineage.mjs");
  const g = await lineageGraph();
  const ec = g.edges.filter((e) => e.child === C && e.kind === "merge");
  assert.deepEqual(ec.map((e) => e.parent).sort(), [A, B].sort());
  assert.ok(ec.find((e) => e.parent === A).ts > 0, "从取材料的那一点出发");
  const ed = g.edges.filter((e) => e.child === D && e.kind === "merge");
  assert.deepEqual(ed.map((e) => e.parent).sort(), [A, B].sort());
  assert.equal(ed[0].source, "sig");
  assert.equal(ed.find((e) => e.parent === A).at, LA[4].uuid, "第 1 章的摘要 = 第 1 次压缩");
});

test("补记来源：手动连一条、撤掉；自己和不存在的会话不收", async () => {
  const A = id(), B = id(); put(A, chain(A, 1, 100)); put(B, chain(B, 1, 110));
  const post = async (body) => { const res = fakeRes(); const { Readable } = await import("node:stream"); const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = "POST"; req.headers = {}; await routeMerge(req, res, new URL("http://x/api/lineage/extra"), "/api/lineage/extra"); return res; };
  assert.equal((await post({ child: B, add: [A, B, id()] })).body.n, 1);
  const db = () => JSON.parse(fs.readFileSync(path.join(process.env.CCAPP_HOME, "ccapp-lineage.json"), "utf8"));
  assert.deepEqual(db().edges[B].extra.map((x) => [x.id, x.how]), [[A, "manual"]]);
  assert.equal((await post({ child: B, add: [B] })).code, 400);
  await post({ child: B, drop: A });
  assert.equal(db().edges[B].extra.length, 0);
});
