// 带密钥的请求不跟着跳到别家（gw/providers.mjs fetchKeyed，审查 v0513b 中-2）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchKeyed } from "../gw/providers.mjs";

const seen = [];
const mk = (fn) => { const s = http.createServer(fn); return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s))); };
const other = await mk((req, res) => { seen.push(req.headers.authorization || ""); res.end("stolen"); });
const home = await mk((req, res) => {
  const p = req.url;
  if (p === "/ok") return res.end("fine");
  if (p === "/same") { res.writeHead(302, { location: "/ok" }); return res.end(); }
  if (p === "/cross") { res.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/x` }); return res.end(); }
  if (p === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
  if (p === "/post") { res.writeHead(307, { location: "/ok" }); return res.end(); }
  if (p === "/post302") { res.writeHead(302, { location: "/ok" }); return res.end(); }
  if (p === "/postx") { res.writeHead(307, { location: `http://127.0.0.1:${other.address().port}/x` }); return res.end(); }
  res.writeHead(404); res.end();
});
after(() => { home.close(); other.close(); });
const H = `http://127.0.0.1:${home.address().port}`;
const auth = { headers: { authorization: "Bearer sk-secret" } };

test("同源跳转照跟，跨源跳转拒绝且密钥不出门", async () => {
  assert.equal(await (await fetchKeyed(H + "/same", auth)).text(), "fine");
  await assert.rejects(fetchKeyed(H + "/cross", auth), /redirect refused/);
  assert.deepEqual(seen, [], "别家一次都没被请求到");
});
test("跳转次数有上限；非 GET 只跟同源的 307/308", async () => {
  await assert.rejects(fetchKeyed(H + "/loop", auth), /redirect refused/);
  assert.equal(await (await fetchKeyed(H + "/post", { ...auth, method: "POST", body: "{}" })).text(), "fine");
  await assert.rejects(fetchKeyed(H + "/post302", { ...auth, method: "POST", body: "{}" }), /redirect refused/);
  await assert.rejects(fetchKeyed(H + "/postx", { ...auth, method: "POST", body: "{}" }), /redirect refused/);
  assert.deepEqual(seen, [], "别家一次都没被请求到");
  assert.equal((await fetchKeyed(H + "/nope", auth)).status, 404);
});
