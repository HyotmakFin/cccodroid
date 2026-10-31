import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CFG, PREFIX, tz } from "./config.mjs";

const ID = "openai-bridge";
const inFlight = new Map(), failures = new Map();
let retiring = null;
const registry = () => path.join(CFG.home, ".cccodroid", "services", ID + ".json");
const fail = () => new Error(tz("本地 OpenAI 桥未就绪，已停止本轮请求。请检查组件配置或运行状态。"));

function readJson(file, max = 4096) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > max) throw fail();
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function endpointOf(value) {
  if (typeof value !== "string") return "";
  const m = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/?$/.exec(value);
  return m && Number(m[1]) >= 1024 && Number(m[1]) <= 65535 ? "http://127.0.0.1:" + m[1] : "";
}

function binding(p) {
  // 在 streamfix 包装之前只认显式注册的本机端点；其他接口和登录令牌不碰。
  if (!PREFIX || !p?.custom || p.login || p.local) return null;
  const endpoint = endpointOf(p.baseUrl);
  if (!endpoint) return null;
  let r;
  try { r = readJson(registry()); }
  catch { return null; }
  if (!r || typeof r !== "object" || Array.isArray(r) || endpointOf(r.endpoint) !== endpoint) return null;
  if (r.schema !== 1 || r.id !== ID || r.endpoint !== endpoint ||
      typeof r.runtimeDir !== "string" || !path.isAbsolute(r.runtimeDir) ||
      path.resolve(r.runtimeDir) !== r.runtimeDir || !/^[0-9a-f]{32}$/.test(r.instanceId || "") ||
      Object.keys(r).some((k) => !["schema", "id", "endpoint", "runtimeDir", "instanceId"].includes(k))) throw fail();
  const component = path.join(PREFIX, "lib", ID, "component.cjs");
  try {
    const rec = readJson(path.join(path.dirname(PREFIX), "components", ID + ".json"), 4 << 20);
    if (rec.id !== ID || rec.state !== "ok" || !Array.isArray(rec.files) || !rec.files.includes("lib/openai-bridge/component.cjs")) throw fail();
    const real = fs.realpathSync(component), root = fs.realpathSync(path.join(PREFIX, "lib", ID));
    const prefixRoot = fs.realpathSync(PREFIX);
    if (root !== path.join(prefixRoot, "lib", ID) || real !== path.join(root, "component.cjs")) throw fail();
  } catch { throw fail(); }
  return { ...r, component };
}

function componentEnv() {
  const env = Object.fromEntries(["LANG", "TZ", "TMPDIR", "ANDROID_ROOT", "ANDROID_DATA", "LD_PRELOAD", "LD_LIBRARY_PATH"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return { ...env, HOME: CFG.home, PREFIX, PATH: [path.join(PREFIX, "bin"), "/system/bin", "/system/xbin"].join(":") };
}

function launch(r) {
  // 注册数据不能指定可执行文件或 shell 片段。只执行已安装组件的固定入口，不转发凭据或模型环境。
  const env = componentEnv();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [r.component, "ensure", "--dir", r.runtimeDir, "--endpoint", r.endpoint, "--instance", r.instanceId],
      { env, timeout: 75000, maxBuffer: 16384, killSignal: "SIGTERM" }, (err, out) => {
        if (err) return reject(fail());
        try {
          const result = JSON.parse(String(out).trim());
          const current = binding({ custom: true, baseUrl: r.endpoint });
          if (result.schema !== 1 || result.id !== ID || result.ready !== true ||
              result.endpoint !== r.endpoint || result.instanceId !== r.instanceId || !current ||
              ["schema", "id", "endpoint", "runtimeDir", "instanceId", "component"].some((k) => current[k] !== r[k])) throw fail();
          resolve(true);
        } catch { reject(fail()); }
      });
  });
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function ensureManagedBridge(p, { signal } = {}) {
  const r = binding(p);
  if (!r) return false;
  if (retiring) throw fail();
  if (signal?.aborted) throw signal.reason || new Error("aborted");
  const key = JSON.stringify(r);
  if ((failures.get(key) || 0) > Date.now()) throw fail();
  if (!inFlight.has(key)) {
    const work = launch(r).catch((e) => {
      if (failures.size >= 32) failures.delete(failures.keys().next().value);
      failures.set(key, Date.now() + 60000);
      throw e;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
  }
  return waitFor(inFlight.get(key), signal);
}

export function retireManagedBridge(id) {
  if (id !== ID || !PREFIX) return Promise.resolve(false);
  if (retiring) return retiring;
  let raw;
  try { raw = readJson(registry()); }
  catch (e) { return e.code === "ENOENT" ? Promise.resolve(false) : Promise.reject(fail()); }
  const r = binding({ custom: true, baseUrl: raw?.endpoint });
  if (!r) return Promise.reject(fail());
  retiring = (async () => {
    await Promise.allSettled([...inFlight.values()]);
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [r.component, "uninstall", "--dir", r.runtimeDir, "--yes"],
        { env: componentEnv(), timeout: 40000, maxBuffer: 16384, killSignal: "SIGTERM" },
        (err) => err ? reject(fail()) : resolve());
    });
    if (fs.existsSync(registry())) throw fail();
    return true;
  })().finally(() => { retiring = null; });
  return retiring;
}
