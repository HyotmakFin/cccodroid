// 自定义组件解压前的目录检查（gw/archive-check.mjs，审查 v0513b 中-4）：经软链写到包外的整包拒绝
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { archiveProblem, parseTarListing, zipEntries } from "../gw/archive-check.mjs";

const F = (name, type = "file", target = "") => ({ name, type, target });

test("正常的包放行", () => {
  assert.equal(archiveProblem([F("foo-1.0/", "dir"), F("foo-1.0/bin/foo"), F("foo-1.0/lib/libx.so.1"), F("foo-1.0/lib/libx.so", "link", "libx.so.1")]), null);
  assert.equal(archiveProblem([F("./a"), F("./b/c")]), null);
});

test("经软链写出去的拒绝（先建 link，再写 link/x）", () => {
  assert.equal(archiveProblem([F("link", "link", "/outside/dir"), F("link/evil.txt")]).why, "via-link");
  assert.equal(archiveProblem([F("a/", "dir"), F("a/l", "link", "../../.."), F("a/l/x/y")]).why, "via-link");
  assert.equal(archiveProblem([F("./link", "link", "/x"), F("link/evil")]).why, "via-link");     // ./ 前缀不同也认得
  assert.equal(archiveProblem([F("l", "link", "/x"), F("l", "file")]).why, "via-link");         // 同名条目
  assert.equal(archiveProblem([F("l", "link", "a"), F("l", "link", "/x")]).why, "via-link");     // 软链名重复
  assert.equal(archiveProblem([F("l", "link", "/x"), F("l/", "dir")]).why, "via-link");
  assert.equal(archiveProblem([F("l", "link", "/x"), F("l\\evil")]).why, "via-link");          // 反斜杠也当分隔
});

test("绝对路径、.. 段、硬链接跳出去的拒绝", () => {
  assert.equal(archiveProblem([F("/etc/x")]).why, "escape");
  assert.equal(archiveProblem([F("a/../../x")]).why, "escape");
  assert.equal(archiveProblem([F("..\\x")]).why, "escape");
  assert.equal(archiveProblem([F("C:/x")]).why, "escape");
  assert.equal(archiveProblem([F("h", "hard", "/etc/passwd")]).why, "escape");
  assert.equal(archiveProblem([F("h", "hard", "../x")]).why, "escape");
  assert.equal(archiveProblem([F("l", "link", "/x"), F("h", "hard", "l/y")]).why, "via-link");
  assert.equal(archiveProblem([F("a"), F("h", "hard", "a")]), null);
});

test("tar --quoting-style=c 的输出能解，引号和转义不乱", () => {
  const out = [
    'drwxr-xr-x u/g         0 2026-10-31 03:00 "pkg/"',
    'lrwxrwxrwx u/g         0 2026-10-31 03:00 "pkg/link" -> "/outside/dir"',
    '-rw-r--r-- u/g        12 2026-10-31 03:00 "pkg/link/evil.txt"',
    '-rw-r--r-- u/g        12 2026-10-31 03:00 "pkg/with \\"quote\\" and -> arrow"',
    'hrw-r--r-- u/g         0 2026-10-31 03:00 "pkg/h" link to "pkg/a b"',
    '-rw-r--r-- u/g         1 2026-10-31 03:00 "pkg/\\344\\270\\255"',
  ].join("\n");
  const e = parseTarListing(out);
  assert.deepEqual(e.map((x) => x.type), ["dir", "link", "file", "file", "hard", "file"]);
  assert.equal(e[1].target, "/outside/dir");
  assert.equal(e[3].name, 'pkg/with "quote" and -> arrow');
  assert.equal(e[4].target, "pkg/a b");
  assert.equal(archiveProblem(e).why, "via-link");
  assert.throws(() => parseTarListing("-rw-r--r-- u/g 1 2026-10-31 03:00 noquotes"));
});

// 手搓一个 zip：只写中央目录要用到的字段（数据区放空的 stored 条目）
function makeZip(entries) {
  const locals = [], cds = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data || "");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(zlib.crc32 ? zlib.crc32(data) : 0, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch[4] = 30; ch[5] = 3;       // made by unix
    ch.writeUInt16LE(20, 6); ch.writeUInt32LE(zlib.crc32 ? zlib.crc32(data) : 0, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode || 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    cds.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("zip 中央目录：软链按 unix 模式认出来，经软链写的拒绝", () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "zip-"));
  const bad = path.join(dir, "bad.zip"), good = path.join(dir, "good.zip");
  fs.writeFileSync(bad, makeZip([{ name: "link", mode: 0o120777, data: "/outside/dir" }, { name: "link/evil.txt", data: "x" }]));
  fs.writeFileSync(good, makeZip([{ name: "pkg/", mode: 0o040755 }, { name: "pkg/bin/foo", mode: 0o100755, data: "#!/bin/sh\n" }]));
  const eb = zipEntries(bad);
  assert.deepEqual(eb.map((x) => [x.name, x.type]), [["link", "link"], ["link/evil.txt", "file"]]);
  assert.equal(archiveProblem(eb).why, "via-link");
  assert.equal(archiveProblem(zipEntries(good)), null);
  fs.writeFileSync(path.join(dir, "junk.zip"), "not a zip at all");
  assert.throws(() => zipEntries(path.join(dir, "junk.zip")));
});

// 有 GNU tar 时（CI、Linux 开发机）用真 tar 打一个穿链包，走真实的列目录命令
const gnu = spawnSync("tar", ["--version"], { encoding: "utf8" });
test("真 GNU tar：穿链包被认出来", { skip: !/GNU tar/.test(gnu.stdout || "") && "没有 GNU tar" }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "tar-"));
  const src = path.join(dir, "src"); fs.mkdirSync(src);
  fs.symlinkSync("/outside/dir", path.join(src, "link"));
  // 第二个条目名叫 link/evil.txt：用 --transform 把普通文件改名进去
  fs.writeFileSync(path.join(src, "evil.txt"), "x");
  const tarf = path.join(dir, "evil.tar");
  let r = spawnSync("tar", ["-cf", tarf, "-C", src, "link", "--transform=s|^evil.txt$|link/evil.txt|", "evil.txt"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync("tar", ["-tv", "--quoting-style=c", "-f", tarf], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const e = parseTarListing(r.stdout);
  assert.deepEqual(e.map((x) => x.name), ["link", "link/evil.txt"]);
  assert.equal(archiveProblem(e).why, "via-link");
});
