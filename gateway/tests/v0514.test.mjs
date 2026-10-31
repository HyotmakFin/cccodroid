// v0.5.14 之后：#57 内嵌清单与容量透传、独立审查（低-2 组件预检、低-3 设置长度、低-4 原型链）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedModels, inlineModels } from "../gw/models.mjs";
import { claudeEnv, currentModelInfo } from "../gw/claude.mjs";

const data = (o) => "data:application/json," + encodeURIComponent(JSON.stringify(o));
const P = (o) => ({ id: "custom-v0514", custom: true, explicit: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", ...o });

test("内嵌清单本地解析：不发请求，冷缓存就拿得到窗口（#57）", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no network in test"); };
  try {
    const p = P({ modelsUrl: data({ data: [{ id: "big", context_window: 1048576 }, { id: "small", context_window: 131072 }] }) });
    assert.equal(currentModelInfo("big", p).context_window, 1048576);
    assert.equal(claudeEnv({ model: "big", provider: p }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
    assert.equal(cachedModels(p).length, 2);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = real; }
});

test("清单里没有的型号不借第一项的窗口（#57）", () => {
  const p = P({ id: "custom-v0514b", modelsUrl: data({ data: [{ id: "big", context_window: 1048576 }] }) });
  assert.deepEqual(currentModelInfo("other", p), {});
  assert.equal(claudeEnv({ model: "other", provider: p }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test("内嵌清单：base64、非 JSON、过大、坏数据", () => {
  const j = JSON.stringify({ data: [{ id: "a", context_window: 1000 }] });
  assert.equal(inlineModels("data:application/json;base64," + Buffer.from(j).toString("base64"))[0].context_window, 1000);
  assert.equal(inlineModels("data:text/html,<script>"), null);
  assert.equal(inlineModels("data:application/json,{bad"), null);
  assert.equal(inlineModels("data:application/json," + "x".repeat(600 << 10)), null);
  assert.equal(inlineModels("https://example.com/models"), null);
  assert.equal(inlineModels(data({ data: [{ id: "x".repeat(5000) }] }))[0].id.length, 200);
});

test("厂商 id 不从原型链上认（低-4）", async () => {
  const { providerById } = await import("../gw/providers.mjs");
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(providerById(id), null, id);
});
