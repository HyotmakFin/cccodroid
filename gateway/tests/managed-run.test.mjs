import { PATHS } from "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "managed-run-"));
const reg = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const marker = path.join(root, "ensure-called");
fs.mkdirSync(path.dirname(component), { recursive: true });
fs.mkdirSync(path.dirname(reg), { recursive: true });
fs.mkdirSync(path.dirname(record), { recursive: true });
fs.writeFileSync(component, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'called'); setTimeout(()=>{process.exitCode=1;},150);`);
const endpoint = "http://127.0.0.1:34592";
fs.writeFileSync(reg, JSON.stringify({ schema: 1, id: "openai-bridge", endpoint, runtimeDir: root, instanceId: crypto.randomBytes(16).toString("hex") }));
fs.writeFileSync(record, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
// 只使用自身临时配置；KEY 检查需要非空假值，不导入活 App 的 providers。
fs.writeFileSync(path.join(home, "ccapp-providers.json"), JSON.stringify({ active: "custom-managed-test", providers: { "custom-managed-test": { label: "Fake bridge", baseUrl: endpoint, apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] } } }));
PATHS.claude = process.execPath;
const { startRun } = await import("../gw/run.mjs");
const { abortRun } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
after(() => {
  off();
  for (const p of [reg, record, component, path.join(home, "ccapp-providers.json")]) fs.rmSync(p, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("真实 startRun 的桥失败在 CLI/请求之前清晰结束，不靠 502 重试", async () => {
  await startRun({ id: "managed-failure", message: "fixture message", cwd: root });
  assert.equal(fs.existsSync(marker), true);
  assert.equal(RUNS.has("managed-failure"), false);
  const mine = events.filter((e) => e.runId === "managed-failure");
  assert.equal(mine.filter((e) => e.type === "error").length, 1);
  assert.match(mine.find((e) => e.type === "error").message, /本地 OpenAI 桥未就绪/);
  assert.equal(mine.find((e) => e.type === "run_end").failed, true);
  assert.equal(mine.some((e) => e.type === "init"), false);
});

test("真实 abortRun 能停止 readiness 等待并清槽，不杀共享服务", async () => {
  const r = JSON.parse(fs.readFileSync(reg, "utf8"));
  r.instanceId = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(reg, JSON.stringify(r));
  const work = startRun({ id: "managed-cancel", message: "fixture message", cwd: root });
  const run = RUNS.get("managed-cancel");
  assert(run && run.child === null);
  assert.equal(abortRun(run), true);
  await work;
  assert.equal(RUNS.has("managed-cancel"), false);
  const mine = events.filter((e) => e.runId === "managed-cancel");
  assert.equal(mine.some((e) => e.type === "error"), false);
  assert.equal(mine.find((e) => e.type === "run_end").aborted, true);
  // 启动操作独立于本轮取消，等它自然结束再清测试入口。
  await new Promise((r) => setTimeout(r, 500));
});
