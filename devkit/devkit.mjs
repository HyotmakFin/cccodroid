// ─────────────────────────────────────────────────────────────────────
//  devkit.mjs —— 从 Termux 官方仓库组装开发工具包（可复现、可溯源）
//
//  做的事：
//    1. 取 Release → 校验 Packages.gz 的 SHA256 → 解析索引
//    2. 按 devkit.json 的分组求依赖闭包（含 Provides 虚包、"a | b" 取第一个能满足的）
//    3. 下载 .deb，逐个核对索引里的 SHA256（缓存命中也核对）
//    4. 解 ar → data.tar.xz → 读 tar，**边读边改写**：
//         路径   ./data/data/com.termux/files/usr/x  →  usr/x
//         内容   /data/data/com.termux/  →  /data/data/<目标包名>/   （等长替换）
//         归档   zip 类（.jmod/.jar/.zip/…）还要下潜到压缩条目内部再改一遍
//                —— 等长替换在 deflate 流里找不到模式，改不到（见 rewriteZip）
//         链接   软链目标同样替换
//       写进一个新 tar —— 应用解到自己的 files/ 下即可原生运行，不需要 LD_LIBRARY_PATH。
//    5. 落 devkit.lock.json（每个包的版本/文件/哈希/配方链接）和 SBOM.tsv
//
//  为什么目标包名必须恰好 10 个字符：Termux 的前缀是编译期写死进二进制的，
//  ELF 里是定长槽。"com.termux" 是 10 个字符，换成同样长的包名就是逐字节等长替换，
//  RUNPATH、shebang、配置路径一次全对，不用打任何补丁。
//
//  用法: node devkit.mjs build --target li.dsh.dkt [--groups core,build] [--out DIR]
//        node devkit.mjs resolve [--groups ...]          只列闭包和体积
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import * as xzNs from "./vendor/xz-decompress/dist/package/xz-decompress.js";
const xz = xzNs.default ?? xzNs;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MAN = JSON.parse(fs.readFileSync(path.join(HERE, "devkit.json"), "utf8"));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };

const TERMUX = "/data/data/com.termux/";
const CACHE = opt("cache", path.join(HERE, "cache"));
const OUT = opt("out", path.join(HERE, "out"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mb = (n) => (n / 1048576).toFixed(1) + "MB";

async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 5) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));   // 网络抖动：退避重试
    }
  }
}

// ── 索引 ─────────────────────────────────────────────────────────────
// 多个仓库：termux-main 优先，其次 termux-glibc（给官方 Claude Code 的 glibc 版二进制提供运行库）
const REPOS = MAN.repos || [MAN.repo];
async function loadIndex() {
  const pkgs = new Map(), provides = new Map(), dates = [];
  for (const repo of REPOS) {
    const one = await loadRepo(repo);
    dates.push(`${repo.name || "main"} ${one.date}`);
    for (const [k, p] of one.pkgs) if (!pkgs.has(k)) pkgs.set(k, p);
    for (const [k, v] of one.provides) if (!provides.has(k)) provides.set(k, v);
  }
  return { pkgs, provides, date: dates.join(" · ") };
}

async function loadRepo(repo) {
  const { base, dist, component, arch } = repo;
  const rel = (await get(`${base}dists/${dist}/Release`)).toString();
  const rp = `${component}/binary-${arch}/Packages.gz`;
  const want = rel.split("SHA256:")[1].split("\n").find((l) => l.trim().endsWith(" " + rp));
  if (!want) throw new Error("Release 里没有 " + rp);
  const gz = await get(`${base}dists/${dist}/${rp}`);
  if (sha256(gz) !== want.trim().split(/\s+/)[0]) throw new Error("Packages.gz 哈希与 Release 不符");
  const date = (rel.match(/^Date: (.+)$/m) || [])[1];

  const pkgs = new Map(), provides = new Map();
  for (const blk of zlib.gunzipSync(gz).toString().split("\n\n")) {
    const f = {};
    for (const l of blk.split("\n")) { const m = l.match(/^([\w-]+): (.*)$/); if (m) f[m[1]] = m[2]; }
    if (!f.Package) continue;
    const p = {
      name: f.Package, version: f.Version, file: f.Filename, sha256: f.SHA256, size: +f.Size,
      isize: +(f["Installed-Size"] || 0) * 1024, source: f.Source || f.Package, homepage: f.Homepage || "",
      deps: [f["Pre-Depends"], f.Depends].filter(Boolean).join(", "),
      repo,
    };
    pkgs.set(p.name, p);
    for (const v of (f.Provides || "").split(",")) {
      const n = v.trim().split(/[\s(]/)[0];
      if (n) { if (!provides.has(n)) provides.set(n, []); provides.get(n).push(p.name); }
    }
  }
  return { pkgs, provides, date };
}

function closure(idx, roots) {
  const out = new Set(), missing = [];
  const pick = (alt) => {
    for (const a of alt.split("|")) {
      const n = a.trim().split(/[\s(]/)[0];
      if (idx.pkgs.has(n)) return n;
      const pv = idx.provides.get(n);
      if (pv) return pv[0];
    }
    return null;
  };
  const walk = (n, from) => {
    if (out.has(n) || (MAN.exclude || []).includes(n)) return;
    const p = idx.pkgs.get(n);
    if (!p) { missing.push(`${n}（${from}）`); return; }
    out.add(n);
    for (const d of p.deps.split(",")) {
      if (!d.trim()) continue;
      const k = pick(d);
      if (k) walk(k, n); else missing.push(`${d.trim()}（${n}）`);
    }
  };
  for (const r of roots) walk(pick(r) || r, "清单");
  return { names: [...out].sort(), missing };
}

function rootsFor(groups) {
  const gs = groups ? groups.split(",") : Object.keys(MAN.groups);
  return gs.flatMap((g) => { if (!MAN.groups[g]) throw new Error("没有这个分组: " + g); return MAN.groups[g]; });
}

async function fetchDeb(p) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, path.basename(p.file).replace(/:/g, "%3a"));   // /sdcard 不收冒号
  if (fs.existsSync(dest)) {
    const b = fs.readFileSync(dest);
    if (sha256(b) === p.sha256) return b;
  }
  // 下载走 curl：node 的 fetch 在这台机器上会间歇性 "fetch failed"。
  // 大包分块并行：单连接常被限速到 ~85KB/s，且 CDN 会静默截断或传坏一段。
  // 整包哈希不对时，换镜像重下每一块，按"两个来源一致"选块 —— 能定位坏块而不是整包重来。
  const mirrors = [p.repo.base, ...(p.repo.mirrors || [])];
  const CH = 4 << 20, n = Math.ceil(p.size / CH);
  const got = Array.from({ length: n }, () => []);          // 每块收集到的各版本
  const curlRange = (m, i) => new Promise((res) => {
    const lo = i * CH, hi = Math.min(p.size, lo + CH) - 1;
    execFile("curl", ["-fsSL", "-r", `${lo}-${hi}`, "--speed-limit", "10000", "--speed-time", "30", "--max-time", "600", mirrors[m % mirrors.length] + p.file],
      { encoding: "buffer", maxBuffer: CH * 2 }, (err, out) => res(!err && out.length === hi - lo + 1 ? out : null));
  });
  const pickAll = () => got.map((vs) => {
    if (vs.length === 1) return vs[0];
    for (let x = 0; x < vs.length; x++) for (let y = x + 1; y < vs.length; y++) if (vs[x].equals(vs[y])) return vs[x];
    return null;
  });
  for (let round = 0; round < 6; round++) {
    // 这一轮要下的块：还没有的；或（非首轮）没有两份一致的
    const need = [];
    for (let i = 0; i < n; i++) if (round === 0 ? !got[i].length : pickAll()[i] === null || got[i].length < 2) need.push(i);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(8, need.length) }, async () => {
      while (k < need.length) {
        const i = need[k++];
        for (let t = 0; t < 4; t++) { const b = await curlRange(round + t + i, i); if (b) { got[i].push(b); break; } }
      }
    }));
    const parts = pickAll();
    if (parts.every(Boolean)) {
      const b = Buffer.concat(parts);
      if (sha256(b) === p.sha256) { fs.writeFileSync(dest, b); return b; }
      if (round === 0) console.log(`\n      整包哈希不符，换镜像逐块复核…`);
    }
  }
  throw new Error(`${p.name}: 多轮下载仍拼不出与索引一致的内容`);
}

// ── 解包 ─────────────────────────────────────────────────────────────
function arMember(buf, prefix) {
  if (buf.subarray(0, 8).toString() !== "!<arch>\n") throw new Error("不是 ar 归档");
  for (let off = 8; off + 60 <= buf.length;) {
    const name = buf.subarray(off, off + 16).toString().trim().replace(/\/$/, "");
    const size = parseInt(buf.subarray(off + 48, off + 58).toString().trim(), 10);
    if (name.startsWith(prefix)) return { name, data: buf.subarray(off + 60, off + 60 + size) };
    off += 60 + size + (size % 2);
  }
  throw new Error("没有 " + prefix + "*");
}

// 原生 xz：从仓库里的 xz-utils + liblzma 自举（JS 解一次），之后大包全用它，快一个数量级。
// 放在本应用私有目录（/sdcard 是 noexec）；靠 LD_LIBRARY_PATH 找 liblzma，所以不依赖前缀改写。
let XZ = null, XZENV = process.env;
const BOOT = process.env.DEVKIT_BOOT || path.join(process.env.HOME || "/data/local/tmp", ".devkit-boot");
async function bootXz(idx) {
  // 普通 Linux（CI）上直接用系统 xz；安卓上没有，才从 Termux 仓库自举
  if (process.platform === "linux" && !fs.existsSync("/system/bin/linker64")) {
    try { execFileSync("xz", ["--version"], { stdio: "pipe" }); XZ = "xz"; return; } catch {}
  }
  const bin = path.join(BOOT, "bin/xz");
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(BOOT, { recursive: true });
    for (const n of ["xz-utils", "liblzma"]) {
      const tar = await jsUnxz(arMember(await fetchDeb(idx.pkgs.get(n)), "data.tar").data);
      for (const e of readTar(tar)) {
        const rel = e.name.replace(/^\.\//, "").replace(TERMUX.slice(1) + "files/usr/", "");
        if (rel === e.name.replace(/^\.\//, "")) continue;
        const dst = path.join(BOOT, rel);
        if (e.type === "5") fs.mkdirSync(dst, { recursive: true });
        else if (e.type === "2") { fs.mkdirSync(path.dirname(dst), { recursive: true }); try { fs.unlinkSync(dst); } catch {} fs.symlinkSync(e.link, dst); }
        else if (e.type === "0") { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, e.data, { mode: e.mode }); }
      }
    }
  }
  try {
    execFileSync(bin, ["--version"], { env: { ...process.env, LD_LIBRARY_PATH: path.join(BOOT, "lib") }, stdio: "pipe" });
    XZ = bin;
    XZENV = { ...process.env, LD_LIBRARY_PATH: path.join(BOOT, "lib") };   // 只给自举的 bionic xz，别漏给系统的
  } catch (e) { console.log("  （原生 xz 起不来，退回 JS 解压：" + e.message.split("\n")[0] + "）"); }
}

async function unxz(data) {
  if (XZ) return execFileSync(XZ, ["-dc"], { input: data, maxBuffer: 2 ** 31, env: XZENV });
  return jsUnxz(data);
}

async function jsUnxz(data) {
  const rd = new xz.XzReadableStream(new Blob([data]).stream()).getReader();
  const parts = [];
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(Buffer.from(value)); }
  return Buffer.concat(parts);
}

async function controlScripts(deb) {
  const m = arMember(deb, "control.tar");
  const tar = m.name.endsWith(".xz") ? await unxz(m.data) : m.name.endsWith(".gz") ? zlib.gunzipSync(m.data) : m.data;
  const out = {};
  for (const e of readTar(tar)) {
    const n = e.name.replace(/^\.\//, "");
    if (["preinst", "postinst"].includes(n)) out[n] = e.data.toString();
  }
  return out;
}

/** 从 postinst 里摘出 update-alternatives 的 --install/--slave（链接、组名、目标、优先级） */
function parseAlternatives(script) {
  const flat = script.replace(/\\\n/g, " ");
  const out = [];
  for (const m of flat.matchAll(/--install\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"\s+(\d+)((?:\s+--slave\s+"[^"]+"\s+"[^"]+"\s+"[^"]+")*)/g)) {
    const links = [[m[1], m[3]]];
    for (const sl of m[5].matchAll(/--slave\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/g)) links.push([sl[1], sl[3]]);
    out.push({ group: m[2], prio: +m[4], links });
  }
  return out;
}

async function dataTar(deb) {
  const m = arMember(deb, "data.tar");
  if (m.name.endsWith(".xz")) return unxz(m.data);
  if (m.name.endsWith(".gz")) return zlib.gunzipSync(m.data);
  if (m.name === "data.tar") return m.data;
  throw new Error("不支持的压缩: " + m.name);
}

/** 流式算哈希（工具包 1.7GB，不整个读进内存） */
function hashFile(file) {
  return new Promise((ok, bad) => {
    const h = crypto.createHash("sha256"); let bytes = 0;
    fs.createReadStream(file, { highWaterMark: 1 << 20 }).on("data", (d) => { h.update(d); bytes += d.length; })
      .on("end", () => ok({ sha256: h.digest("hex"), bytes })).on("error", bad);
  });
}
/** gzip -9 压缩并同时算压缩产物的哈希 */
function gzipFile(src, dst) {
  return new Promise((ok, bad) => {
    const h = crypto.createHash("sha256"); let bytes = 0;
    const gz = zlib.createGzip({ level: 9, memLevel: 9 });
    const out = fs.createWriteStream(dst + ".part");
    gz.on("data", (d) => { h.update(d); bytes += d.length; });
    fs.createReadStream(src, { highWaterMark: 1 << 20 }).on("error", bad).pipe(gz).on("error", bad).pipe(out).on("error", bad)
      .on("finish", () => { fs.renameSync(dst + ".part", dst); ok({ sha256: h.digest("hex"), bytes }); });
  });
}

// ── tar 读 ───────────────────────────────────────────────────────────
function* readTar(buf) {
  const str = (b) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString(); };
  const oct = (b) => parseInt(str(b).trim() || "0", 8);
  let longName = null, longLink = null, pax = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = str(body); continue; }
    if (type === "K") { longLink = str(body); continue; }
    if (type === "x") {
      pax = {};
      for (let s = body.toString(), i = 0; i < s.length;) {
        const sp = s.indexOf(" ", i), len = parseInt(s.slice(i, sp), 10);
        const kv = s.slice(sp + 1, i + len - 1), eq = kv.indexOf("=");
        pax[kv.slice(0, eq)] = kv.slice(eq + 1); i += len;
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h.subarray(345, 500));
    let name = pax.path || longName || (prefix ? prefix + "/" : "") + str(h.subarray(0, 100));
    let link = pax.linkpath || longLink || str(h.subarray(157, 257));
    yield { name, link, type, mode: oct(h.subarray(100, 108)), mtime: oct(h.subarray(136, 148)), data: body };
    longName = longLink = null; pax = {};
  }
}

// ── tar 写（ustar + pax 长名）────────────────────────────────────────
class TarWriter {
  constructor(file) { this.fd = fs.openSync(file, "w"); this.bytes = 0; }
  _w(b) { fs.writeSync(this.fd, b); this.bytes += b.length; }
  _pad(n) { const r = n % 512; if (r) this._w(Buffer.alloc(512 - r)); }
  _hdr(name, type, size, mode, mtime, link = "") {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
    h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.max(0, mtime).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write(link.slice(0, 100), 157);
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  }
  add(e) {
    const kv = [];
    if (Buffer.byteLength(e.name) > 99) kv.push(["path", e.name]);
    if (Buffer.byteLength(e.link || "") > 99) kv.push(["linkpath", e.link]);
    if (kv.length) {
      let s = "";
      for (const [k, v] of kv) {
        const body = ` ${k}=${v}\n`;
        let n = Buffer.byteLength(body) + 1;
        while (String(n).length + Buffer.byteLength(body) !== n) n = String(n).length + Buffer.byteLength(body);
        s += n + body;
      }
      const pb = Buffer.from(s);
      this._w(this._hdr("PaxHeader", "x", pb.length, 0o644, e.mtime)); this._w(pb); this._pad(pb.length);
    }
    const size = e.type === "0" ? e.data.length : 0;
    this._w(this._hdr(e.name, e.type, size, e.mode, e.mtime, e.link || ""));
    if (size) { this._w(e.data); this._pad(size); }
  }
  close() { this._w(Buffer.alloc(1024)); fs.closeSync(this.fd); }
}

// ── 前缀改写 ─────────────────────────────────────────────────────────
// 解包时丢掉的文件：Termux App 专属的脚本（给 com.termux 的组件发广播），在别的应用里只会误导
const DROP = new Set([...(MAN.drop || []), ...Object.keys(MAN.stubs || {})]);

function relocator(target) {
  const to = `/data/data/${target}/`;
  if (to.length !== TERMUX.length) throw new Error(`目标包名须恰好 ${TERMUX.length - 12} 个字符（"${target}" 是 ${target.length} 个）`);
  const A = Buffer.from(TERMUX), B = Buffer.from(to);
  const swap = (buf) => {
    let i = buf.indexOf(A);
    if (i < 0) return [buf, 0];
    const out = Buffer.from(buf); let n = 0;
    for (; i >= 0; i = out.indexOf(A, i + A.length)) { B.copy(out, i); n++; }
    return [out, n];
  };
  const pathOf = (name) => {
    const n = name.replace(/^\.\//, "");
    const pre = TERMUX.slice(1) + "files/";
    return n.startsWith(pre) ? n.slice(pre.length) : null;   // 前缀之外的条目（极少）丢弃
  };
  return { swap, pathOf, to };
}

// ── 压缩归档内部也要改写 ──────────────────────────────────────────────
// 上面的 swap 是等长字节替换，对 flat 文件有效：ELF 的 RUNPATH、未压缩的
// jimage（JDK 的 lib/modules）都是这么改对的。
// 但 zip 类归档（本工具包里就是 JDK 的 jmods/*.jmod）条目是 deflate 压缩的，
// 字节流里找不到那个模式，于是被整个跳过 —— 归档里仍留着 /data/data/com.termux/。
//
// 后果（实测，红魔 9 Pro / Android 14）：jlink 从 jmod 里拷出启动器和本地库，
// 把未改写的 RUNPATH 带进产出，镜像一启动就
//     CANNOT LINK EXECUTABLE: library "libz.so.1" not found
// 而 jlink 自己退出码是 0。68 个 jmod 里 31 个中招，jpackage 直接不可用。
//
// 装回时必须严格保持条目顺序与压缩方式：实测 jlink 会拒绝重排过的 jmod
// （报 "Resources tree, invalid data structure"），所以这里全程按中央目录的顺序重建。
const SIG_LOC = 0x04034b50, SIG_CEN = 0x02014b50, SIG_EOCD = 0x06054b50;
const ZIP_EXT = [".jmod", ".jar", ".zip", ".whl", ".egg", ".aar", ".apk"];
const looksLikeZip = (name) => ZIP_EXT.some((e) => name.toLowerCase().endsWith(e));

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 有的归档（jmod）在 zip 数据前带自定义头，探测 zip 实际起点 */
function zipBase(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOC) return 0;
  for (let o = 4; o <= 8 && o + 4 <= buf.length; o += 4)
    if (buf.readUInt32LE(o) === SIG_LOC) return o;
  return -1;
}

/** 对 zip 类归档做前缀改写：条目名、以及解压后的内容各跑一遍 swap。非 zip / zip64 / 结构异常的原样返回 */
function rewriteZip(buf, swap) {
  const base = zipBase(buf);
  if (base < 0) return [buf, 0];

  let eocd = -1;                                            // 从尾部找 EOCD（注释最长 65535）
  for (let i = buf.length - 22; i >= base && i >= buf.length - 22 - 65535; i--)
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) return [buf, 0];

  const nent = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16) + base;
  if (nent === 0xffff || cdOff === 0xffffffff) return [buf, 0];   // zip64：本工具包用不到

  let hits = 0, pos = base, p = cdOff;
  const locals = [], cens = [];
  for (let i = 0; i < nent; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) return [buf, 0];
    const cen = Buffer.from(buf.subarray(p, p + 46));
    const nlen = cen.readUInt16LE(28), elen = cen.readUInt16LE(30), clen = cen.readUInt16LE(32);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nlen));
    const extra = Buffer.from(buf.subarray(p + 46 + nlen, p + 46 + nlen + elen));
    const comment = Buffer.from(buf.subarray(p + 46 + nlen + elen, p + 46 + nlen + elen + clen));
    const method = cen.readUInt16LE(10), csize = cen.readUInt32LE(20);
    const lo = cen.readUInt32LE(42) + base;
    p += 46 + nlen + elen + clen;

    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) return [buf, 0];
    const lnlen = buf.readUInt16LE(lo + 26), lelen = buf.readUInt16LE(lo + 28);
    const lhOut = Buffer.from(buf.subarray(lo, lo + 30));
    // 本地头有自己的名字与 extra（jar 首条常带 0xCAFE extra），长度未必与中央目录相同，必须原样带上
    const lname = Buffer.from(buf.subarray(lo + 30, lo + 30 + lnlen));
    const lextra = buf.subarray(lo + 30 + lnlen, lo + 30 + lnlen + lelen);

    const [nameOut, kn] = swap(name);                       // 条目名（等长，长度不变）
    const [lnameOut] = swap(lname);
    hits += kn;

    let data = Buffer.from(buf.subarray(lo + 30 + lnlen + lelen, lo + 30 + lnlen + lelen + csize));
    let usize = cen.readUInt32LE(24), crc = cen.readUInt32LE(16);
    if (method === 8) {                                     // deflate：解开 → 改 → 压回
      let raw;
      try { raw = zlib.inflateRawSync(data); } catch { return [buf, 0]; }
      const [dec, k] = swap(raw);
      if (k) {
        hits += k;
        data = zlib.deflateRawSync(dec, { level: 9 });
        usize = dec.length; crc = crc32(dec);
        cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(usize, 24); cen.writeUInt32LE(crc, 16);
      }
    } else if (method === 0) {                              // stored：明文，直接换
      const [d, k] = swap(data);
      if (k) { hits += k; data = d; crc = crc32(d); cen.writeUInt32LE(crc, 16); }
    } else {
      return [buf, 0];                                      // 不认识的压缩方式，别乱动
    }

    // 大小与 CRC 已写进本地头，数据描述符不再搬运 —— 清掉标志位 3，否则流式读取会去找它
    lhOut.writeUInt16LE(lhOut.readUInt16LE(6) & ~8, 6); cen.writeUInt16LE(cen.readUInt16LE(8) & ~8, 8);
    cen.writeUInt32LE(pos - base, 42);                      // 新的本地头偏移（与原档一样相对 zip 起点）
    lhOut.writeUInt32LE(data.length, 18); lhOut.writeUInt32LE(usize, 22); lhOut.writeUInt32LE(crc, 14);
    locals.push(lhOut, lnameOut, lextra, data);
    cens.push(cen, nameOut, extra, comment);
    pos += 30 + lnlen + lelen + data.length;
  }

  // 一处没命中就原档返回：重建会丢掉数据描述符等细节，签名过的 jar / 校验和也就不再逐字节一致
  if (!hits) return [buf, 0];
  const cdBuf = Buffer.concat(cens);
  const eocdOut = Buffer.from(buf.subarray(eocd, eocd + 22));
  eocdOut.writeUInt32LE(cdBuf.length, 12);
  eocdOut.writeUInt32LE(pos - base, 16);
  return [Buffer.concat([buf.subarray(0, base), ...locals, cdBuf, eocdOut, buf.subarray(eocd + 22)]), hits];
}

// ── 主流程 ───────────────────────────────────────────────────────────
const idx = await loadIndex();
const { names, missing } = closure(idx, rootsFor(opt("groups")));
const total = names.reduce((s, n) => s + idx.pkgs.get(n).size, 0);
const itotal = names.reduce((s, n) => s + idx.pkgs.get(n).isize, 0);
console.log(`仓库快照 ${idx.date} · ${idx.pkgs.size} 个包`);
console.log(`闭包 ${names.length} 个包 · 下载 ${mb(total)} · 解包后约 ${mb(itotal)}`);
if (missing.length) console.log("⚠ 无法满足: " + missing.join("; "));

if (cmd === "resolve") {
  for (const n of names) { const p = idx.pkgs.get(n); console.log(`  ${n.padEnd(28)} ${p.version.padEnd(18)} ${mb(p.isize)}`); }
  process.exit(0);
}

if (cmd === "build") {
  const target = opt("target");
  if (!target) throw new Error("--target <10 字符包名> 必填");
  const R = relocator(target);
  await bootXz(idx);
  console.log(XZ ? "  解压：原生 xz" : "  解压：JS");
  fs.mkdirSync(OUT, { recursive: true });
  const tarFile = path.join(OUT, `devkit-${target}.tar`);
  const tw = new TarWriter(tarFile + ".part");
  // 逐文件清单（libexec/devkit/MANIFEST）："sha256 大小 相对 usr/ 的路径"。App 装完拿它核对缺没缺、坏没坏。
  // 同名条目以最后写入的为准（tar 解包也是后来的覆盖前面的）；被软链盖掉的不算文件
  const manifest = new Map();
  const twAdd = tw.add.bind(tw);
  tw.add = (e) => {
    const rel = e.name.startsWith("usr/") ? e.name.slice(4) : null;
    if (rel) {
      if ((e.type === "0" || e.type === "7") && e.data) manifest.set(rel, [sha256(e.data), e.data.length]);
      else if (e.type === "1") { const t = (e.link || "").replace(/^usr\//, ""); if (manifest.has(t)) manifest.set(rel, manifest.get(t)); }
      else manifest.delete(rel.replace(/\/$/, ""));
    }
    return twAdd(e);
  };
  const lock = [], seenDirs = new Set();
  const alts = new Map();          // 组名 → 优先级最高的那组链接
  const firstRun = [];             // 除 alternatives 外仍要在设备上跑的 postinst
  let patchedFiles = 0, patchedHits = 0, t0 = Date.now();

  for (const [i, n] of names.entries()) {
    const p = idx.pkgs.get(n);
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${names.length}] ${n.padEnd(26)} ${p.version.padEnd(16)}`);
    const deb = await fetchDeb(p);
    const tar = await dataTar(deb);
    const sc = await controlScripts(deb);
    if (sc.postinst) {
      for (const a of parseAlternatives(sc.postinst)) {
        const cur = alts.get(a.group);
        if (!cur || a.prio > cur.prio) alts.set(a.group, { ...a, pkg: n });
      }
      // 只有 alternatives 的脚本不用再跑；其余的原样保留（前缀已等长改写）
      const rest = sc.postinst.replace(/# Automatically added by termux_step_create_alternatives[\s\S]*?# End automatically added section/g, "")
        .split("\n").filter((l) => l.trim() && !l.startsWith("#!") && !/^\s*exit 0\s*$/.test(l));
      if (rest.length) firstRun.push({ pkg: n, script: R.swap(Buffer.from(sc.postinst))[0].toString() });
    }
    let files = 0, hit = 0;
    const listing = [];          // dpkg 风格的文件清单，见下
    for (const e of readTar(tar)) {
      const name = R.pathOf(e.name);
      if (!name) continue;
      const clean = name.replace(/\/$/, "");
      if (!clean) continue;
      if (DROP.has(clean)) continue;
      listing.push("/" + R.to.replace(/^\//, "") + "files/" + clean);
      if (e.type === "5") {
        if (seenDirs.has(clean)) continue;
        seenDirs.add(clean);
        tw.add({ name: clean + "/", type: "5", mode: e.mode || 0o755, mtime: e.mtime });
        continue;
      }
      if (e.type === "2") { tw.add({ name: clean, type: "2", mode: 0o777, mtime: e.mtime, link: R.swap(Buffer.from(e.link))[0].toString() }); continue; }
      if (e.type === "1") { tw.add({ name: clean, type: "1", mode: e.mode, mtime: e.mtime, link: R.pathOf(e.link) || e.link }); continue; }
      if (e.type !== "0" && e.type !== "7") continue;
      // zip 类归档要下潜到压缩条目内部再改一遍，flat 替换在里面找不到模式
      const [data, k] = looksLikeZip(clean) ? rewriteZip(e.data, R.swap) : R.swap(e.data);
      if (k) { hit += k; patchedFiles++; }
      tw.add({ name: clean, type: "0", mode: e.mode, mtime: e.mtime, data });
      files++;
    }
    patchedHits += hit;
    // var/lib/dpkg/info/<包>.list：我们不带 dpkg，但有的 postinst 拿它判断"某个包装没装"。
    // 实测：python 的 postinst 看不到 python-pip.list，就认定 pip 是旧版残留，把刚解出来的 pip 整个删掉。
    tw.add({ name: `usr/var/lib/dpkg/info/${n}.list`, type: "0", mode: 0o644, mtime: 0, data: Buffer.from(listing.join("\n") + "\n") });
    lock.push({
      name: n, repo: p.repo.name || "main", version: p.version, source: p.source, file: p.file, sha256: p.sha256, size: p.size,
      homepage: p.homepage,
      recipe: `https://github.com/termux/termux-packages/tree/master/packages/${p.source}`,
    });
    console.log(` ${String(files).padStart(5)} 文件  改写 ${hit}`);
  }
  // alternatives → 绝对路径软链（跟 update-alternatives 的结果一致，省掉它的数据库）
  const usrOf = (p) => R.pathOf(p.replace(/^\//, ""));
  for (const a of alts.values()) {
    for (const [link, target] of a.links) {
      const name = usrOf(link);
      if (name) tw.add({ name, type: "2", mode: 0o777, mtime: 0, link: R.swap(Buffer.from(target))[0].toString() });
    }
  }
  // 替身：pkg/apt 这类在这里用不了的命令，换成说明为什么、该怎么办的小脚本
  for (const [p, text] of Object.entries(MAN.stubs || {})) {
    tw.add({ name: p, type: "0", mode: 0o755, mtime: 0, data: Buffer.from("#!" + R.to + "files/usr/bin/sh\n" + text.replace(/\n?$/, "\n")) });
  }
  // 仓库之外的上游原件（如 ensurepip 的 pip wheel）：下载、核对哈希、原样放进去
  for (const [p, f] of Object.entries(MAN.fetch || {})) {
    const dest = path.join(CACHE, path.basename(p));
    let b = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (!b || sha256(b) !== f.sha256) {
      b = execFileSync("curl", ["-fsSL", "--max-time", "600", f.url], { maxBuffer: 2 ** 30 });
      if (sha256(b) !== f.sha256) throw new Error(`${p}: 哈希不符`);
      fs.writeFileSync(dest, b);
    }
    tw.add({ name: p, type: "0", mode: 0o644, mtime: 0, data: b });
    lock.push({ name: path.basename(p), version: path.basename(p).split("-")[1], source: "pypi", homepage: f.url, recipe: "-", file: f.url, sha256: f.sha256, size: b.length, why: f.why });
  }
  // 首次运行脚本：App 解包后跑一次（参数与 dpkg 一致：configure）
  const fr = ["#!" + R.to + "files/usr/bin/sh", "# devkit 首次运行：各包 postinst 里除 alternatives 外的步骤", "cd \"$HOME\" 2>/dev/null"];
  for (const f of firstRun) {
    const p = `usr/libexec/devkit/postinst/${f.pkg}`;
    // py3compile 要靠 termux-setup-package-manager + dpkg -L 列包内文件，我们两样都没带 ——
    // 原样跑会刷一屏 "cannot determine system package manager"。换成末尾统一 compileall。
    const script = f.script.replace(/^.*\/py3compile" -p .*$/gm, ": # py3compile → 由 first-run.sh 末尾的 compileall 统一做");
    tw.add({ name: p, type: "0", mode: 0o755, mtime: 0, data: Buffer.from(script) });
    fr.push(`echo "▸ ${f.pkg}"; "${R.to}files/${p}" configure || echo "  （${f.pkg} 的 postinst 失败，rc=$?）"`);
  }
  const py = R.to + "files/usr/bin/python3";
  fr.push(`if [ -x "${py}" ]; then echo "▸ 预编译 Python 标准库与 site-packages"; LD_PRELOAD= "${py}" -m compileall -q -j 0 "$(LD_PRELOAD= "${py}" -c "import sysconfig; print(sysconfig.get_path(\x27stdlib\x27))")" >/dev/null 2>&1; fi`);
  tw.add({ name: "usr/libexec/devkit/first-run.sh", type: "0", mode: 0o755, mtime: 0, data: Buffer.from(fr.join("\n") + "\n") });
  const manText = [...manifest].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, [h, n]]) => `${h} ${n} ${p}`).join("\n") + "\n";
  twAdd({ name: "usr/libexec/devkit/MANIFEST", type: "0", mode: 0o644, mtime: 0, data: Buffer.from(manText) });
  console.log(`  文件清单：${manifest.size} 个文件`);
  console.log(`  alternatives：${[...alts.values()].map((a) => a.group + "←" + a.pkg).join(" ")}`);
  console.log(`  首次运行脚本：${firstRun.map((f) => f.pkg).join(" ") || "无"}`);
  tw.close();
  fs.renameSync(tarFile + ".part", tarFile);
  // 发布用的压缩包：gzip —— 安卓 Java 自带解压（xz/zstd 的解压器要等工具包装好才有，先有鸡还是先有蛋）
  console.log("  压缩 → .tar.gz …");
  const tarInfo = await hashFile(tarFile);
  const gzInfo = await gzipFile(tarFile, tarFile + ".gz");

  fs.writeFileSync(path.join(OUT, "devkit.lock.json"), JSON.stringify({
    // compat：工具包与 App 外壳的接口版本。改了外壳依赖的布局（路径、first-run 约定…）就加一，旧 App 会拒装新工具包
    target, compat: 1, prefix: R.to + "files/usr", repos: REPOS, snapshot: idx.date,
    tar: { file: path.basename(tarFile), ...tarInfo },
    gz: { file: path.basename(tarFile) + ".gz", ...gzInfo },
    packages: lock,
  }, null, 2));
  fs.writeFileSync(path.join(OUT, "SBOM.tsv"),
    "package\tversion\tsource\thomepage\trecipe\tsha256\n" +
    lock.map((l) => [l.name, l.version, l.source, l.homepage, l.recipe, l.sha256].join("\t")).join("\n") + "\n");
  console.log(`\n✓ ${tarFile}  ${mb(tarInfo.bytes)} → .gz ${mb(gzInfo.bytes)}  用时 ${((Date.now() - t0) / 1000) | 0}s`);
  console.log(`  前缀改写：${patchedFiles} 个文件、${patchedHits} 处（等长，${TERMUX} → ${R.to}）`);
}
