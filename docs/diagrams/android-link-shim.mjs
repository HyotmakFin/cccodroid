// archify 在安卓应用私有目录里跑的兼容层（node --import 本文件 bin/archify.mjs …）
//  1. SELinux 不许普通应用建硬链接（link → EACCES）。archify 的原子发布靠硬链接，并核对 inode 与链接数。
//     这里用「排他复制 + 登记」模拟：同一组路径 stat 出来是同一个 ino、链接数 = 组里还存在的路径数。
//     archify 发布的文件发布后不再改写，所以内容不同步无碍。
//  2. 这个内核没有真的创建时间，node 拿 ctime 顶 birthtime；目录里一建文件 ctime 就变，
//     archify 以为临时目录被调包。birthtime 等于 ctime 时视为「不可用」，统一报 0。
import fs from "node:fs";
import path from "node:path";

const groups = new Map();            // 绝对路径 → { members: Set, ino, dev }（ino/dev 取建组时源文件的真值，组内统一报它）
const abs = (p) => path.resolve(String(p));
// 组员 = 路径 → 它自己的真 ino；路径被删、或被别的文件顶替（ino 变了）就不算数
const live = (g) => [...g.members].filter(([p, ino]) => { try { return realLstat(p, { bigint: true }).ino === ino; } catch { return false; } });

const realLink = fs.linkSync, realLstat = fs.lstatSync, realStat = fs.statSync, realFstat = fs.fstatSync;
const realUnlink = fs.unlinkSync, realRename = fs.renameSync, realOpen = fs.openSync, realClose = fs.closeSync;
const fdPath = new Map();
const T = process.env.ARCHIFY_SHIM_TRACE ? (...a) => fs.appendFileSync(process.env.ARCHIFY_SHIM_TRACE, process.pid + " " + a.join(" ") + "\n") : () => {};

function fix(st, p) {
  if (!st) return st;
  const big = typeof st.ino === "bigint";
  if (big ? st.birthtimeNs === st.ctimeNs : st.birthtimeMs === st.ctimeMs) {
    if (big) { st.birthtimeNs = 0n; st.birthtimeMs = 0n; } else st.birthtimeMs = 0;
    st.birthtime = new Date(0);
  }
  const g = p && groups.get(abs(p));
  if (g && st.isFile() && live(g).some(([m]) => m === abs(p))) {
    const n = live(g).length;
    st.ino = big ? g.ino : Number(g.ino); st.dev = big ? g.dev : Number(g.dev);
    st.nlink = big ? BigInt(n) : n;
  }
  return st;
}

fs.linkSync = function (src, dst) {
  T("link", String(src), "->", String(dst));
  try { return realLink.call(fs, src, dst); }
  catch (e) {
    if (e.code !== "EACCES" && e.code !== "EPERM") throw e;
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    const a = abs(src), b = abs(dst);
    let g = groups.get(a);
    const r = realLstat(a, { bigint: true });
    if (!g || !live(g).some(([m]) => m === a)) { g = { members: new Map([[a, r.ino]]), ino: r.ino, dev: r.dev }; groups.set(a, g); }
    g.members.set(b, realLstat(b, { bigint: true }).ino); groups.set(b, g);
  }
};
fs.lstatSync = function (p, o) { const st = realLstat.call(fs, p, o); return fix(st, p); };
fs.statSync = function (p, o) { const st = realStat.call(fs, p, o); return fix(st, p); };
fs.openSync = function (p, ...a) { const fd = realOpen.call(fs, p, ...a); fdPath.set(fd, abs(p)); return fd; };
fs.closeSync = function (fd) { fdPath.delete(fd); return realClose.call(fs, fd); };
fs.fstatSync = function (fd, o) { const st = realFstat.call(fs, fd, o); return fix(st, fdPath.get(fd)); };
fs.unlinkSync = function (p) {
  T("unlink", String(p));
  realUnlink.call(fs, p);
  const a = abs(p), g = groups.get(a);
  if (g) {
    g.members.delete(a); groups.delete(a);
    // 真硬链接下，删掉一个名字后已打开的描述符仍指向同一个 inode：把它们改记到组里还活着的名字上
    const alive = live(g)[0];
    if (alive) for (const [fd, p] of fdPath) if (p === a) fdPath.set(fd, alive[0]);
  }
};
fs.renameSync = function (from, to) {
  T("rename", String(from), "->", String(to));
  realRename.call(fs, from, to);
  const a = abs(from), b = abs(to), g = groups.get(a);
  if (g) { const ino = g.members.get(a); g.members.delete(a); groups.delete(a); g.members.set(b, ino); groups.set(b, g); }
  else groups.delete(b);
  for (const [fd, p] of fdPath) if (p === a) fdPath.set(fd, b);     // 已打开的描述符跟着文件走
};
// ESM 的 `import * as fs` / 具名导入要靠这一下才看得见上面的替换
(await import("node:module")).syncBuiltinESMExports();
