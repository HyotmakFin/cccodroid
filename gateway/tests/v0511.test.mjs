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

// 巨型会话：按行流式读写、流式 zip 导出导入
import crypto from "node:crypto";
import { forEachLine, rewriteLines, zipEntries, zipExtract, zipToFile } from "../gw/bigfile.mjs";
import { zipBuild, zipRead } from "../gw/sessionops.mjs";
const T = (n) => path.join(process.env.CCAPP_TMP, n);

test("forEachLine 与 split 逐行一致（跨块的长行、结尾有无换行、中文）", () => {
  for (const tail of ["", "\n"]) {
    const text = ["a", "中文一行", "x".repeat(3 << 20), "", "末行"].join("\n") + tail;
    fs.writeFileSync(T("l.txt"), text);
    const got = []; const n = forEachLine(T("l.txt"), (l) => { got.push(l); });
    assert.deepEqual(got, text.split("\n")); assert.equal(n, got.length);
    rewriteLines(T("l.txt"), T("l2.txt"), (l) => l.toUpperCase());
    assert.equal(fs.readFileSync(T("l2.txt"), "utf8"), text.toUpperCase());
  }
  const seen = []; forEachLine(T("l.txt"), (l, i) => { seen.push(i); if (i === 1) return false; });
  assert.deepEqual(seen, [0, 1]);
});

test("流式 zip：写出的包老读法也认，老包流式读法也认；解压按实际字节扣额度", async () => {
  const big = crypto.randomBytes(1 << 20).toString("hex").repeat(3);   // 6 MB，跨好几块
  fs.writeFileSync(T("big.txt"), big);
  await zipToFile(T("a.zip"), [{ name: "m.json", data: "{}" }, { name: "d/big.txt", file: T("big.txt") }, { name: "empty", data: "" }]);
  const old = zipRead(fs.readFileSync(T("a.zip")));
  assert.deepEqual(old.map((e) => [e.name, e.data.length]), [["m.json", 2], ["d/big.txt", big.length], ["empty", 0]]);
  const ents = zipEntries(T("a.zip"));
  await zipExtract(T("a.zip"), ents[1], T("out.txt"), { left: Infinity }, null);
  assert.equal(fs.readFileSync(T("out.txt"), "utf8"), big);
  await zipExtract(T("a.zip"), ents[2], T("out0"), { left: 0 });
  assert.equal(fs.readFileSync(T("out0"), "utf8"), "");
  await assert.rejects(zipExtract(T("a.zip"), ents[1], T("out2.txt"), { left: 1000 }), /太大/);
  fs.writeFileSync(T("b.zip"), zipBuild([{ name: "s.txt", data: "abc" }, { name: "z.txt", data: "q".repeat(5000) }]));
  const e2 = zipEntries(T("b.zip"));
  await zipExtract(T("b.zip"), e2[0], T("s.txt"), { left: 99 }); await zipExtract(T("b.zip"), e2[1], T("z.txt"), { left: 1e6 });
  assert.equal(fs.readFileSync(T("s.txt"), "utf8"), "abc"); assert.equal(fs.readFileSync(T("z.txt"), "utf8").length, 5000);
  assert.throws(() => zipEntries(T("big.txt")), /zip/);
});

test("会话导出再导入（流式）：cwd 改成本机工作区、子代理记录跟着走；分叉和删消息照常", async () => {
  const { CFG, PATHS } = await import("../gw/config.mjs");
  const ops = await import("../gw/sessionops.mjs");
  const { findSessionFile } = await import("../gw/sessions.mjs");
  const sid = crypto.randomUUID(), dir = path.join(PATHS.projects, "-x");
  fs.mkdirSync(path.join(dir, sid, "subagents"), { recursive: true });
  const u1 = crypto.randomUUID(), a1 = crypto.randomUUID(), u2 = crypto.randomUUID(), a2 = crypto.randomUUID();
  const L = [
    { type: "user", uuid: u1, parentUuid: null, sessionId: sid, cwd: "/x", message: { role: "user", content: "第一问" } },
    { type: "assistant", uuid: a1, parentUuid: u1, sessionId: sid, cwd: "/x", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(2 << 20) }] } },
    { type: "user", uuid: u2, parentUuid: a1, sessionId: sid, cwd: "/x", message: { role: "user", content: "第二问" } },
    { type: "assistant", uuid: a2, parentUuid: u2, sessionId: sid, cwd: "/x", message: { role: "assistant", content: [{ type: "text", text: "答" }] } },
  ];
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), L.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, sid, "subagents", "agent-1.jsonl"), "{}\n");
  const ex = await ops.exportSessions([sid]);
  assert.equal(ex.count, 1);
  // 换个 id 导回来（同 id 会被跳过）
  const nid = crypto.randomUUID();
  const ents = zipEntries(ex.file);
  const files = [];
  for (const e of ents) { await zipExtract(ex.file, e, T("x-" + files.length), { left: Infinity }); const d = fs.readFileSync(T("x-" + files.length)); files.push({ name: e.name.replaceAll(sid, nid), data: e.name === "manifest.json" ? d.toString().replaceAll(sid, nid) : d }); }
  fs.writeFileSync(T("re.zip"), zipBuild(files));
  const r = await ops.importSessions(T("re.zip"));
  assert.deepEqual(r.imported, [nid]);
  const f = findSessionFile(nid).file;
  const lines = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.ok(lines.every((x) => x.cwd === fs.realpathSync(CFG.workspace)));
  assert.ok(fs.existsSync(path.join(path.dirname(f), nid, "subagents", "agent-1.jsonl")));
  assert.equal((await ops.importSessions(T("re.zip"))).skipped[0], nid);
  // 分叉：保留第一轮
  const fk = ops.forkSession(sid, "", 0, { uuid: u2, before: true });
  assert.equal(fk.ok, true, fk.message);
  const fl = fs.readFileSync(findSessionFile(fk.id).file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(fl.map((x) => x.uuid), [u1, a1]);
  assert.ok(fl.every((x) => x.sessionId === fk.id));
  // 删第一轮的回复：第二问接到第一问上
  const del = ops.deleteMessage(sid, "", 0, "assistant", u1);
  assert.equal(del.ok, true, del.message);
  const dl = fs.readFileSync(findSessionFile(sid).file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(dl.map((x) => x.uuid), [u1, u2, a2]);
  assert.equal(dl[1].parentUuid, u1);
});

// 真 1 GB 以上的会话（慢，默认不跑）：BIG=1 node scripts/test.mjs v0511
test("1.1 GB 的会话：能分叉、能导出导入", { skip: !process.env.BIG }, async () => {
  const { PATHS } = await import("../gw/config.mjs");
  const ops = await import("../gw/sessionops.mjs");
  const { findSessionFile } = await import("../gw/sessions.mjs");
  const sid = crypto.randomUUID(), dir = path.join(PATHS.projects, "-big"), file = path.join(dir, sid + ".jsonl");
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(file, "w"), filler = "z".repeat(1 << 20);
  let prev = null, keep = null;
  for (let i = 0; i < 1100; i++) {
    const u = crypto.randomUUID();
    fs.writeSync(fd, JSON.stringify({ type: "user", uuid: u, parentUuid: prev, sessionId: sid, cwd: "/x", message: { role: "user", content: "问" + i + " " + filler } }) + "\n");
    prev = u; if (i === 1000) keep = u;
  }
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > 1.1e9);
  const fk = ops.forkSession(sid, "", 0, { uuid: keep, before: true });
  assert.equal(fk.ok, true, fk.message);
  assert.equal(forEachLine(findSessionFile(fk.id).file, () => {}), 1001);
  const ex = await ops.exportSessions([sid]);
  fs.rmSync(file); fs.rmSync(findSessionFile(fk.id).file);
  const r = await ops.importSessions(ex.file);
  assert.deepEqual(r.imported, [sid]);
  assert.equal(forEachLine(findSessionFile(sid).file, () => {}), 1101);
});
