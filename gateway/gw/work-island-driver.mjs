// ── 工作岛 driver（可选集成）────────────────────────────────────────────────
// 订阅本网关的 /api/events，把 Claude 每一轮的真实状态经 am 送给「工作岛」应用。
// 进程由同目录的 work-island.mjs 拉起，挂在网关进程树里，不受单轮 claude 收尾影响。
//
// 为什么定时器放在这里：ColorOS 会在后台冻结应用（连前台服务也冻，见 do_freezer_trap），
// 工作岛自己没法可靠地跑 8 秒定时器；网关是用户正在用的宿主，不会被冻。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { CFG } from "./config.mjs";
import { TOKEN } from "./access.mjs";

const PORT = CFG.port;
const PKG = process.env.WORK_ISLAND_PKG || "com.dafeiyu.workisland";
const SVC = PKG + "/.IslandService";
const PIDFILE = path.join(CFG.home, ".work-island.pid");
const A = {
  start: PKG + ".START",
  update: PKG + ".UPDATE",
  done: PKG + ".DONE",
  idle: PKG + ".IDLE",
};

const TOOL_CN = {
  Bash: "执行命令", Read: "读文件", Write: "写文件", Edit: "改文件",
  Glob: "找文件", Grep: "搜代码", WebSearch: "查资料", WebFetch: "读网页",
  Task: "子任务", TodoWrite: "整理清单", NotebookEdit: "改笔记",
  Agent: "子任务", Skill: "调用技能", KillShell: "收尾命令",
};

let active = null;          // { id, startedAt, last }
let doneTimer = null;
let idleTimer = null;
let verifying = false;
let warned = false;

const log = (...a) => console.log(new Date().toISOString(), "[work-island]", ...a);

if (!fs.existsSync("/system/bin/am")) {
  log("没有 am（非 Android），不启动");
  process.exit(0);
}
try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch {}

function send(action, title, text, since) {
  const args = ["start-foreground-service", "--user", "0", "-n", SVC, "-a", action];
  if (title) args.push("--es", "title", title);
  if (text) args.push("--es", "text", text);
  if (since) args.push("--el", "since", String(since));
  const attempt = (n) => execFile("am", args, { timeout: 8000 }, (e, out, err) => {
    if (!e) return;
    if (n < 2) return setTimeout(() => attempt(n + 1), 800);
    if (!warned) {
      warned = true;
      log("am 失败（工作岛没装？后面不再重复）：", e.message, String(err || "").slice(0, 120));
    }
  });
  attempt(0);
}

function start(run, text) {
  if (active) {
    if (run && run.id) active.id = run.id;
    return update(text);
  }
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  verifying = false;
  active = { id: (run && run.id) || "", startedAt: Number(run && run.startedAt) || Date.now(), last: "" };
  log("开始", active.id || "?", active.startedAt);
  update(text || "正在处理…", "正在干活");
}

function update(text, title) {
  if (!active) return;
  const t = title || "正在干活";
  const key = t + "|" + text;
  if (key === active.last) return;
  active.last = key;
  send(A.update, t, text, active.startedAt);
}

function finish(reason) {
  if (!active) return;
  const ms = Math.max(0, Date.now() - active.startedAt);
  active = null;
  verifying = false;
  const sec = Math.round(ms / 1000);
  const human = sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  // 连续两轮之间的空隙不急着报完成：等 3 秒，真有新的一轮就直接接着干。
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    doneTimer = null;
    if (active) return;
    log("完成", human, reason || "");
    send(A.done, "", "", 0);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!active) { log("收起"); send(A.idle, "", "", 0); }
    }, 8000);
  }, 3000);
}

/** 收到疑似收尾的信号后，回 /api/state 再确认一次：runs 真空了才算完。 */
function verifyEnd(reason) {
  if (!active || verifying) return;
  verifying = true;
  setTimeout(async () => {
    try {
      const st = await getState();
      const runs = st ? (st.runs || (st.run ? [st.run] : [])) : [];
      if (!st || runs.length === 0) {
        finish(reason || "");
      } else if (active && !active.id && runs[0] && runs[0].id) {
        active.id = runs[0].id;
      }
    } finally {
      verifying = false;
    }
  }, 2500);
}

function handleEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case "hello":
      if (ev.run) start(ev.run, "正在处理…");
      else if (ev.runs && ev.runs.length === 0) verifyEnd("");
      break;
    case "state":
      if (ev.run) start(ev.run, "正在处理…");
      else if (ev.runs && ev.runs.length === 0) verifyEnd("");
      break;
    case "run_start":
      start(ev, "正在处理…");
      break;
    case "run_busy":
      update("继续处理…");
      break;
    case "phase":
      if (ev.phase === "wait") update("等模型回复…");
      else if (ev.phase === "think") update("正在想…");
      else if (ev.phase === "text") update("正在写回复…");
      else if (ev.phase === "tool") update("用 " + (TOOL_CN[ev.name] || ev.name || "工具") + "…");
      else if (ev.phase === "retry") update("重试中…");
      break;
    case "tool_use":
      update("用 " + (TOOL_CN[ev.name] || ev.name || "工具") + "…");
      break;
    case "perm_request":
      update("需要你确认：" + (ev.tool || ev.name || "操作"), "等你确认");
      break;
    case "perm_resolved":
      update("继续…", "正在干活");
      break;
    case "compacting":
      update("整理上下文…");
      break;
    case "sub_progress":
      update("子任务：" + (ev.desc || "进行中") + "…");
      break;
    case "run_idle":
      if (ev.bg > 0) update("后台任务还在跑…");
      break;
    case "error":
      update("出错了：" + String(ev.message || "").slice(0, 60));
      break;
    case "run_end":
      // 不按 runId 直接排除：换轮时 active.id 可能还是上一轮的。
      // 统一回 /api/state 看 runs —— 只要还有一轮在跑，就不算完。
      if (!active) break;
      verifyEnd(ev.aborted ? "已中止" : "");
      break;
  }
}

function connect() {
  const req = http.get({
    host: "127.0.0.1", port: PORT, path: "/api/events",
    headers: { "X-CC-Token": TOKEN, Accept: "text/event-stream" },
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return setTimeout(connect, 3000);
    }
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try { handleEvent(JSON.parse(raw)); } catch {}
        }
      }
      if (buf.length > 2_000_000) buf = "";
    });
    res.on("end", () => setTimeout(connect, 2000));
    res.on("error", () => setTimeout(connect, 2000));
  });
  req.on("error", () => setTimeout(connect, 3000));
  req.setTimeout(0);
}

function getState() {
  return new Promise((resolve) => {
    const req = http.get({
      host: "127.0.0.1", port: PORT, path: "/api/state",
      headers: { "X-CC-Token": TOKEN },
    }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { s += d; });
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

async function poll() {
  const st = await getState();
  if (!st) return;
  const runs = st.runs || (st.run ? [st.run] : []);
  if (runs.length) {
    if (!active) start(st.run || runs[0], "正在处理…");
    else if (!active.id) active.id = (st.run || runs[0]).id || "";
  } else if (active) {
    verifyEnd("");
  }
}

function shutdown() {
  try {
    execFileSync("am", ["start-foreground-service", "--user", "0", "-n", SVC,
      "-a", A.idle], { timeout: 3000 });
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);

log("启动，端口", PORT, "应用", PKG);
connect();
setInterval(poll, 5000);
poll();
