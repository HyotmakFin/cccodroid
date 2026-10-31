// 输入栏模型选单列哪几家（10-31 群友）：没登录的官方账户不算能用、用户可以把某家藏起来
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { noteLoggedIn, providerList } from "../gw/models.mjs";

const login = () => providerList().find((p) => p.login && p.keyMode !== "key");

test("官方账户：没问过时看凭据文件，问过以后按 auth status", () => {
  const cred = path.join(CFG.home, ".claude", ".credentials.json");
  const had = fs.existsSync(cred);
  if (!login()) return;     // 配置里没有官方账户这一家就不测
  try {
    noteLoggedIn(null);
    assert.equal(login().usable, had);
    noteLoggedIn(true);
    assert.equal(login().usable, true);
    noteLoggedIn(false);
    assert.equal(login().usable, false);
  } finally { noteLoggedIn(null); }
});

test("藏起来的接口带 hidden，配置照留", () => {
  const before = SETTINGS.hiddenProviders;
  try {
    const all = providerList();
    SETTINGS.hiddenProviders = [all[0].id];
    const after = providerList();
    assert.equal(after.length, all.length);
    assert.equal(after[0].hidden, true);
    assert.ok(after.slice(1).every((p) => !p.hidden));
  } finally { SETTINGS.hiddenProviders = before; }
});
