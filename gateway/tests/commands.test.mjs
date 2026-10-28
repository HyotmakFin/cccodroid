// 常用指令（gw/commands.mjs）：frontmatter 拆合、名字校验
import test from "node:test";
import assert from "node:assert/strict";
import { parseCmd, formatCmd, CMD_NAME_RE } from "../gw/commands.mjs";

test("拆：只认 description / argument-hint，别的项原样留着", () => {
  const c = parseCmd("---\ndescription: 整理议题\nargument-hint: \"<描述>\"\nallowed-tools: Bash(git:*)\n---\n正文 $ARGUMENTS\n");
  assert.equal(c.description, "整理议题");
  assert.equal(c.hint, "<描述>");
  assert.equal(c.extra, "allowed-tools: Bash(git:*)");
  assert.equal(c.body, "正文 $ARGUMENTS\n");
});

test("没有 frontmatter 的整个当正文", () => {
  const c = parseCmd("就一句话");
  assert.deepEqual([c.description, c.hint, c.body], ["", "", "就一句话"]);
});

test("合：拆完再合回去不变；带冒号、引号的说明会加引号", () => {
  const src = "---\ndescription: 整理议题\nargument-hint: <描述>\nallowed-tools: Bash(git:*)\n---\n正文 $ARGUMENTS\n";
  assert.equal(formatCmd(parseCmd(src)), src);
  const out = formatCmd({ description: "注意: 别乱写", hint: "", body: "x" });
  assert.match(out, /^---\ndescription: "注意: 别乱写"\n---\nx\n$/);
  assert.equal(parseCmd(out).description, "注意: 别乱写");
  assert.equal(formatCmd({ description: "", hint: "", body: "只有正文\n\n\n" }), "只有正文\n");
});

test("名字：字母数字 - _，不许路径和空格", () => {
  for (const ok of ["issue", "pr-review", "a_b", "X1"]) assert.ok(CMD_NAME_RE.test(ok), ok);
  for (const bad of ["../x", "a b", "-x", "", "a/b", "中文", "x".repeat(41)]) assert.ok(!CMD_NAME_RE.test(bad), bad);
});
