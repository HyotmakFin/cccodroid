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
  const source = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const tool=__filename,args=process.argv.slice(2),control=JSON.parse(fs.readFileSync(tool+'.fixture.json','utf8'));
let lock='',regular=false;
try{lock=fs.readlinkSync('/proc/self/fd/3');regular=fs.fstatSync(3).isFile();}catch{}
fs.appendFileSync(tool+'.fixture.calls',JSON.stringify({args,mode:control.mode,lock,regular})+'\\n');
// Match toybox's portable nonblocking form; deliberately reject util-linux-only -w.
if(args.length!==2||args[0]!=='-n'||args[1]!=='3'){process.exitCode=64;}
else if(!regular||lock!==path.join(process.env.HOME,'.cccodroid/services/openai-bridge.lock')){process.exitCode=65;}
else if(control.mode==='busy'){process.exitCode=1;}
else if(control.mode==='missing-after-first-lock'){fs.rmSync(tool);}
`;
  fs.writeFileSync(fixture.tool, source, { mode: 0o700 }); fs.chmodSync(fixture.tool, 0o700);
  fixture.reset();
  return fixture;
}
