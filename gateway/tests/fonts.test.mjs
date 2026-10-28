// 导入字体（gw/fonts.mjs）：认格式看文件头、字体名从 name 表读。样本用界面自带的字体（woff / woff2）和手搓的 sfnt
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fontFormat, fontName } from "../gw/fonts.mjs";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "fonts");
const read = (f) => fs.readFileSync(path.join(WEB, f));

// 最小的 sfnt：只有一张 name 表，一条 Windows 中文家族名
function sfnt(magic, family) {
  const s = Buffer.from(family, "utf16le").swap16();
  const name = Buffer.alloc(6 + 12 + s.length);
  name.writeUInt16BE(0, 0); name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
  [3, 1, 0x0804, 1, s.length, 0].forEach((v, i) => name.writeUInt16BE(v, 6 + i * 2));
  s.copy(name, 18);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(magic, 0); head.writeUInt16BE(1, 4);
  head.write("name", 12, "latin1"); head.writeUInt32BE(28, 20); head.writeUInt32BE(name.length, 24);
  return Buffer.concat([head, name]);
}

test("认格式：ttf / otf / woff / woff2，ttc 和别的都不收", () => {
  assert.equal(fontFormat(sfnt(0x00010000, "x")), "ttf");
  assert.equal(fontFormat(sfnt(0x4f54544f, "x")), "otf");
  assert.equal(fontFormat(read("ccmono.woff")), "woff");
  assert.equal(fontFormat(read("hei-400.woff2")), "woff2");
  assert.equal(fontFormat(Buffer.from("ttcf\0\x01\0\0\0\0\0\0", "latin1")), "");
  assert.equal(fontFormat(Buffer.from("<html><body>not a font</body></html>")), "");
  assert.equal(fontFormat(Buffer.alloc(4)), "");
});

test("字体名：sfnt 读中文家族名，woff / woff2 解压后读", () => {
  assert.equal(fontName(sfnt(0x00010000, "霞鹜文楷"), "ttf"), "霞鹜文楷");
  assert.equal(fontName(read("hei-400.woff2"), "woff2"), "CC Hei");
  assert.equal(fontName(read("spectral-400.woff2"), "woff2"), "Spectral");
  assert.ok(fontName(read("ccmono.woff"), "woff").length > 0);
});

test("坏文件不抛错，字体名给空串（导入时退回文件名）", () => {
  const bad = Buffer.concat([Buffer.from("wOF2", "latin1"), Buffer.alloc(60, 0xff)]);
  assert.equal(fontName(bad, "woff2"), "");
  assert.equal(fontName(Buffer.from([0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]), "ttf"), "");
});
