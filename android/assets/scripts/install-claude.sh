#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  install-claude.sh —— 从 Anthropic 官方渠道下载 Claude Code（原版二进制，不做任何修改）
#
#  与官方 https://claude.ai/install.sh 同一来源、同一校验方式：
#    downloads.claude.ai/claude-code-releases/<版本>/manifest.json 里的 sha256
#  平台取 linux-arm64（glibc 版），由 devkit 里 Termux 官方的 glibc 运行库加载。
#
#  用法:  install-claude.sh [stable|latest|<版本号>]
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="https://downloads.claude.ai/claude-code-releases"
PLATFORM="linux-arm64"
CHANNEL="${1:-stable}"
DEST="$HOME/.local/share/cccodroid/claude"
mkdir -p "$DEST"

if [[ "$CHANNEL" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  VER="$CHANNEL"
else
  VER=$(curl -fsSL "$BASE/$CHANNEL")
fi
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "取版本号失败（得到：$VER）"; exit 1; }
echo "版本 $VER（$CHANNEL）"

MANIFEST=$(curl -fsSL "$BASE/$VER/manifest.json")
SUM=$(jq -r ".platforms[\"$PLATFORM\"].checksum // empty" <<<"$MANIFEST")
SIZE=$(jq -r ".platforms[\"$PLATFORM\"].size // empty" <<<"$MANIFEST")
[[ "$SUM" =~ ^[a-f0-9]{64}$ ]] || { echo "清单里没有 $PLATFORM"; exit 1; }

OUT="$DEST/$VER"
mkdir -p "$OUT"
if [ -f "$OUT/claude" ] && [ "$(sha256sum "$OUT/claude" | cut -d' ' -f1)" = "$SUM" ]; then
  echo "已是该版本，校验通过"
else
  echo "下载 $((SIZE / 1048576)) MB…"
  # 进度走 "@progress 已下 总量" 行（安装界面据此画进度条）；curl 自己的进度表在非终端下按 \r 刷新，会刷满日志
  curl -fsSL --retry 5 --retry-all-errors -C - -o "$OUT/claude.part" "$BASE/$VER/$PLATFORM/claude" &
  CURL=$!
  while kill -0 $CURL 2>/dev/null; do
    echo "@progress $(stat -c %s "$OUT/claude.part" 2>/dev/null || echo 0) $SIZE"
    sleep 2
  done
  wait $CURL
  GOT=$(sha256sum "$OUT/claude.part" | cut -d' ' -f1)
  [ "$GOT" = "$SUM" ] || { echo "✗ sha256 不符（期望 $SUM，实得 $GOT）"; rm -f "$OUT/claude.part"; exit 1; }
  mv "$OUT/claude.part" "$OUT/claude"
  echo "✓ sha256 与官方清单一致"
fi
chmod 755 "$OUT/claude"
PREV=$(readlink "$DEST/current" 2>/dev/null || true)
ln -sfn "$OUT" "$DEST/current"
# 只留当前版和上一版（每版约 230 MB）。正在跑的旧 claude 已经映射进内存，删文件不影响它
for d in "$DEST"/*; do
  [ -L "$d" ] && continue
  [ "$d" = "$OUT" ] || [ "$d" = "$PREV" ] || rm -rf "$d"
done

# 试跑一次（只读版本号）
P=${CCAPP_CLAUDE_PRELOAD:-}; [ -f "$P" ] || P=""
"$PREFIX/glibc/lib/ld-linux-aarch64.so.1" --library-path "$PREFIX/glibc/lib" ${P:+--preload "$P"} "$DEST/current/claude" --version
