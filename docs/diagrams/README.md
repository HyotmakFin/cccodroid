# Architecture diagrams · 架构图

Generated with **[Archify](https://github.com/tt-a1i/archify)** from small JSON specs: rendered to a self-contained interactive HTML, then extracted to a static SVG for inline display on GitHub.
Every component in the specs cites the source lines it describes (pinned to a commit), so the diagram can be checked against the code.

本目录的图用 **[Archify](https://github.com/tt-a1i/archify)** 生成：从小体量的 JSON 规格渲染成自包含的可交互 HTML，再抽取成静态 SVG 供 GitHub 内联显示。
规格里每个组件都标注了它对应的源码行（钉在某个提交上），图可以拿来和代码逐一核对。

| Diagram · 图 | English | 中文 |
|---|---|---|
| Runtime architecture · 运行时架构 | [SVG](architecture.en.svg) · [HTML](architecture.en.html) · [JSON](architecture.en.json) | [SVG](architecture.zh-CN.svg) · [HTML](architecture.zh-CN.html) · [JSON](architecture.zh-CN.json) |

| Format · 格式 | Use · 用途 |
|---|---|
| **SVG** | Static vector, shown inline in the README · 静态矢量，README 内联显示 |
| **HTML** | Interactive: zoom, search, focus, path tracing, light/dark themes · 可交互：缩放、搜索、聚焦、关系追踪、明暗主题 |
| **JSON** | The spec itself — edit it and re-render · 规格本体，改它再重新渲染 |

GitHub shows HTML files as source; download the HTML and open it in a browser for the interactive version.
GitHub 上 HTML 只显示源码，下载后用浏览器打开即可交互。

## Regenerate · 重新生成

Install the Archify skill, then from this directory (replace `$A` with the skill root):

装好 Archify skill 后，在本目录执行（`$A` 换成 skill 根目录）：

```sh
node $A/bin/archify.mjs finalize architecture architecture.en.json architecture.en.html \
  --repo-root ../.. --quality showcase --json
node extract-svg.mjs architecture.en.html architecture.en.svg dark
node check-svg.mjs architecture.en.svg          # well-formedness check · 标签配对自检
```

### On Android · 在安卓上

Archify publishes files atomically with hard links and checks inode identity. Android's SELinux forbids regular apps from creating hard links in their private directories (`link` → `EACCES`), and the kernel exposes no real file birth time (Node reports ctime instead).
[`android-link-shim.mjs`](android-link-shim.mjs) emulates both inside Node without touching Archify itself. The output directory must not be on `/sdcard` (FUSE), and `TMPDIR` must point to a quiet private directory:

Archify 用硬链接做原子发布并核对 inode。安卓的 SELinux 不许普通应用在私有目录里建硬链接（`link` → `EACCES`），内核也没有真的文件创建时间（Node 拿 ctime 顶替）。
[`android-link-shim.mjs`](android-link-shim.mjs) 在 Node 里把这两点模拟出来，不改 Archify 本身。输出目录不能在 `/sdcard`（FUSE）上，`TMPDIR` 要指向一个没有别的进程在写的私有目录：

```sh
export TMPDIR=$PWD/tmp NODE_OPTIONS="--import=$PWD/android-link-shim.mjs"
node $A/bin/archify.mjs finalize architecture architecture.en.json architecture.en.html --repo-root <repo> --quality showcase --json
```

The `browser-check` gate needs desktop Chrome / Chromium and is skipped on the phone; the other gates (validate, deliver, check) run.
`browser-check` 这一关要桌面版 Chrome / Chromium，手机上会跳过；其余三关（validate、deliver、check）照常执行。
