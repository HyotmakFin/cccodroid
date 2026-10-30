// 使用统计的 token 计量：边跑边记、不重复、result 补差额、中断的一轮也算
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usageMeter } from "../gw/usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function meter() {
  const got = [], sum = { t: 0, i: 0, o: 0, c: 0 }, byModel = {};
  const m = usageMeter({ sid: () => "s1", model: () => "main-model", add: (d, sid, model) => {
    got.push(d);
    for (const k in sum) sum[k] += d[k] || 0;
    byModel[model] = (byModel[model] || 0) + (d.i || 0) + (d.o || 0);
  } });
  return { m, got, sum, byModel };
}
const ev = (event, parent = null) => ({ type: "stream_event", parent_tool_use_id: parent, event });
const U = (i, c, o) => ({ input_tokens: i, cache_read_input_tokens: c, cache_creation_input_tokens: 0, output_tokens: o });

test("真实流（工具调用两次请求）：边跑边记，总数和 result 的 usage 一致，不重复算", () => {
  const { m, sum } = meter();
  const lines = fs.readFileSync(path.join(HERE, "fixtures/stream-tool-call.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const res = lines.find((e) => e.type === "result");
  for (const e of lines) if (e !== res) m.feed(e);
  const u = res.usage;
  assert.equal(sum.i, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, "result 之前就已经记全了");
  assert.equal(sum.o, u.output_tokens);
  m.result(res, true);
  assert.equal(sum.i, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, "对账不重复加");
  assert.equal(sum.c, u.cache_read_input_tokens);
  assert.equal(sum.t, 1);
});

test("兼容桥：message_start 输入是 0、delta 才补；assistant 事件重复带同一份 usage 不重复算", () => {
  const { m, sum } = meter();
  m.feed(ev({ type: "message_start", message: { id: "a", usage: U(0, 0, 0) } }));
  m.feed(ev({ type: "message_delta", usage: { output_tokens: 40 } }));
  m.feed({ type: "assistant", message: { id: "a", usage: U(0, 0, 40), content: [] } });
  m.feed(ev({ type: "message_delta", usage: U(900, 100, 120) }));
  assert.deepEqual([sum.i, sum.o, sum.c], [1000, 120, 100]);
});

test("中途被打断（没有 result）：已经流过的请求照样记下", () => {
  const { m, sum } = meter();
  m.feed(ev({ type: "message_start", message: { id: "a", usage: U(5000, 0, 0) } }));
  m.feed(ev({ type: "message_delta", usage: { output_tokens: 300 } }));
  m.feed(ev({ type: "message_start", message: { id: "b", usage: U(200, 5000, 0) } }));
  assert.deepEqual([sum.i, sum.o, sum.t], [10200, 300, 0]);
});

test("子代理的请求记在它自己的型号下；result 只补主会话流里没看到的差额；后台任务的第二轮 result 各对各的", () => {
  const { m, sum, byModel } = meter();
  m.feed(ev({ type: "message_start", message: { id: "a", model: "bridge-name", usage: U(1000, 0, 0) } }));
  m.feed(ev({ type: "message_delta", usage: { output_tokens: 50 } }));
  m.feed({ type: "assistant", parent_tool_use_id: "t1", message: { id: "sub1", model: "haiku-x", usage: U(3000, 0, 200), content: [] } });
  assert.equal(byModel["main-model"], 1050, "主会话按 init 报的型号记，不跟兼容桥回的名字");
  assert.equal(byModel["haiku-x"], 3200);
  // 压缩之类没出流事件的请求：result 的 usage 比流里多出来的部分补上
  m.result({ usage: U(1000, 0, 50 + 80) }, true);
  assert.equal(sum.o, 50 + 200 + 80);
  // 同一进程里后台任务回报又跑了一轮
  m.feed(ev({ type: "message_start", message: { id: "c", usage: U(10, 1000, 0) } }));
  m.feed(ev({ type: "message_delta", usage: { output_tokens: 20 } }));
  m.result({ usage: U(10, 1000, 20) }, true);
  assert.deepEqual([sum.i, sum.o, sum.t], [1000 + 3000 + 1010, 350, 2]);
});

test("斜杠命令那轮：token 照记，不算一轮对话", () => {
  const { m, sum } = meter();
  m.result({ usage: U(8000, 0, 600) }, false);
  assert.deepEqual([sum.i, sum.o, sum.t], [8000, 600, 0]);
});

test("子代理：流里没有用量，从它的记录里读；增量读、不重复，以前几轮的不算", () => {
  const dir = path.join(process.env.CCAPP_HOME, "meter-sub", "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const line = (id, ts, i, o, model = "sub-model") => JSON.stringify({ type: "assistant", timestamp: new Date(ts).toISOString(), message: { id, model, usage: U(i, 0, o) } }) + "\n";
  const start = Date.now();
  fs.writeFileSync(path.join(dir, "agent-old.jsonl"), line("old", start - 3600e3, 99999, 1));
  fs.utimesSync(path.join(dir, "agent-old.jsonl"), new Date(start - 3600e3), new Date(start - 3600e3));
  const got = [], sum = { i: 0, o: 0 }, byModel = {};
  const m = usageMeter({ sid: () => "s1", model: () => "main-model", start, subDir: () => dir, add: (d, sid, model) => {
    got.push(d); sum.i += d.i || 0; sum.o += d.o || 0; byModel[model] = (byModel[model] || 0) + (d.i || 0) + (d.o || 0);
  } });
  const f = path.join(dir, "agent-a.jsonl");
  fs.writeFileSync(f, line("s1", start + 10, 7292, 2) + '{"type":"assistant","usage":');   // 末尾半行
  m.result({ usage: U(0, 0, 0) }, true);
  assert.deepEqual([sum.i, sum.o], [7292, 2]);
  fs.appendFileSync(f, '{}}\n' + line("s1", start + 20, 7292, 40) + line("s2", start + 30, 8000, 5));
  m.close();
  assert.deepEqual([sum.i, sum.o], [7292 + 8000, 40 + 5], "同一条请求只补涨的部分，半行不出错");
  assert.equal(byModel["sub-model"], sum.i + sum.o);
  assert.ok(!byModel["main-model"], "子代理的 token 不记到主会话型号");
});
