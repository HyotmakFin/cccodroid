import "../gw/config.mjs"; // scripts/test.mjs 的隔离 HOME / fake PREFIX，绝不连接真实网关或桥。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { routeComponents } from "../gw/components.mjs";

// 环境中只留确定的假凭据；fixture 不会接触调用者的真实令牌。
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "managed-removal-"));
const reg = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const payload = path.join(prefix, "lib/openai-bridge/fixture-payload.txt");
const neighbor = path.join(path.dirname(reg), "other-service.json");
const stage = path.join(path.dirname(record), ".staging");
const put = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), { mode: 0o600 }); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, message, ms = 3000) {
  const start = performance.now();
  while (!check()) { assert.ok(performance.now() - start < ms, message); await delay(15); }
}
const fixtureSource = `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1];
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify(args)+'\\n');
fs.writeFileSync(path.join(dir,'env-present.json'),JSON.stringify({api:!!process.env.ANTHROPIC_API_KEY,token:!!process.env.ANTHROPIC_AUTH_TOKEN}));
const mode=fs.readFileSync(path.join(dir,'mode'),'utf8');
if(args[0]!=='uninstall'){process.exitCode=2;}
else if(mode==='fail'){process.stderr.write('fixture uninstall rejected');process.exitCode=19;}
else if(mode==='leave-reg'){}
else if(mode==='gate'){
  const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'release'))){clearInterval(timer);fs.rmSync(path.join(process.env.HOME,'.cccodroid/services/openai-bridge.json'),{force:true});}},20);
  setTimeout(()=>{clearInterval(timer);process.exitCode=23;},5000).unref();
}else fs.rmSync(path.join(process.env.HOME,'.cccodroid/services/openai-bridge.json'),{force:true});
`;
function fixture(mode = "ok") {
  for (const p of [reg, record, component]) fs.rmSync(p, { force: true });
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.writeFileSync(path.join(dir, "mode"), mode);
  fs.writeFileSync(path.join(dir, "private-data.txt"), "fixture private data must survive uninstall");
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.writeFileSync(component, fixtureSource);
  fs.writeFileSync(payload, "fixture package payload");
  const r = { schema: 1, id: "openai-bridge", endpoint: "http://127.0.0.1:34593", runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") };
  const rec = { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", "lib/openai-bridge/fixture-payload.txt"] };
  put(reg, r); put(record, rec); put(neighbor, { fixture: "unrelated service" });
  return { dir, r, rec, calls: () => { try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } } };
}
function preserved(f) {
  assert.equal(fs.readFileSync(path.join(f.dir, "private-data.txt"), "utf8"), "fixture private data must survive uninstall");
  assert.deepEqual(JSON.parse(fs.readFileSync(neighbor, "utf8")), { fixture: "unrelated service" });
}
function removed(f, { files = true } = {}) {
  assert.equal(fs.existsSync(reg), false, "固定服务注册必须清理");
  assert.equal(fs.existsSync(record), false, "安装记录不能因不可信注册而滞留");
  for (const p of [component, payload]) assert.equal(fs.existsSync(p), !files, files ? "记录内组件文件必须删除" : "缺少可信文件清单时不能猜测删除工具包文件");
  preserved(f);
}

let handler = routeComponents;
// 只暴露本测试路由；从不走真实认证、provider、安装索引或应用服务器。
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (!["/api/components/remove", "/api/components/cancel", "/api/components/install"].includes(u.pathname)) {
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "fixture route only" })); return;
  }
  Promise.resolve(handler(req, res, u, u.pathname)).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function post(action, id = "openai-bridge") {
  const response = await fetch(origin + "/api/components/" + action, { method: "POST", headers: { "content-type": "application/json", "x-cc-lang": "zh" }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(7000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  return response.json();
}
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const p of [reg, record, component, payload, neighbor]) fs.rmSync(p, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, alter] of [
  ["注册缺失", () => fs.rmSync(reg)],
  ["坏 JSON", () => fs.writeFileSync(reg, "{bad-json")],
  ["null", () => put(reg, null)],
  ["空对象", () => put(reg, {})],
  ["数组", () => put(reg, [])],
  ["命令等多字段", (f) => put(reg, { ...f.r, command: process.execPath, args: ["do-not-run"] })],
  ["单个额外字段", (f) => put(reg, { ...f.r, extra: "fixture" })],
  ["错误实例格式", (f) => put(reg, { ...f.r, instanceId: "wrong-instance" })],
  ["实例为空", (f) => put(reg, { ...f.r, instanceId: null })],
  ["实例为可强转数组", (f) => put(reg, { ...f.r, instanceId: [f.r.instanceId] })],
  ["schema 2", (f) => put(reg, { ...f.r, schema: 2 })],
  ["错误组件 id", (f) => put(reg, { ...f.r, id: "other-component" })],
  ["远端 endpoint", (f) => put(reg, { ...f.r, endpoint: "https://fixture.example.invalid" })],
  ["相对运行目录", (f) => put(reg, { ...f.r, runtimeDir: "relative-fixture-runtime" })],
]) test(`HTTP 卸载：${name}不执行不可信入口，也不阻塞 record/files 清理`, async () => {
  const f = fixture();
  alter(f);
  assert.equal((await post("remove")).ok, true);
  assert.deepEqual(f.calls(), [], "不可信注册绝不能执行 uninstall");
  removed(f);
});

for (const [name, alter, files] of [
  ["缺失", () => fs.rmSync(record), false],
  ["坏 JSON", () => fs.writeFileSync(record, "{bad-record"), false],
  ["null", () => put(record, null), false],
  ["空对象", () => put(record, {}), false],
  ["错误 id", (f) => put(record, { ...f.rec, id: "other-component" }), false],
  ["files 非数组", (f) => put(record, { ...f.rec, files: "lib/openai-bridge/component.cjs" }), false],
  ["files 含路径逃逸", (f) => put(record, { ...f.rec, files: [...f.rec.files, "../unrelated-fixture"] }), false],
  ["files 含非字符串", (f) => put(record, { ...f.rec, files: [...f.rec.files, null] }), false],
  ["未就绪 installing", (f) => put(record, { ...f.rec, state: "installing" }), true],
  ["非 ok damaged", (f) => put(record, { ...f.rec, state: "damaged" }), true],
]) test(`HTTP 卸载：安装记录${name}时跳过执行、清固定注册及可用清单`, async () => {
  const f = fixture();
  alter(f);
  assert.equal((await post("remove")).ok, true);
  assert.deepEqual(f.calls(), []);
  removed(f, { files });
});

test("HTTP 卸载：注册软链只删固定链接，不执行或删除目标", async () => {
  const f = fixture(), target = path.join(f.dir, "registration-target.json");
  fs.renameSync(reg, target); fs.symlinkSync(target, reg);
  assert.equal((await post("remove")).ok, true);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), f.r);
  removed(f);
});

test("HTTP 卸载：安装记录软链不借目标执行/删文件，但清自己的元数据", async () => {
  const f = fixture(), target = path.join(f.dir, "record-target.json");
  fs.renameSync(record, target); fs.symlinkSync(target, record);
  assert.equal((await post("remove")).ok, true);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), f.rec);
  removed(f, { files: false });
});

test("HTTP 卸载：固定组件入口被替换为软链时不执行私有副本", async () => {
  const f = fixture(), target = path.join(f.dir, "private-copy.cjs");
  fs.renameSync(component, target); fs.symlinkSync(target, component);
  assert.equal((await post("remove")).ok, true);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(target), true);
  removed(f);
});

test("HTTP 正常卸载：只调用固定 uninstall --yes，不 purge 私有数据且只清自己的 stage", async () => {
  const f = fixture();
  const mine = path.join(stage, "openai-bridge-012345abcdef.tar.gz.part");
  const other = path.join(stage, "other-component-012345abcdef.tar.gz.part");
  fs.mkdirSync(stage, { recursive: true }); fs.writeFileSync(mine, "mine"); fs.writeFileSync(other, "other");
  try {
    const result = await post("remove");
    assert.equal(result.ok, true);
    assert.deepEqual(f.calls(), [["uninstall", "--dir", f.dir, "--endpoint", f.r.endpoint, "--instance", f.r.instanceId, "--yes"]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "env-present.json"), "utf8")), { api: false, token: false });
    assert.equal(fs.existsSync(mine), false);
    assert.equal(fs.readFileSync(other, "utf8"), "other");
    removed(f);
  } finally { for (const p of [mine, other]) fs.rmSync(p, { force: true }); }
});

test("HTTP uninstall 成功但留下注册：清固定残留，不错误保包", async () => {
  const f = fixture("leave-reg");
  assert.equal((await post("remove")).ok, true);
  assert.equal(f.calls().length, 1);
  removed(f);
});

test("HTTP 合法注册 uninstall 失败：保包、专用错误及 stage，修复后可重试", async () => {
  const f = fixture("fail");
  const result = await post("remove");
  assert.equal(result.ok, false);
  assert.match(result.message, /卸载|停用/);
  assert.doesNotMatch(result.message, /已停止本轮请求/);
  assert.equal(result.stage, "retire-exit");
  assert.equal(fs.readFileSync(component, "utf8"), fixtureSource);
  assert.equal(fs.readFileSync(payload, "utf8"), "fixture package payload");
  assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), f.rec);
  assert.deepEqual(JSON.parse(fs.readFileSync(reg, "utf8")), f.r);
  preserved(f);
  fs.writeFileSync(path.join(f.dir, "mode"), "ok");
  assert.equal((await post("remove")).ok, true);
  assert.equal(f.calls().length, 2);
  removed(f);
});

test("HTTP removing 明确不可取消；取消后仍占槽，第二次卸载/重装均 busy", async () => {
  const f = fixture("gate");
  const removal = post("remove");
  let result;
  try {
    await until(() => f.calls().length === 1, "假 uninstall 没进入 removing");
    const cancelled = await post("cancel");
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.message, /卸载/);
    assert.match(cancelled.message, /不能取消|不可取消|不能中断/);
    assert.deepEqual(await post("remove"), { ok: false, message: "busy" });
    assert.deepEqual(await post("install"), { ok: false, message: "busy" });
    assert.equal(fs.existsSync(record), true);
    assert.equal(fs.existsSync(component), true);
  } finally {
    fs.writeFileSync(path.join(f.dir, "release"), "finish fixture uninstall");
    result = await removal;
  }
  assert.equal(result.ok, true);
  assert.equal(f.calls().length, 1);
  removed(f);
});

test("卸载错误实际记录 stage 日志，但不需要开启 LIVE 或读取真实配置", async () => {
  const logs = [], captureKey = "managed-removal-test-logs";
  globalThis[captureKey] = logs;
  const config = new URL("../gw/config.mjs", import.meta.url);
  const fakeConfig = "data:text/javascript;base64," + Buffer.from(`export * from ${JSON.stringify(config.href)}; export const log=(...args)=>globalThis[${JSON.stringify(captureKey)}].push(args.join(' '));`).toString("base64");
  const sourceUrl = new URL("../gw/components.mjs", import.meta.url);
  // 除 log 外仍运行原 routeComponents；所有路径来自测试隔离配置，绝不改实现文件。
  const source = fs.readFileSync(sourceUrl, "utf8").replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, quote, specifier) => `from ${JSON.stringify(specifier === "./config.mjs" ? fakeConfig : new URL(specifier, sourceUrl).href)}`);
  const instrumented = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const f = fixture("fail");
  handler = instrumented.routeComponents;
  try {
    const result = await post("remove");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "retire-exit");
    assert.ok(logs.some((line) => /openai-bridge/.test(line) && /卸载失败/.test(line) && /stage=retire-exit/.test(line)), "卸载失败必须真正输出可定位阶段的日志");
    for (const sensitive of [f.dir, f.r.instanceId, "fixture uninstall rejected", "fixture-only-do-not-forward"]) {
      assert.equal(logs.some((line) => line.includes(sensitive)), false, "日志不得转储注册信息或组件 stderr");
      assert.equal(JSON.stringify(result).includes(sensitive), false, "HTTP 错误不得带注册信息或组件 stderr");
    }
  } finally { handler = routeComponents; delete globalThis[captureKey]; }
  fs.writeFileSync(path.join(f.dir, "mode"), "ok");
  assert.equal((await post("remove")).ok, true);
  removed(f);
});
