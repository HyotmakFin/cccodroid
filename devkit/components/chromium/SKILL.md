---
name: chromium-browser
description: 无头 Chromium（cccodroid 可选组件）：打开网页截图、导出 PDF、取渲染后的 DOM、跑页面 JS，或用 puppeteer-core 程序化操作网页。测试本机开发服务的页面、抓需要 JS 渲染的网页时使用。
---

# 无头 Chromium（cccodroid 组件）

本机装了 Chromium（Termux 官方包，已改写为本应用路径），**只能无头运行**：没有显示服务器，不会弹窗口。
用户要亲眼看网页时，在回复里给出链接（如 `http://127.0.0.1:5173/`），他点开就在应用内浏览器里看；
需要你自己看页面效果时，用下面的截图，再用 Read 工具读图片。

## 命令行（最常用）

入口是 `chromium-headless`（已带好安卓上必需的参数：`--headless --no-sandbox --disable-gpu`）：

```sh
# 截图（--window-size 定视口；长页面加大高度）
chromium-headless --screenshot="$TMPDIR/page.png" --window-size=1280,800 http://127.0.0.1:5173/

# JS 执行完之后的 DOM
chromium-headless --dump-dom https://example.com > "$TMPDIR/dom.html"

# 导出 PDF（不要页眉页脚）
chromium-headless --print-to-pdf="$TMPDIR/out.pdf" --no-pdf-header-footer file:///path/to/page.html
```

- 截图默认写到当前目录；给绝对路径更稳。交给用户的产物拷到共享目录。
- 中文用系统字体，显示正常。本地 HTML 文件要写 `<meta charset="utf-8">`，否则中文会乱码。
- 首次启动约 5 秒。

## 程序化操作：puppeteer-core

点击、填表、等待元素、多步流程时用 puppeteer-core（只装控制库，不另下浏览器）：

```sh
mkdir -p ~/pp && cd ~/pp && npm i puppeteer-core
```

```js
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: process.env.PREFIX + "/lib/chromium/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5173/");
console.log(await page.$eval("h1", (e) => e.textContent));
await page.screenshot({ path: process.env.TMPDIR + "/shot.png" });
await browser.close();
```

运行时加 `DBUS_SESSION_BUS_ADDRESS=disabled:` 可以去掉 dbus 报错。**不要** `npm i puppeteer`（完整版会去下载 x86 的 Chrome，用不了）。

## 已知限制

- 没有 GPU 加速；WebGL 页面可能显示不全。
- 不能看视频 DRM 内容；没有扩展、没有登录过的用户资料。
- 关于 dbus、inotify、GSettings 的报错可以忽略，不影响结果。
