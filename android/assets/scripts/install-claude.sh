#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  install-claude.sh —— 下载 Anthropic 官方的 Claude Code（原版二进制，不做任何修改）
#
#  逻辑在旁边的 install-claude.mjs：官方直链拿不到时换 npm 镜像（同一份 Anthropic 发布的包），
#  一律按官方清单的 sha256（或 npm 签名）校验，见那边的说明。这里只是给 Java 留的入口。
#
#  用法:  install-claude.sh [stable|latest|<版本号>]
# ─────────────────────────────────────────────────────────────────────
exec "$PREFIX/bin/node" "$(dirname "$0")/install-claude.mjs" "$@"
