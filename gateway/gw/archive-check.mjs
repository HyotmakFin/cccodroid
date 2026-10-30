// 解压前先看目录：GNU tar 和 Info-ZIP unzip 都会顺着包里先建的软链，把后面的条目写到包外
// （link → /外面/目录，再来一条 link/x），解完再删软链已经晚了（审查 v0513b 中-4）。
// 所以解之前按目录查一遍，有这种写法的整包拒绝：
//   · 条目名是绝对路径、或带 .. 段
//   · 条目要经过包里的软链（软链名是它的上级目录），或者和软链同名（会被拿来替换 / 跟随）
//   · 硬链接指向绝对路径、带 .. 段、或者经过软链
// 纯函数部分不碰外部程序，测试在 tests/archive-check.test.mjs。
import fs from "node:fs";

/** 解 C 风格引号里的转义（tar --quoting-style=c 的输出） */
function unC(s) {
  return s.replace(/\\(?:([0-7]{1,3})|(.))/g, (_, o, c) => o ? String.fromCharCode(parseInt(o, 8))
    : ({ n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"', "?": "?" })[c] ?? c);
}

/** tar -tv --quoting-style=c 的输出 → [{ name, type: "file"|"dir"|"link"|"hard"|"other", target }] */
export function parseTarListing(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const q = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unC(m[1]));
    if (!q.length) throw new Error("tar listing: unquoted line");
    const c = line[0];
    const type = c === "-" ? "file" : c === "d" ? "dir" : c === "l" ? "link" : c === "h" ? "hard" : "other";
    out.push({ name: q[0], type, target: q[1] ?? "" });
  }
  return out;
}

/** 读 zip 的中央目录 → [{ name, type, target:"" }]（软链按外部属性里的 unix 模式认；目标在数据区里，不读，经软链写本身就拒） */
export function zipEntries(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("zip: no end of central directory");
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      // ZIP64：定位器在 EOCD 前 20 字节
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("zip64: locator missing");
      const z = Buffer.alloc(56);
      fs.readSync(fd, z, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error("zip64: bad end record");
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    if (cdSize > 256 << 20 || cdOff + cdSize > size) throw new Error("zip: central directory out of range");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    for (let o = 0, n = 0; n < count; n++) {
      if (o + 46 > cd.length || cd.readUInt32LE(o) !== 0x02014b50) throw new Error("zip: bad central directory entry");
      const madeBy = cd[o + 5], nl = cd.readUInt16LE(o + 28), xl = cd.readUInt16LE(o + 30), cl = cd.readUInt16LE(o + 32);
      const ext = cd.readUInt32LE(o + 38);
      if (o + 46 + nl > cd.length) throw new Error("zip: name out of range");
      const name = cd.toString("utf8", o + 46, o + 46 + nl);
      const mode = madeBy === 3 ? (ext >>> 16) & 0o170000 : 0;    // 3 = unix；别的系统打的包没有软链
      const type = mode === 0o120000 ? "link" : name.endsWith("/") || mode === 0o040000 ? "dir" : "file";
      out.push({ name, type, target: "" });
      o += 46 + nl + xl + cl;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

const segs = (p) => String(p).split(/[\\/]+/).filter((s) => s && s !== ".");
const norm = (p) => segs(p).join("/");

/** 查一遍条目；有问题返回说明（第一处），没问题返回 null */
export function archiveProblem(entries) {
  const links = new Set();
  for (const e of entries) {
    if (/[\0]/.test(e.name)) return { why: "bad-name", name: e.name };
    if (/^([\\/]|[A-Za-z]:)/.test(e.name) || segs(e.name).includes("..")) return { why: "escape", name: e.name };
    if (e.type === "link") links.add(norm(e.name));
  }
  if (!links.size && !entries.some((e) => e.type === "hard")) return null;
  for (const e of entries) {
    const s = segs(e.name);
    // 自己是软链：同名的别的条目（会被拿来顺着写）
    const me = s.join("/");
    if (e.type !== "link" && links.has(me)) return { why: "via-link", name: e.name };
    for (let i = 1; i < s.length; i++) if (links.has(s.slice(0, i).join("/"))) return { why: "via-link", name: e.name };
    if (e.type === "hard") {
      const t = e.target;
      if (!t || /^([\\/]|[A-Za-z]:)/.test(t) || segs(t).includes("..")) return { why: "escape", name: e.name };
      const ts = segs(t);
      for (let i = 1; i <= ts.length; i++) if (links.has(ts.slice(0, i).join("/"))) return { why: "via-link", name: e.name };
    }
  }
  // 软链名重复（第二条可能指向别处再被第三条跟随）
  const seen = new Set();
  for (const e of entries) if (e.type === "link") { const k = norm(e.name); if (seen.has(k)) return { why: "via-link", name: e.name }; seen.add(k); }
  return null;
}
