// SVG → PNG（resvg-wasm，2 倍），字体用安卓系统的 Roboto + Noto CJK：node resvg-png.mjs <resvg-wasm 解包目录> in.svg out.png [in2.svg out2.png …]
import fs from "node:fs";
const { initWasm, Resvg } = await import(process.argv[2] + "/package/index.mjs");
await initWasm(fs.readFileSync(process.argv[2] + "/package/index_bg.wasm"));
const fonts = ["/system/fonts/Roboto-Regular.ttf", "/system/fonts/NotoSansCJK-Regular.ttc", "/system/fonts/DroidSansMono.ttf"].map((f) => fs.readFileSync(f));
for (const [src, out] of process.argv.slice(3).reduce((a, x, i, arr) => (i % 2 ? a : [...a, [x, arr[i + 1]]]), [])) {
  const r = new Resvg(fs.readFileSync(src, "utf8"), { fitTo: { mode: "zoom", value: 2 }, font: { fontBuffers: fonts, defaultFontFamily: "Noto Sans CJK SC", sansSerifFamily: "Noto Sans CJK SC", monospaceFamily: "Droid Sans Mono" } });
  const p = r.render(); fs.writeFileSync(out, p.asPng()); console.log(out, p.width + "x" + p.height);
}
