// 会话导入（gw/sessionops.mjs）：不是 zip 的文件快速拒绝，不从尾逐字节扫到头
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipRead } from "../gw/sessionops.mjs";

test("64MB 非 zip：很快报「不是 zip 文件」", () => {
  const t0 = Date.now();
  assert.throws(() => zipRead(Buffer.alloc(64 << 20)), /zip/);
  assert.ok(Date.now() - t0 < 100, `${Date.now() - t0}ms`);
});
