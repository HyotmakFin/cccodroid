#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  build.sh —— 构建 cccodroid APK：原生小库 → javac → d8 → aapt2 → 签名
#
#  在哪都能跑：默认用作者平板上的一套工具；别的机器（含 GitHub Actions，见 .github/workflows/apk.yml）
#  用环境变量换掉 ——
#    CC_ANDROID    编 aarch64 安卓程序的 C 编译器（NDK 里的 aarch64-linux-android26-clang）
#    JAVAC D8 AAPT2 ANDROID_JAR   对应 SDK / JDK 里的工具
#    SIGN=apksigner  用 SDK 的 apksigner 签（再给 APKSIGNER、ZIPALIGN）；默认是平板上的签名库
#  钥匙：KEY 指向 {"key": PEM 私钥, "cert": PEM 证书} 的 JSON，绝不进仓库（CI 里放在仓库 secret）。
#        换钥匙 = 已装的用户必须卸载重装，所以它丢了就再也发不了更新 —— 要另做离线备份。
#        只想自己编个包试试：给 KS（keystore 文件，口令 KS_PASS，默认 android），装不上正式版之上，但能单独装。
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-$ROOT/gateway}
F=/data/user/0/li.dsh.claudecli/files
B=$F/bldtools
KEY=${KEY:-$B/cccodroid-release.json}
P=$F/toolchain/dshtc/prefix
J=$P/lib/jvm/java-17-openjdk/bin
CC_ANDROID=${CC_ANDROID:-cc4}
JAVAC=${JAVAC:-"env LD_LIBRARY_PATH=$P/lib $J/javac"}
D8=${D8:-"env LD_LIBRARY_PATH=$P/lib $J/java -cp $P/share/java/d8.jar com.android.tools.r8.D8"}
AAPT2=${AAPT2:-"env LD_LIBRARY_PATH=$P/lib $P/bin/aapt2"}
AJAR=${ANDROID_JAR:-$P/framework/android.jar}
SIGN=${SIGN:-apklib}
A=$ROOT/android
OUT=$ROOT/dist
[ -n "$KS" ] || [ -f "$KEY" ] || { echo "✗ 找不到签名钥匙 $KEY（不会自动生成：换钥匙会让已装用户无法升级）"; exit 1; }

echo "▸ assets"
rm -rf "$A/assets/app"; mkdir -p "$A/assets/app/web" "$A/assets/app/scripts" "$A/assets/app/bin"
cp "$SRC/server.mjs" "$A/assets/app/"
for f in "$SRC/web/"*; do case "$f" in *.bak*) ;; *) cp -R "$f" "$A/assets/app/web/";; esac; done
cp "$A/assets/scripts/"* "$A/assets/app/scripts/"
cp "$A/assets/bin/"* "$A/assets/app/bin/"
mkdir -p "$A/assets/app/pre"; cp "$A/assets/pre/"* "$A/assets/app/pre/"     # pkg / apt：PATH 最前，压过工具包里的旧替身
cp "$A/assets/TOOLS.md" "$A/assets/app/"     # 给 claude 的工具说明（网关读进系统提示）
# 工具包下载地址（Release 目录，按序尝试）。测试时可用 DEVKIT_BASES="http://… https://…" 覆盖
if [ -n "$DEVKIT_BASES" ]; then echo "$DEVKIT_BASES" | tr " " "\n" > "$A/assets/devkit-sources.txt"
else cp "$ROOT/devkit-sources.txt" "$A/assets/devkit-sources.txt"; fi
[ -s "$A/assets/devkit-sources.txt" ] || { echo "✗ devkit-sources.txt 为空（/sdcard 的 FUSE 有时报过时的大小 0，cp 会拷出空文件：rm 后重写源文件）"; exit 1; }
echo "  工具包来源：$(tr "\n" " " < "$A/assets/devkit-sources.txt")"
# 绑定那一版的清单（首装从镜像下、认本地文件时以它为准）。必须和 devkit-sources.txt 的第一个地址是同一版
DK_BASE=$(head -1 "$A/assets/devkit-sources.txt")
if [ -n "$DEVKIT_BASES" ]; then node "$ROOT/scripts/pin-devkit.mjs" "$DK_BASE" "$A/assets/devkit-pin.json" || exit 1
else cp "$ROOT/devkit-pin.json" "$A/assets/devkit-pin.json"; fi
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(p.base!==process.argv[2]){console.error("✗ devkit-pin.json 是 "+p.base+"，devkit-sources.txt 是 "+process.argv[2]+"：跑 node scripts/pin-devkit.mjs 重新生成");process.exit(1)}' "$A/assets/devkit-pin.json" "$DK_BASE" || exit 1
# 原生小库：seccomp 拦截 → ENOSYS（不依赖 libc，见源码注释）。Android 14 上没有它 claude 起不来
mkdir -p "$A/assets/app/lib"
$CC_ANDROID -O2 -shared -fPIC -nostdlib -fno-stack-protector -Wl,-z,noexecstack -Wl,--hash-style=both \
  -o "$A/assets/app/lib/seccomp-enosys.so" "$A/native/seccomp-enosys.c"
# 同一条思路的「从进程外面」版本：静态二进制挂不上 --preload，只好用 ptrace 做同一件事。
# 这个是**可执行文件**不是库，所以不用 -nostdlib（它自己就是被启动的那个进程，可以正常链 libc）。
# 入口包装在 assets/bin/enosys-run
$CC_ANDROID -O2 -o "$A/assets/app/lib/seccomp-enosys-run" "$A/native/seccomp-enosys-run.c"
# 应用内终端的伪终端（node 没有 pty）：stdin/stdout 与 pty 对转，fd 3 收窗口大小
$CC_ANDROID -O2 -o "$A/assets/app/lib/ptyhost" "$A/native/ptyhost.c"
TAG=$(cat "$A/assets/app/server.mjs" "$A/assets/app/TOOLS.md" $(find "$A/assets/app/web" -type f | sort) "$A/assets/app/scripts/"* "$A/assets/app/bin/"* "$A/assets/app/pre/"* "$A/assets/app/lib/"* | md5sum | cut -c1-12)
echo "$TAG" > "$A/assets/app/TAG"
echo "  tag $TAG"

# 第三方库：Shizuku-API 13.1.5（MIT，Maven Central 原样，sha1 已核）
LIBS=$(ls "$ROOT"/third_party/shizuku/*.jar | tr '\n' ':')
echo "▸ javac"
rm -rf "$A/build"; mkdir -p "$A/build/classes"
$JAVAC -encoding UTF-8 --release 8 -nowarn \
  -cp "$AJAR:$LIBS" -d "$A/build/classes" $(find "$A/java" -name '*.java')

echo "▸ d8"
$D8 --release --min-api 26 \
  --lib "$AJAR" --output "$A/build" $(find "$A/build/classes" -name '*.class') "$ROOT"/third_party/shizuku/*.jar

echo "▸ aapt2 + 签名"
mkdir -p "$OUT"
$AAPT2 compile --dir "$A/res" -o "$A/build/res.zip"
$AAPT2 link -o "$A/build/unsigned.apk" -I "$AJAR" \
  --manifest "$A/AndroidManifest.xml" -A "$A/assets" "$A/build/res.zip"
if [ "$SIGN" = apksigner ]; then
  # SDK 的 apksigner：先把 classes.dex 塞进包、对齐，再签（最低 API 26，它自己决定出 v2 / v3）
  ( cd "$A/build" && zip -q unsigned.apk classes.dex )
  ${ZIPALIGN:-zipalign} -p -f 4 "$A/build/unsigned.apk" "$A/build/aligned.apk"
  if [ -n "$KS" ]; then
    ${APKSIGNER:-apksigner} sign --ks "$KS" --ks-pass "pass:${KS_PASS:-android}" --out "$OUT/cccodroid.apk" "$A/build/aligned.apk"
  else
    # 钥匙 JSON → PKCS#8 DER + 证书，只在构建目录里待一下，签完就删
    trap 'rm -f "$A/build/key.pk8" "$A/build/cert.pem"' EXIT
    node -e 'const fs=require("fs"),c=require("crypto"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      fs.writeFileSync(process.argv[2],c.createPrivateKey(j.key).export({type:"pkcs8",format:"der"}),{mode:0o600});
      fs.writeFileSync(process.argv[3],j.cert)' "$KEY" "$A/build/key.pk8" "$A/build/cert.pem"
    ${APKSIGNER:-apksigner} sign --key "$A/build/key.pk8" --cert "$A/build/cert.pem" --out "$OUT/cccodroid.apk" "$A/build/aligned.apk"
  fi
  rm -f "$OUT/cccodroid.apk.idsig"
  echo "  $(du -h "$OUT/cccodroid.apk" | cut -f1)"
else
node --input-type=module -e "
import fs from 'node:fs'; import { signApk } from '$B/apklib.mjs';
const r = signApk('$A/build/unsigned.apk', '$OUT/cccodroid.apk',
  [{ name: 'classes.dex', data: fs.readFileSync('$A/build/classes.dex'), method: 8 }], '$KEY');
console.log('  ' + r.entries + ' 个条目 · ' + (r.size / 1048576).toFixed(2) + ' MB');
"
fi
echo "✓ $OUT/cccodroid.apk"
