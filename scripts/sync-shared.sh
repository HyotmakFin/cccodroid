#!/system/bin/sh
# 开发期：网关/界面与 devkit 的源头目前在 claude-apk（与旧版 Claude CLI 应用共用），
# 这里把发布需要的部分同步进本仓库，让 cccodroid 能独立构建。改动请先在源头改，再跑本脚本。
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UP=${UP:-/sdcard/DeepSeekHarness/claude-apk}
rm -rf "$ROOT/gateway" "$ROOT/devkit"
mkdir -p "$ROOT/gateway/web" "$ROOT/devkit/vendor/xz-decompress/dist/package"
cp "$UP/src/server.mjs" "$ROOT/gateway/"
# web/ 下全部平铺文件（界面 + i18n.js / langs.js / lang-*.js 词典），跳过备份
for f in "$UP/src/web/"*; do case "$f" in *.bak*) ;; *) [ -f "$f" ] && cp "$f" "$ROOT/gateway/web/";; esac; done
cp "$UP/devkit/devkit.mjs" "$UP/devkit/devkit.json" "$UP/devkit/README.md" "$ROOT/devkit/"
X="$UP/devkit/vendor/xz-decompress"
cp "$X/package.json" "$X/README.md" "$ROOT/devkit/vendor/xz-decompress/"
cp "$X/dist/package/xz-decompress.js" "$ROOT/devkit/vendor/xz-decompress/dist/package/"
echo "✓ 已同步 gateway/ 与 devkit/"
