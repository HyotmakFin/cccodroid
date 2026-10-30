// 脉络阶段 3 · 剖面（gw/profile.mjs）：按章切轮、一轮里的工具与子代理、长出去的分叉挂在哪一轮
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chapterProfile, routeProfile, saveExport, turnDetail } from "../gw/profile.mjs";

const id = () => crypto.randomUUID();
const T0 = Date.parse("2026-10-21T00:00:00Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const dir = path.join(process.env.CCAPP_HOME, ".claude", "projects", "-profile");
const put = (f, lines) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); };
const ask = (S, sec, q) => ({ type: "user", uuid: id(), sessionId: S, timestamp: iso(sec), message: { role: "user", content: q } });
const call = (S, sec, tid, name, input) => ({ type: "assistant", uuid: id(), sessionId: S, timestamp: iso(sec), message: { role: "assistant", content: [{ type: "tool_use", id: tid, name, input }] } });
const res = (S, sec, tid, err) => ({ type: "user", uuid: id(), sessionId: S, timestamp: iso(sec), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: "ok", ...(err ? { is_error: true } : {}) }] } });
const say = (S, sec, text) => ({ type: "assistant", uuid: id(), sessionId: S, timestamp: iso(sec), message: { role: "assistant", content: [{ type: "text", text }] } });

function fixture() {
  const S = id(), L = [];
  // 第 1 章：两轮
  L.push(ask(S, 0, "第一个问题"), call(S, 2, "t1", "Bash", { command: "ls", description: "列目录" }), res(S, 3, "t1"), say(S, 4, "好了"));
  L.push(ask(S, 60, "第二个问题"), call(S, 61, "t2", "Read", { file_path: "/a.txt" }), res(S, 62, "t2", true), say(S, 63, "读不到"));
  const forkAt = L[L.length - 1].uuid;
  L.push({ type: "user", uuid: id(), sessionId: S, isCompactSummary: true, timestamp: iso(100), message: { role: "user", content: "摘要" } });
  // 第 2 章：压缩落在一轮中间，开头先接着干；然后一轮派了子代理
  L.push(call(S, 101, "t3", "Bash", { command: "make" }), res(S, 110, "t3"), say(S, 111, "编好了"));
  L.push(ask(S, 200, "派个子代理查一下"), call(S, 201, "a1", "Agent", { description: "查资料", prompt: "去查" }), res(S, 260, "a1"), say(S, 261, "查完了"));
  const f = path.join(dir, S + ".jsonl");
  put(f, L);
  // 子代理和它派的孙代理
  const sub = path.join(dir, S, "subagents");
  put(path.join(sub, "agent-aaa.jsonl"), [ask(S, 202, "去查"), call(S, 203, "g1", "Grep", { pattern: "x" }), res(S, 205, "g1"), call(S, 206, "a2", "Agent", { description: "再细查" }), res(S, 240, "a2"), say(S, 250, "结论：有")].map((x) => ({ ...x, isSidechain: true })));
  fs.writeFileSync(path.join(sub, "agent-aaa.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "查资料", toolUseId: "a1", finished: true }));
  put(path.join(sub, "agent-bbb.jsonl"), [ask(S, 207, "再细查"), call(S, 208, "w1", "WebFetch", { url: "https://e.x" }), res(S, 230, "w1", true), say(S, 238, "没查到")].map((x) => ({ ...x, isSidechain: true })));
  fs.writeFileSync(path.join(sub, "agent-bbb.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "再细查", toolUseId: "a2", parentAgentId: "aaa", finished: true }));
  // 第 2 个问题那里分叉出一个子会话（逐行照抄到分叉点）
  const K = id(), idx = L.findIndex((x) => x.uuid === forkAt);
  put(path.join(dir, K + ".jsonl"), [...L.slice(0, idx + 1).map((x) => ({ ...x, sessionId: K })), ask(K, 5000, "换个思路")]);
  return { S, K };
}

test("按章切轮：起止、工具数、出错数；压缩落在一轮中间时新章开头接着算一轮；分叉挂在分出去的那一轮", async () => {
  const { S, K } = fixture();
  await new Promise((r) => setTimeout(r, 20));   // 子会话文件晚建（判方向靠文件创建时间）
  fs.utimesSync(path.join(dir, K + ".jsonl"), new Date(), new Date());
  const c1 = await chapterProfile(S, 1);
  assert.equal(c1.chapters, 2);
  assert.deepEqual(c1.turns.map((x) => x.q), ["第一个问题", "第二个问题"]);
  assert.equal(c1.turns[0].t1 - c1.turns[0].t0, 4000);
  assert.deepEqual(c1.turns.map((x) => x.errs), [0, 1]);
  assert.deepEqual(c1.turns[1].kids.map((x) => x.id), [K], "分叉点在第二轮");
  const c2 = await chapterProfile(S, 2);
  assert.equal(c2.open, true);
  assert.equal(c2.turns[0].cont, true, "开头接着上一章那一轮");
  assert.equal(c2.turns[1].agents, 1);
  assert.deepEqual(c2.turns[1].top, [["Agent", 1]]);
  assert.equal((await chapterProfile(S, 3)).error, "no_chapter");
});

test("一轮的细节：主会话工具起止，子代理和孙代理各自的起止与出错", async () => {
  const { S } = fixture();
  const t = (await chapterProfile(S, 2)).turns[1];
  const d = await turnDetail(S, t.off, t.end);
  assert.equal(d.q, "派个子代理查一下");
  assert.deepEqual(d.main.map((x) => [x.name, x.t1 - x.t0, x.t0 - x.p0]), [["Agent", 59000, 1000]], "调用前想了 1 秒（提问到发起）");
  assert.equal(d.agents[0].steps[1].t0 - d.agents[0].steps[1].p0, 1000, "子代理第二步：上一步结束到这一步发起");
  assert.deepEqual(d.agents.map((a) => [a.name, a.depth, a.tools, a.errs]), [["查资料", 1, 2, 0], ["再细查", 2, 1, 1]]);
  assert.equal(d.agents[1].parent, "a1");
  assert.equal(d.agents[0].why, "结论：有");
  assert.equal(d.agents[0].steps[0].label, "x");
  // 字节位置必须在行首、不能越界
  assert.equal((await turnDetail(S, t.off + 1, t.end)).error, "bad_range");
  assert.equal((await turnDetail(S, t.off, t.end + 1e6)).error, "bad_range");
});

test("接口：会话号要合规，找不到给 404", async () => {
  const run = async (url) => {
    const u = new URL("http://x" + url), r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
    await routeProfile({ method: "GET", headers: {} }, r, u, u.pathname);
    return r;
  };
  assert.equal((await run("/api/lineage/profile?id=../x&ch=1")).code, 400);
  assert.equal((await run("/api/lineage/profile?id=" + id() + "&ch=1")).code, 404);
  const { S } = fixture();
  const r = await run("/api/lineage/profile?id=" + S + "&ch=1");
  assert.equal(r.code, 200);
  assert.equal(r.body.turns.length, 2);
});

test("导出落盘：只认 cccodroid-lineage-*.svg/png/html，内容要对得上格式", () => {
  const ok = saveExport("cccodroid-lineage-20261030-2300.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(ok.file, "utf8").slice(0, 4), "<svg");
  assert.equal(saveExport("../x.svg", "<svg/>").error, "bad_name");
  assert.equal(saveExport("cccodroid-lineage-a.svg", "<script>").error, "bad_svg");
  assert.equal(saveExport("cccodroid-lineage-a.html", "<html>").error, "bad_html");
  assert.equal(saveExport("cccodroid-lineage-a.png", Buffer.from("not a png at all, really not, padding padding padding padding padding padding padding padding padding").toString("base64")).error, "bad_png");
  assert.equal(saveExport("cccodroid-lineage-a.html", "<!doctype html><p>x").ok, true);
});
