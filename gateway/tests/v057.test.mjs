// #52 复测残留的网关一侧：认消息不猜、定时任务次数、读错不当空
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const home = process.env.CCAPP_HOME;
const proj = path.join(home, ".claude", "projects", "-v057");
fs.mkdirSync(proj, { recursive: true });

// 会话里 texts 依次是用户说的话，每句后面跟一条回答
function session(texts) {
  const sid = crypto.randomUUID(), L = [], uu = [];
  for (const t of texts) {
    const u = crypto.randomUUID(); uu.push(u);
    L.push({ type: "user", uuid: u, sessionId: sid, message: { role: "user", content: t } });
    L.push({ type: "assistant", uuid: crypto.randomUUID(), sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "答" }] } });
  }
  fs.writeFileSync(path.join(proj, sid + ".jsonl"), L.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { sid, uu };
}

// 起一个只挂某个路由的小服务，测完关掉
async function serve(route) {
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); await route(req, res, u, u.pathname); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return (p, init) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, init);
}

test("认消息：给了 uuid 只按 uuid；对不上就拒绝，不退回按原文猜（P1-2）", async () => {
  const { locateUserTurn } = await import("../gw/sessionops.mjs");
  const { sid, uu } = session(["同一句", "别的", "同一句", "同一句"]);
  assert.equal(locateUserTurn(sid, "同一句", 0, uu[2]).best, 2);
  const r = locateUserTurn(sid, "同一句", 0, crypto.randomUUID());
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test("认消息：没 uuid 时同文好几条，条数恰好对上才认，对不上拒绝（P1-2）", async () => {
  const { locateUserTurn } = await import("../gw/sessionops.mjs");
  const { sid } = session(["同一句", "别的", "同一句", "同一句"]);
  assert.equal(locateUserTurn(sid, "同一句", 0).best, 3);
  assert.equal(locateUserTurn(sid, "同一句", 1).best, 2);
  assert.equal(locateUserTurn(sid, "同一句", 3).best, 0);
  const r = locateUserTurn(sid, "同一句", 2);    // 后面 2 条那轮是「别的」：以前会挑最接近的同文去猜
  assert.equal(r.ok, false);
  assert.match(r.message, /好几次|several/);
  assert.equal(locateUserTurn(sid, "别的", 9).best, 1, "只有一条同文：条数不准也是它");
  assert.equal(locateUserTurn(sid, "没说过", 0).ok, false);
});

test("定时任务：直接调接口也不收 0 次、没日期的有效期（E10）", async () => {
  const { routeSched } = await import("../gw/sched.mjs");
  const go = await serve(routeSched);
  const post = (until) => go("/api/sched", { method: "POST", body: JSON.stringify({ name: "测", prompt: "测", until }) });
  for (const until of [{ kind: "count", count: 0 }, { kind: "count" }, { kind: "count", count: -2 }, { kind: "count", count: 1.5 }, { kind: "date" }, { kind: "date", date: "明天" }]) {
    const r = await post(until);
    assert.equal(r.status, 400, JSON.stringify(until));
  }
  const ok = await post({ kind: "count", count: 3 });
  assert.equal(ok.status, 200);
  const { task } = await ok.json();
  assert.equal(task.until.count, 3);
  await go("/api/sched/" + task.id, { method: "DELETE" });
});

test("项目指令：读不了（不是「没有」）报 500，不当成空的（E06）", async () => {
  const { routeProjects } = await import("../gw/projects.mjs");
  const go = await serve(routeProjects);
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "instr-"));
  const r = await go("/api/projects", { method: "POST", body: JSON.stringify({ name: "指令测", mode: "dir", path: dir }) });
  assert.equal(r.status, 200, await r.clone().text());
  const id = (await r.json()).project.id;
  let g = await (await go(`/api/projects/${id}/instr`)).json();
  assert.deepEqual(g, { text: "", exists: false });
  fs.mkdirSync(path.join(dir, "CLAUDE.md"));     // 读它会 EISDIR：和没权限一样是「读不了」
  const bad = await go(`/api/projects/${id}/instr`);
  assert.equal(bad.status, 500);
  fs.rmdirSync(path.join(dir, "CLAUDE.md"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "规矩\n");
  g = await (await go(`/api/projects/${id}/instr`)).json();
  assert.equal(g.text, "规矩\n");
  await go(`/api/projects/${id}`, { method: "DELETE", body: "{}" });
});

test("新建项目预览：已有同名目录时给出 -2（E13）", async () => {
  const { routeProjects } = await import("../gw/projects.mjs");
  const go = await serve(routeProjects);
  const name = "where-" + Date.now().toString(36);
  const p1 = (await (await go("/api/projects/where?name=" + name)).json()).path;
  assert.equal(path.basename(p1), name);
  fs.mkdirSync(p1, { recursive: true });
  const p2 = (await (await go("/api/projects/where?name=" + name)).json()).path;
  assert.equal(path.basename(p2), name + "-2");
  fs.rmdirSync(p1);
});

test("记账：账本读不了报错，不装成「没有记录」（D-07）", async () => {
  const { readLedger } = await import("../gw/claude.mjs");
  const old = process.env.CCAPP_LEDGER;
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || home, "ledger-"));
  try {
    process.env.CCAPP_LEDGER = path.join(dir, "nope.jsonl");
    assert.deepEqual(readLedger(), []);
    process.env.CCAPP_LEDGER = dir;               // 是个目录：EISDIR
    assert.throws(() => readLedger());
  } finally { if (old == null) delete process.env.CCAPP_LEDGER; else process.env.CCAPP_LEDGER = old; }
});

test("点停止：车道记成挂起（run.mjs 收尾退回队首的插话据此也挂起），排着的也挂起（P2-3）", async () => {
  const { holdLane, QUEUE } = await import("../gw/queue.mjs");
  const sid = crypto.randomUUID(), run = { lane: "lane-v057", sessionId: sid };
  QUEUE.push({ id: "q-v057", message: "排着的", sessionId: sid });
  try {
    holdLane(run);
    assert.equal(run.laneHeld, true);
    assert.equal(QUEUE.find((q) => q.id === "q-v057").held, true);
  } finally { QUEUE.splice(QUEUE.findIndex((q) => q.id === "q-v057"), 1); }
});
