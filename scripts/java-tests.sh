#!/bin/sh
# Java 侧的纯逻辑回归（不依赖安卓运行时）：现在只有 Ed25519 验签向量。
# 编译产物放私有缓存目录，不进仓库。用法：sh scripts/java-tests.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${TMPDIR:-$HOME/.cache}/cccodroid-java-tests
rm -rf "$OUT"; mkdir -p "$OUT"
javac -nowarn -d "$OUT" "$ROOT/android/tests/stub/android/util/Base64.java" "$ROOT/android/java/cc/codroid/Ed25519.java" "$ROOT/android/tests/cc/codroid/Ed25519Vectors.java"
java -cp "$OUT" cc.codroid.Ed25519Vectors
