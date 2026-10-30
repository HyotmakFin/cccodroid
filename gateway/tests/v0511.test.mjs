// v0.5.11：第九份审查
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOKEN, localAddr, proof, sigOk } from "../gw/access.mjs";
import { agentBook, settleAgentRecs } from "../gw/agents.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 自检脚本「状态对账」那段 node：先核身份再签名，不发令牌原文（高2）
function selftestSnippet() {
  const s = fs.readFileSync(path.join(ROOT, "android/assets/bin/cccodroid-selftest"), "utf8");
  const m = /out=\$\(TF="\$TF" GP="\$GP" node -e '([\s\S]*?)' 2>&1\)/.exec(s);
  assert.ok(m, "自检脚本里找不到对账那段");
  return m[1];
}
function serve(handler) {
  return new Promise((ok) => { const srv = http.createServer(handler); srv.listen(0, "127.0.0.1", () => ok(srv)); });
}
function run(snippet, port) {
  const tf = path.join(process.env.CCAPP_TMP, "tok");
  fs.writeFileSync(tf, TOKEN + "\n");
  return new Promise((ok) => execFile(process.execPath, ["-e", snippet], { env: { ...process.env, TF: tf, GP: String(port) } }, (e, out, err) => ok({ code: e ? e.code : 0, out, err })));
}

test("自检对账：真网关核过身份后按 sig2 签名通过，全程不出现令牌原文", async () => {
  const seen = [];
  const srv = await serve((req, res) => {
    seen.push(JSON.stringify([req.url, req.headers]));
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__proof") return res.end(proof(u.searchParams.get("n"), localAddr(req)));
    if (!sigOk(req.headers["x-cc-sig"], req.url, { method: req.method, local: localAddr(req) })) { res.statusCode = 403; return res.end("no"); }
    res.end("PASS 对账 :: ok\n");
  });
  const r = await run(selftestSnippet(), srv.address().port);
  srv.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "PASS 对账 :: ok\n");
  assert.equal(seen.length, 2);
  assert.ok(!seen.some((x) => x.includes(TOKEN)));
});

test("自检对账：端口上是冒牌的（身份核验不过）就停，不发任何凭据", async () => {
  const seen = [];
  const srv = await serve((req, res) => { seen.push(req.url); res.end("0".repeat(32) + " " + "0".repeat(64)); });
  const r = await run(selftestSnippet(), srv.address().port);
  srv.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /身份核验没过/);
  assert.deepEqual(seen.map((u) => u.split("?")[0]), ["/__proof"]);
});

// 中途停止后重进：子代理不再一直显示在跑

test("claude 退出时还在跑的子代理补记「已停止」，已结束的不动", () => {
  const out = [];
  const b = agentBook({}, { emit: (e) => out.push(e) });
  for (const id of ["a1", "a2"]) b.feed({ type: "system", subtype: "task_started", task_type: "local_agent", task_id: id, tool_use_id: "t" + id, description: id });
  b.feed({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "ok" });
  b.close();
  const done = out.filter((e) => e.k === "done").map((e) => [e.id, e.status]);
  assert.deepEqual(done, [["a1", "done"], ["a2", "stopped"]]);
  b.close();
  assert.equal(out.filter((e) => e.k === "done").length, 2, "再收一次不重复记");
});

test("翻历史：派出了没结束、眼下不在跑的按已停止补；在跑的、已结束的、被叫醒后在跑的照旧", () => {
  const recs = [
    { at: 1, k: "spawn", id: "x" }, { at: 2, k: "spawn", id: "y" }, { at: 3, k: "spawn", id: "z" }, { at: 4, k: "spawn", id: "w" },
    { at: 5, k: "done", id: "y", status: "done" }, { at: 6, k: "done", id: "w", status: "done" }, { at: 7, k: "resume", id: "w" },
    { at: 8, k: "msg", from: "x", to: "main", mid: "m" },
  ];
  const add = settleAgentRecs(recs, new Set(["z"])).slice(recs.length);
  assert.deepEqual(add.map((r) => [r.id, r.status, r.at]), [["x", "stopped", 8], ["w", "stopped", 7]]);
  assert.equal(settleAgentRecs(recs.slice(0, 0)).length, 0);
});
