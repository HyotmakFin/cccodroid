# Architecture diagrams · 架构图

Generated with **[Archify](https://github.com/tt-a1i/archify)** from small JSON specs: rendered to a self-contained interactive HTML, then exported as light and dark PNGs that the READMEs switch between with the system appearance (`<picture>` + `prefers-color-scheme`).
Every component in the specs cites the source lines it describes (pinned to a commit), so the diagram can be checked against the code.

本目录的图用 **[Archify](https://github.com/tt-a1i/archify)** 生成：从小体量的 JSON 规格渲染成自包含的可交互 HTML，再导出浅色、深色两张 PNG，README 随系统外观切换（`<picture>` + `prefers-color-scheme`）。
规格里每个组件都标注了它对应的源码行（钉在某个提交上），图可以拿来和代码逐一核对。

| Diagram · 图 | English | 中文 |
|---|---|---|
| Runtime architecture · 运行时架构 | [light](cccodroid-architecture.en-light.png) · [dark](cccodroid-architecture.en-dark.png) · [HTML](cccodroid-architecture.en.html) · [JSON](cccodroid-architecture.en.json) | [浅色](cccodroid-architecture.zh-CN-light.png) · [深色](cccodroid-architecture.zh-CN-dark.png) · [HTML](cccodroid-architecture.zh-CN.html) · [JSON](cccodroid-architecture.zh-CN.json) |

| Format · 格式 | Use · 用途 |
|---|---|
| **PNG** | Light / dark, shown in the README by system appearance · 浅色 / 深色，README 随系统外观显示 |
| **HTML** | Interactive: zoom, search, focus, path tracing, light/dark themes · 可交互：缩放、搜索、聚焦、关系追踪、明暗主题 |
| **JSON** | The spec itself — edit it and re-render · 规格本体，改它再重新渲染 |

GitHub shows HTML files as source; download the HTML and open it in a browser for the interactive version.
GitHub 上 HTML 只显示源码，下载后用浏览器打开即可交互。

## Regenerate · 重新生成

Install the Archify skill, then from this directory (replace `$A` with the skill root):

装好 Archify skill 后，在本目录执行（`$A` 换成 skill 根目录）：

```sh
node $A/bin/archify.mjs finalize architecture cccodroid-architecture.en.json cccodroid-architecture.en.html \
  --repo-root ../.. --quality showcase --json
# light / dark SVG as an intermediate step · 先抽出浅色 / 深色 SVG 作中间产物
node extract-svg.mjs cccodroid-architecture.en.html en-light.svg light
node extract-svg.mjs cccodroid-architecture.en.html en-dark.svg dark
node check-svg.mjs en-light.svg                 # well-formedness check · 标签配对自检
```

PNG: serve the directory with `node png-server.mjs .` (port 8799), open `http://127.0.0.1:8799/render-png.html` in any browser and run `go()` in the console;
it draws each SVG onto a 2× canvas and posts the PNG back to the server. Rename the results to `cccodroid-architecture.<lang>-<theme>.png`.

PNG：`node png-server.mjs .`（端口 8799）起一个服务，任意浏览器打开 `http://127.0.0.1:8799/render-png.html`，在控制台执行 `go()`，
它把每张 SVG 画到 2 倍大小的画布上，再把 PNG 传回服务端落盘。最后改名为 `cccodroid-architecture.<语言>-<主题>.png`。

PNG without a browser (what the current PNGs were made with): flatten the SVG for [resvg](https://github.com/linebender/resvg) — CSS variables, `color-mix()` and theme selectors resolved — then render at 2× with the system fonts.
`resvg-wasm` is fetched from npm (`@resvg/resvg-wasm`, MPL-2.0) and not vendored here:

不用浏览器出 PNG（现在这几张就是这么出的）：先把 SVG 化简成 [resvg](https://github.com/linebender/resvg) 能吃的（代入 CSS 变量、算出 `color-mix()`、按主题化简选择器），再用系统字体按 2 倍渲染。
`resvg-wasm` 从 npm 取（`@resvg/resvg-wasm`，MPL-2.0），不放进本仓库：

```sh
node flatten-svg.mjs en-light.svg f-en-light.svg
node resvg-png.mjs <resvg-wasm 解包目录> f-en-light.svg cccodroid-architecture.en-light.png
```

### On Android · 在安卓上

Archify publishes files atomically with hard links and checks inode identity. Android's SELinux forbids regular apps from creating hard links in their private directories (`link` → `EACCES`), and the kernel exposes no real file birth time (Node reports ctime instead).
[`android-link-shim.mjs`](android-link-shim.mjs) emulates both inside Node without touching Archify itself. The output directory must not be on `/sdcard` (FUSE), and `TMPDIR` must point to a quiet private directory:

Archify 用硬链接做原子发布并核对 inode。安卓的 SELinux 不许普通应用在私有目录里建硬链接（`link` → `EACCES`），内核也没有真的文件创建时间（Node 拿 ctime 顶替）。
[`android-link-shim.mjs`](android-link-shim.mjs) 在 Node 里把这两点模拟出来，不改 Archify 本身。输出目录不能在 `/sdcard`（FUSE）上，`TMPDIR` 要指向一个没有别的进程在写的私有目录：

```sh
export TMPDIR=$PWD/tmp NODE_OPTIONS="--import=$PWD/android-link-shim.mjs"
node $A/bin/archify.mjs finalize architecture cccodroid-architecture.en.json cccodroid-architecture.en.html --repo-root <repo> --quality showcase --json
```

The `browser-check` gate needs desktop Chrome / Chromium and is skipped on the phone; the other gates (validate, deliver, check) run.
`browser-check` 这一关要桌面版 Chrome / Chromium，手机上会跳过；其余三关（validate、deliver、check）照常执行。
