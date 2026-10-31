import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureManagedBridge, retireManagedBridge } from "../gw/managed-bridge.mjs";

const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "managed-"));
const reg = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const put = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), { mode: 0o600 }); };
fs.mkdirSync(path.dirname(component), { recursive: true });
fs.writeFileSync(component, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1],endpoint=args[args.indexOf('--endpoint')+1],instanceId=args[args.indexOf('--instance')+1];
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify({command:args[0],apiInEnv:!!process.env.ANTHROPIC_API_KEY,ccappRun:!!process.env.CCAPP_RUN})+'\\n');
const mode=fs.readFileSync(path.join(dir,'mode'),'utf8');
setTimeout(()=>{if(mode==='fail')process.exitCode=1;else if(args[0]==='uninstall')fs.unlinkSync(path.join(process.env.HOME,'.cccodroid/services/openai-bridge.json'));else console.log(JSON.stringify({schema:1,id:'openai-bridge',ready:true,endpoint,instanceId:mode==='wrong'?'wrong':instanceId}));},150);
`);

function fixture(mode = "ok") {
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.writeFileSync(path.join(dir, "mode"), mode);
  const r = { schema: 1, id: "openai-bridge", endpoint: "http://127.0.0.1:34591", runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") };
  put(reg, r);
  put(record, { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", ...Array.from({ length: 1000 }, (_, i) => "lib/openai-bridge/node_modules/fixture/" + i)] });
  return { r, dir, p: { custom: true, baseUrl: r.endpoint }, calls: () => { try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } } };
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const p of [reg, record, component]) fs.rmSync(p, { force: true });
});

test("冷态在包装前调用固定组件 ensure，等待 ready；支持大安装记录", async () => {
  const f = fixture();
  let done = false;
  const result = ensureManagedBridge(f.p).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false);
  assert.equal(await result, true);
  assert.deepEqual(f.calls(), [{ command: "ensure", apiInEnv: false, ccappRun: false }]);
});

test("并发会话共用同一次就绪，不启动多套组件", async () => {
  const f = fixture();
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => ensureManagedBridge(f.p))), Array(12).fill(true));
  assert.equal(f.calls().length, 1);
});

test("远端、其他回环、错误边界、登录及端侧均不启动", async () => {
  const f = fixture();
  for (const baseUrl of ["https://other.example.invalid", "http://127.0.0.1:34592", f.r.endpoint + ".invalid", f.r.endpoint + "/v1", f.r.endpoint + "?token=fake", "http://fixture@127.0.0.1:34591", "http://127.1:34591"]) {
    assert.equal(await ensureManagedBridge({ custom: true, baseUrl }), false);
  }
  for (const flags of [{ login: true }, { local: true }, { custom: false }]) assert.equal(await ensureManagedBridge({ ...f.p, ...flags }), false);
  assert.equal(f.calls().length, 0);
});

test("缺少注册不接管其他本机服务；注册不允许指定命令", async () => {
  const f = fixture();
  fs.rmSync(reg);
  assert.equal(await ensureManagedBridge(f.p), false);
  put(reg, null);
  assert.equal(await ensureManagedBridge(f.p), false);
  fs.writeFileSync(reg, "{bad-json");
  assert.equal(await ensureManagedBridge({ custom: true, baseUrl: "http://127.0.0.1:34592" }), false);
  put(reg, { ...f.r, command: "do-not-execute" });
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 0);
});

test("卸载或安装损坏后拒绝启动，不执行私有副本", async () => {
  const f = fixture();
  fs.rmSync(record);
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  put(record, { id: "openai-bridge", state: "installing", files: ["lib/openai-bridge/component.cjs"] });
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 0);
});

test("注册符号链接和被替换的固定入口不会执行其他脚本", async () => {
  const f = fixture();
  const dest = path.join(f.dir, "copied-registration");
  fs.renameSync(reg, dest);
  fs.symlinkSync(dest, reg);
  assert.equal(await ensureManagedBridge(f.p), false);
  fs.unlinkSync(reg); put(reg, f.r);
  const moved = path.join(f.dir, "moved-component.cjs");
  fs.renameSync(component, moved);
  fs.symlinkSync(moved, component);
  try { await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/); }
  finally { fs.unlinkSync(component); fs.renameSync(moved, component); }
  assert.equal(f.calls().length, 0);
});

test("失败明确结束且短期重复请求不反复拉起", async () => {
  const f = fixture("fail");
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 1);
});

test("错误实例和就绪期间注册被替换均拒绝", async () => {
  let f = fixture("wrong");
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  f = fixture();
  const work = ensureManagedBridge(f.p);
  fs.rmSync(reg);
  await assert.rejects(work, /本地 OpenAI 桥未就绪/);
  f = fixture();
  const removal = ensureManagedBridge(f.p);
  fs.rmSync(record);
  await assert.rejects(removal, /本地 OpenAI 桥未就绪/);
});

test("恢复会话及重开 App 后仍读取持久注册，不依赖包装地址", async () => {
  const f = fixture();
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(await ensureManagedBridge({ ...f.p, baseUrl: f.p.baseUrl + "/" }), true);
  const fresh = await import("../gw/managed-bridge.mjs?new-gateway");
  assert.equal(await fresh.ensureManagedBridge(f.p), true);
  assert.equal(f.calls().length, 3);
});

test("组件管理器卸载等正在启动的操作结束，停用注册且不允许新启动", async () => {
  const f = fixture();
  const starting = ensureManagedBridge(f.p);
  const removal = retireManagedBridge("openai-bridge");
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(await starting, true);
  assert.equal(await removal, true);
  assert.deepEqual(f.calls().map((c) => c.command), ["ensure", "uninstall"]);
  assert.equal(fs.existsSync(reg), false);
  assert.equal(await ensureManagedBridge(f.p), false);
  assert.equal(await retireManagedBridge("other-component"), false);
});

test("停用失败不移除注册，允许修复后重试", async () => {
  const f = fixture("fail");
  await assert.rejects(retireManagedBridge("openai-bridge"), /本地 OpenAI 桥未就绪/);
  assert.equal(fs.existsSync(reg), true);
  fs.writeFileSync(path.join(f.dir, "mode"), "ok");
  assert.equal(await retireManagedBridge("openai-bridge"), true);
});

test("停止等待只取消本会话，不杀共享启动器或另一会话", async () => {
  const f = fixture(), controller = new AbortController();
  const first = ensureManagedBridge(f.p, { signal: controller.signal });
  const second = ensureManagedBridge(f.p);
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(await second, true);
  assert.equal(f.calls().length, 1);
});
