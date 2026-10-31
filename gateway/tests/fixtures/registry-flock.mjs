// Controlled CLI-contract fixture, not a kernel flock implementation. Never invokes host flock.
// Only scripts/test.mjs's fresh temporary PREFIX may receive this executable.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

function locations(prefix, home, temporary) {
  assert.ok(temporary && path.basename(temporary).startsWith("cccodroid-test-"), "registry-flock fixture requires scripts/test.mjs temporary root");
  assert.equal(prefix, path.join(temporary, "usr")); assert.equal(home, path.join(temporary, "home"));
  assert.equal(fs.realpathSync(prefix), prefix); assert.equal(fs.realpathSync(home), home);
  const tool = path.join(prefix, "bin/flock");
  return { tool, controlFile: tool + ".fixture.json", callsFile: tool + ".fixture.calls" };
}

export function registryFlockFixture(prefix = process.env.CCAPP_PREFIX, home = process.env.CCAPP_HOME, temporary = process.env.CCAPP_TMP) {
  const files = locations(prefix, home, temporary);
  return {
    ...files,
    setMode(mode = "ok") {
      assert.ok(["ok", "busy", "missing-after-first-lock"].includes(mode));
      fs.writeFileSync(files.controlFile, JSON.stringify({ mode }), { mode: 0o600 });
    },
    calls() {
      try { return fs.readFileSync(files.callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
    reset(mode = "ok") { fs.rmSync(files.callsFile, { force: true }); this.setMode(mode); },
  };
}

export function guardRegistryFlock(t, fixture, { missing = false } = {}) {
  const realSpawn = childProcess.spawn, realSpawnSync = childProcess.spawnSync, attempts = [];
  const unavailable = (tool, args) => {
    if (path.basename(String(tool)) !== "flock") return false;
    attempts.push({ tool: String(tool), args });
    // Even fallback candidates are never executed from host/system directories.
    return missing || tool !== fixture.tool || !fs.existsSync(fixture.tool);
  };
  const hooks = [t.mock.method(childProcess, "spawnSync", (tool, args, options) => {
    if (unavailable(tool, args)) return { error: Object.assign(new Error("fixture flock missing"), { code: "ENOENT" }), status: null, signal: null };
    return realSpawnSync(tool, args, options);
  }), t.mock.method(childProcess, "spawn", (tool, args, options) => {
    if (unavailable(tool, args)) return realSpawn(fixture.tool + ".does-not-exist", args, options);
    return realSpawn(tool, args, options);
  })];
  syncBuiltinESMExports();
  return { attempts, restore() { for (const hook of hooks) hook.mock.restore(); syncBuiltinESMExports(); } };
}

export function installRegistryFlock(prefix, home, temporary) {
  const fixture = registryFlockFixture(prefix, home, temporary);
  // 用 sh 写：手机上冷启动一个 node 脚本要 200ms 以上，锁的重试节奏测不准；sh 是毫秒级
  const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const source = `#!${sh}
PATH=/system/bin:/usr/bin:/bin:$PATH
t="$0"
mode=$(sed -n 's/.*"mode":"\\([a-z-]*\\)".*/\\1/p' "$t.fixture.json")
[ -n "$mode" ] || exit 66
lock=$(readlink /proc/$$/fd/3 2>/dev/null)
if [ -f /proc/$$/fd/3 ]; then reg=true; else reg=false; fi
a=""; for x in "$@"; do a="$a\${a:+,}\\"$x\\""; done
printf '{"args":[%s],"mode":"%s","lock":"%s","regular":%s}\\n' "$a" "$mode" "$lock" "$reg" >> "$t.fixture.calls"
# 照 toybox 的可移植写法：只认 -n 3，故意拒 util-linux 才有的 -w
{ [ $# -eq 2 ] && [ "$1" = -n ] && [ "$2" = 3 ]; } || exit 64
{ [ "$reg" = true ] && [ "$lock" = "$HOME/.cccodroid/services/openai-bridge.lock" ]; } || exit 65
[ "$mode" = busy ] && exit 1
[ "$mode" = missing-after-first-lock ] && rm -f "$t"
exit 0
`;
  fs.writeFileSync(fixture.tool, source, { mode: 0o700 }); fs.chmodSync(fixture.tool, 0o700);
  fixture.reset();
  return fixture;
}
