// ── 工作岛（可选集成）──────────────────────────────────────────────────────
// 检测到「工作岛」应用（com.dafeiyu.workisland）已安装时，拉起 driver：
// driver 订阅 /api/events，把 Claude 的工作状态送到 ColorOS 16 的流体云 / 灵动岛。
//
// 设计约束：
//  · 网关只用 Node 内置模块；不新增 npm 依赖、不加构建步骤。
//  · 应用没装就完全不启动，不占进程、不写日志噪音。
//  · driver 挂在网关进程树里，比单轮 claude 活得久；网关每 30 秒看一次它还活着没有。
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, log } from "./config.mjs";

const PKG = process.env.WORK_ISLAND_PKG || "com.dafeiyu.workisland";
const DRIVER = fileURLToPath(new URL("./work-island-driver.mjs", import.meta.url));
const PIDFILE = path.join(CFG.home, ".work-island.pid");

let started = false;

function appInstalled() {
  if (process.env.CCAPP_WORK_ISLAND === "1") return true;
  if (process.env.CCAPP_WORK_ISLAND === "0") return false;
  try {
    const out = execFileSync("pm", ["list", "packages", PKG], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.includes("package:" + PKG);
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("work-island-driver.mjs");
  } catch {
    return false;
  }
}

function spawnDriver() {
  let old = 0;
  try {
    old = parseInt(fs.readFileSync(PIDFILE, "utf8").trim(), 10);
  } catch {}
  if (old && alive(old)) return;               // 已在跑，不重复拉
  try {
    const env = { ...process.env, WORK_ISLAND_PKG: PKG };
    delete env.CCAPP_RUN;                      // 别被网关自己的孤儿清理误杀
    const child = spawn(process.execPath, [DRIVER], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      env,
    });
    child.unref();
    log(`[work-island] driver 已启动 pid=${child.pid}`);
  } catch (e) {
    log(`[work-island] driver 启动失败：${e.message}`);
  }
}

export function startWorkIsland() {
  if (started) return;
  started = true;
  if (!appInstalled()) {
    log("[work-island] 未安装工作岛应用，跳过（可选集成）");
    return;
  }
  spawnDriver();
  setInterval(spawnDriver, 30000).unref?.();   // 挂了 30 秒内自己回来
}
