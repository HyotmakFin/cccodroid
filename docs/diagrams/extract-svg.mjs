// 从 archify 生成的 HTML 中抽出可独立显示的 SVG（供 GitHub README 内联展示）
// 用法: node extract-svg.mjs <in.html> <out.svg> [theme]
import fs from "node:fs";

const [, , inPath, outPath, themeArg = "dark"] = process.argv;
const html = fs.readFileSync(inPath, "utf8");

// ── 1. 取 <svg> 块
const s0 = html.indexOf("<svg");
const s1 = html.indexOf("</svg>");
if (s0 < 0 || s1 < 0) throw new Error("找不到 <svg> 块: " + inPath);
let svg = html.slice(s0, s1 + 6);

// ── 2. 取 <style> 块，只保留 SVG 真正用到的类
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
let css = styles.join("\n");

const used = new Set();
for (const m of svg.matchAll(/class="([^"]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) used.add(c);
}

/** 极简 CSS 规则过滤：保留变量定义、@ 规则、以及选择器命中已用类名的规则 */
function filterCss(text, usedClasses) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith("/*", i)) {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    const braceOpen = text.indexOf("{", i);
    if (braceOpen < 0) break;
    const selector = text.slice(i, braceOpen).trim();
    let depth = 1, j = braceOpen + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(braceOpen + 1, j - 1);

    if (selector.startsWith("@")) {
      if (/^@(media|supports|layer)/.test(selector)) {
        const inner = filterCss(body, usedClasses);
        if (inner.trim()) out.push(`${selector}{${inner}}`);
      } else {
        out.push(`${selector}{${body}}`);
      }
    } else if (
      selector.includes(":root") ||
      selector.includes("[data-theme") ||
      selector.includes("[data-preset") ||
      [...usedClasses].some((c) => selector.includes("." + c))
    ) {
      out.push(`${selector}{${body}}`);
    }
    i = j;
  }
  return out.join("\n");
}

const before = css.length;
css = filterCss(css, used);
console.log(`  CSS 过滤: ${before} → ${css.length} 字节（用到 ${used.size} 个类）`);

// ── 3. XML 合规化
/**
 * HTML 允许无值属性（<text data-detail-anchor x="1">），XML 不允许。
 * SVG 文件按 XML 解析，所以必须补成 data-detail-anchor=""。
 * 逐字符扫描并跳过引号内内容，否则会把 aria-labelledby="a b" 里的 b 误判成属性。
 */
function fixTag(tag) {
  if (/^<\//.test(tag) || /^<[?!]/.test(tag)) return tag;
  let out = "", i = 0, q = null;
  while (i < tag.length) {
    const c = tag[i];
    if (q) { out += c; if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
    const m = /^(\s)([a-zA-Z_][\w:.-]*)(?=\s|\/|>)/.exec(tag.slice(i));
    if (m) { out += m[1] + m[2] + '=""'; i += m[0].length; continue; }
    out += c; i++;
  }
  return out;
}

/** 逐字符走完整个 SVG，只对标签部分做修正（跳过注释/CDATA/文本内容） */
function normalizeSvg(s) {
  let out = "", i = 0, fixed = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt); out += s.slice(lt, e + 3); i = e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt); out += s.slice(lt, e + 3); i = e + 3; continue; }
    // 找标签结束的 >，跳过引号内的
    let j = lt + 1, q = null;
    while (j < s.length) {
      const c = s[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    const tag = s.slice(lt, j + 1);
    const fixedTag = fixTag(tag);
    if (fixedTag !== tag) fixed++;
    out += fixedTag;
    i = j + 1;
  }
  return { out, fixed };
}

const { out: normalized, fixed } = normalizeSvg(svg);
svg = normalized;
console.log(`  XML 合规化: 修正 ${fixed} 个标签的无值属性`);

// ── 4. 组装独立 SVG
svg = svg.replace(/^<svg\b/, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`);
svg = svg.replace(/^<svg\b([^>]*)>/, (m, attrs) => {
  const cleaned = attrs.replace(/\sdata-theme="[^"]*"/g, "");
  return `<svg${cleaned} data-theme="${themeArg}">`;
});

// CSS 放进 CDATA，避免其中的特殊字符破坏 XML
const safeCss = css.replace(/]]>/g, "]]]]><![CDATA[>");
const vb = (svg.match(/viewBox="([^"]+)"/) || [, "0 0 1000 600"])[1].split(/\s+/).map(Number);
const bg = `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="var(--bg, #020617)"/>`;
svg = svg.replace(/(<svg[^>]*>)/, `$1\n<style><![CDATA[\n${safeCss}\n]]></style>\n${bg}`);

fs.writeFileSync(outPath, svg);
console.log(`  ✅ ${outPath}  ${(svg.length / 1024).toFixed(0)} KB  viewBox=${vb.join(" ")}`);
