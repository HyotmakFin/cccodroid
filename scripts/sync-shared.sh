#!/system/bin/sh
# 开发期：网关/界面与 devkit 的源头目前在 claude-apk（与旧版 Claude CLI 应用共用），
# 这里把发布需要的部分同步进本仓库，让 cccodroid 能独立构建。改动请先在源头改，再跑本脚本。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UP=${UP:-/sdcard/DeepSeekHarness/claude-apk}
rm -rf "$ROOT/gateway" "$ROOT/devkit"
mkdir -p "$ROOT/gateway/web" "$ROOT/devkit/vendor/xz-decompress/dist/package"
cp "$UP/src/server.mjs" "$ROOT/gateway/"
# web/ 下全部文件（界面 + i18n.js / langs.js / lang-*.js 词典 + 子目录 pdfjs/），跳过备份
for f in "$UP/src/web/"*; do case "$f" in *.bak*) ;; *) cp -R "$f" "$ROOT/gateway/web/";; esac; done
cp "$UP/devkit/devkit.mjs" "$UP/devkit/devkit.json" "$UP/devkit/README.md" "$UP/devkit/components-index.mjs" "$ROOT/devkit/"
# 可选组件自带的文件（入口包装、给 Claude 的 skill），devkit.json 的 components.*.files 引用它们
cp -R "$UP/devkit/components" "$ROOT/devkit/"
X="$UP/devkit/vendor/xz-decompress"
cp "$X/package.json" "$X/README.md" "$ROOT/devkit/vendor/xz-decompress/"
cp "$X/dist/package/xz-decompress.js" "$ROOT/devkit/vendor/xz-decompress/dist/package/"
echo "✓ 已同步 gateway/ 与 devkit/"
