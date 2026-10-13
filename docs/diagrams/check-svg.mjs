import fs from "node:fs";
// 扫描无值属性：跳过注释/CDATA/引号内/文本内容
function scan(s) {
  const bad = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt); i = e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt); i = e + 3; continue; }
    let j = lt + 1, q = null;
    while (j < s.length) {
      const c = s[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    const tag = s.slice(lt, j + 1);
    if (!/^<\//.test(tag) && !/^<[?!]/.test(tag)) {
      let k = 0, qq = null;
      while (k < tag.length) {
        const c = tag[k];
        if (qq) { if (c === qq) qq = null; k++; continue; }
        if (c === '"' || c === "'") { qq = c; k++; continue; }
        const m = /^(\s)([a-zA-Z_][\w:.-]*)(?=\s|\/|>)/.exec(tag.slice(k));
        if (m) { bad.push(tag.slice(0, 70)); break; }
        k++;
      }
    }
    i = j + 1;
  }
  return bad;
}
for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, "utf8");
  const b = scan(s);
  const ok = b.length === 0 ? "✅ 无无值属性" : `❌ 仍有 ${b.length} 处 → ${b[0]}`;
  // 粗查标签配对
  const opens = (s.match(/<(?!\/)[a-zA-Z]/g) || []).length;
  const selfClose = (s.match(/\/>/g) || []).length;
  const closes = (s.match(/<\/[a-zA-Z]/g) || []).length;
  console.log(`  ${f}\n    ${ok}\n    标签: 开 ${opens} / 自闭 ${selfClose} / 闭 ${closes}  差 ${opens - selfClose - closes}`);
}
