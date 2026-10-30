// v0.5.11：第九份审查
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOKEN, localAddr, proof, sigOk } from "../gw/access.mjs";

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
