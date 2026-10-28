// 子代理联络簿（gw/agents.mjs）。样本是真机抓的事件流（10-28，DeepSeek flash）：
//   stream-agents-nested  主会话后台派 alpha，alpha 再派孙代理 beta；beta 按名字给 alpha 发消息（失败，实测 Agent 没有名字参数）、给 main 发消息（送达）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentBook, readAgentIndex, takeAgentNote } from "../gw/agents.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => fs.readFileSync(path.join(FIX, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function play(evs) {
  const cwd = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "ag-"));
  const run = { sessionId: "4a591756-e2e7", cwd }, out = [];
  const b = agentBook(run, { emit: (e) => out.push(e) });
  for (const ev of evs) b.feed(ev);
  return { cwd, out, run };
}

test("派出、孙代理层级、交代落盘", () => {
  const { out, cwd, run } = play(load("stream-agents-nested.jsonl"));
  const sp = out.filter((e) => e.k === "spawn");
  assert.equal(sp.length, 2);
  assert.equal(sp[0].name, "alpha"); assert.equal(sp[0].depth, 1); assert.equal(sp[0].by, "main");
  assert.equal(sp[1].depth, 2); assert.equal(sp[1].parent, sp[0].id); assert.equal(sp[1].by, sp[0].id);
  // 交代用 Agent 工具调用里的完整 prompt
  assert.match(fs.readFileSync(sp[0].file, "utf8"), /你的名字是 alpha/);
  assert.match(sp[1].file, /\/02-beta_[^/]*\/brief\.md$/, sp[1].file);
  assert.ok(fs.existsSync(path.join(cwd, ".cccodroid", ".gitignore")));
  assert.equal(readAgentIndex(cwd, run.sessionId).length, out.length);
});

test("联络：谁为什么事联系谁，送达与否", () => {
  const { out } = play(load("stream-agents-nested.jsonl"));
  const sp = out.filter((e) => e.k === "spawn"), beta = sp[1].id;
  const msgs = out.filter((e) => e.k === "msg");
  assert.equal(msgs.length, 2);
  assert.deepEqual([msgs[0].from, msgs[0].to, msgs[0].why], [beta, sp[0].id, "beta 向 alpha 报到"]);   // 名字认得出是 alpha，但发不到
  assert.deepEqual([msgs[1].from, msgs[1].to], [beta, "main"]);
  const oks = out.filter((e) => e.k === "msg_ok");
  assert.equal(oks.find((o) => o.mid === msgs[0].mid).ok, false);
  assert.match(oks.find((o) => o.mid === msgs[0].mid).err, /alpha/);
  assert.equal(oks.find((o) => o.mid === msgs[1].mid).ok, true);
});

test("结束：汇报落盘，两个都完了才汇总，给主会话留话（取一次就没了）", () => {
  const { out, cwd, run } = play(load("stream-agents-nested.jsonl"));
  const dn = out.filter((e) => e.k === "done");
  assert.equal(dn.length, 2);
  assert.ok(dn.every((d) => d.status === "done"));
  assert.match(fs.readFileSync(dn[1].file, "utf8"), /未进行其他操作/);   // 汇报是子代理最后一段正文
  const sm = out.filter((e) => e.k === "summary");
  assert.equal(sm.length, 1);
  const note = takeAgentNote(cwd, run.sessionId);
  assert.match(note, /^<cccodroid-agents>/);
  assert.ok(note.includes(sm[0].file));
  assert.ok(note.includes("report.md"));
  assert.equal(takeAgentNote(cwd, run.sessionId), "");
});

test("长消息替模型落成文件，消息里只剩一句事由", () => {
  const long = "x".repeat(400);
  const evs = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "SendMessage", input: { to: "main", message: "第一行说事由\n" + long } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: '{"success":true}' }] } },
  ];
  const { out } = play(evs);
  const m = out.find((e) => e.k === "msg");
  assert.equal(m.why, "第一行说事由");
  assert.ok(m.file && fs.readFileSync(m.file, "utf8").includes(long));
  assert.equal(out.find((e) => e.k === "msg_ok").ok, true);
});

test("只派一个子代理不汇总", () => {
  const evs = [
    { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "t1", description: "solo", task_type: "local_agent", spawn_depth: 1 },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "做完了" }] }] } },
  ];
  const { out, cwd, run } = play(evs);
  assert.equal(out.find((e) => e.k === "done").status, "done");
  assert.equal(out.filter((e) => e.k === "summary").length, 0);
  assert.equal(takeAgentNote(cwd, run.sessionId), "");
});

// stream-agents-resume：同一题加了联络规矩再跑一遍。主会话两次给已结束的 alpha 发消息把它叫醒，alpha 先后结束三次
test("叫醒已结束的代理：重新算在跑，每次结束都记汇报，旧的留 prev", () => {
  const { out } = play(load("stream-agents-resume.jsonl"));
  const alpha = out.find((e) => e.k === "spawn" && e.name === "alpha").id;
  assert.equal(out.filter((e) => e.k === "resume" && e.id === alpha).length, 2);
  const dn = out.filter((e) => e.k === "done" && e.id === alpha);
  assert.equal(dn.length, 3);
  assert.equal(dn[2].why, "alpha 完成");
  assert.ok(fs.existsSync(dn[2].file.replace("report.md", "report.prev.md")));
  const bad = out.find((e) => e.k === "msg_ok" && !e.ok);
  assert.equal(bad.err, "No agent named 'alpha' is reachable.");
  assert.equal(out.filter((e) => e.k === "summary").length, 1);   // 叫醒的只有一个，不再汇总
});
