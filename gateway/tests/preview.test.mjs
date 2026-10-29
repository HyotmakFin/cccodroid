// HTML 预览（gw/preview.mjs）：凭证能读到页面目录里的资源，但以点开头的路径、私钥证书一类不交（审查 10-29 高1）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";
import { routePreview } from "../gw/preview.mjs";

// 每次建一个新的独有目录：绕过 scripts/test.mjs 直接跑时，收尾也只删自己建的，不会碰工作区里已有的 pvtest（#49 P2-18）
fs.mkdirSync(CFG.workspace, { recursive: true });
const site = fs.mkdtempSync(path.join(CFG.workspace, "pvtest-"));
for (const [f, s] of Object.entries({ "index.html": "<p>hi</p>", "assets/app.js": "1", ".env": "KEY=1", ".git/config": "x", "certs/server.key": "k", "id_ed25519": "k", ".well-known/a.json": "{}" })) {
  fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
  fs.writeFileSync(path.join(site, f), s);
}
const gw = http.createServer((req, res) => routePreview(req, res, new URL(req.url, "http://x"), new URL(req.url, "http://x").pathname));
await new Promise((ok) => gw.listen(0, "127.0.0.1", ok));
after(() => { gw.close(); fs.rmSync(site, { recursive: true, force: true }); });

test("预览凭证：页面资源照常，点路径和私钥不交", async () => {
  const r = await (await fetch(`http://127.0.0.1:${gw.address().port}/api/preview`, { method: "POST", body: JSON.stringify({ path: path.join(site, "index.html") }) })).json();
  assert.match(r.url, /^http:\/\/localhost:\d+\/[0-9a-f]{24}\/index\.html$/);
  const base = r.url.replace(/index\.html$/, "");
  const code = async (rel) => (await fetch(base + rel)).status;
  assert.equal(await code("index.html"), 200);
  assert.equal(await code("assets/app.js"), 200);
  assert.equal(await code(".well-known/a.json"), 200);
  for (const rel of [".env", ".git/config", "certs/server.key", "id_ed25519", "assets/../.env"]) assert.equal(await code(rel), 403, rel);
});
