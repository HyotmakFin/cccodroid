#!/system/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  build.sh —— 构建 cccodroid APK（本机：javac → d8 → aapt2 → v2/v3 签名）
#
#  钥匙：发布签名钥匙在构建机私有目录（KEY），绝不进仓库。
#        换钥匙 = 用户必须卸载重装，所以它丢了就再也发不了更新 —— 要另做离线备份。
#  网关与界面的源码来自 claude-apk/src（与旧版共用一份）。
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-/sdcard/DeepSeekHarness/claude-apk/src}
F=/data/user/0/li.dsh.claudecli/files
B=$F/bldtools
KEY=${KEY:-$B/cccodroid-release.json}
P=$F/toolchain/dshtc/prefix
J=$P/lib/jvm/java-17-openjdk/bin
AJAR=$P/framework/android.jar
A=$ROOT/android
OUT=$ROOT/dist
[ -f "$KEY" ] || { echo "✗ 找不到签名钥匙 $KEY（不会自动生成：换钥匙会让已装用户无法升级）"; exit 1; }

echo "▸ assets"
rm -rf "$A/assets/app"; mkdir -p "$A/assets/app/web" "$A/assets/app/scripts" "$A/assets/app/bin"
cp "$SRC/server.mjs" "$A/assets/app/"
for f in "$SRC/web/"*; do case "$f" in *.bak*) ;; *) cp "$f" "$A/assets/app/web/";; esac; done
cp "$A/assets/scripts/"* "$A/assets/app/scripts/"
cp "$A/assets/bin/"* "$A/assets/app/bin/"
TAG=$(cat "$A/assets/app/server.mjs" "$A/assets/app/web/"* "$A/assets/app/scripts/"* "$A/assets/app/bin/"* | md5sum | cut -c1-12)
echo "$TAG" > "$A/assets/app/TAG"
echo "  tag $TAG"

# 第三方库：Shizuku-API 13.1.5（MIT，Maven Central 原样，sha1 已核）
LIBS=$(ls "$ROOT"/third_party/shizuku/*.jar | tr '\n' ':')
echo "▸ javac"
rm -rf "$A/build"; mkdir -p "$A/build/classes"
LD_LIBRARY_PATH=$P/lib $J/javac -encoding UTF-8 --release 8 -nowarn \
  -cp "$AJAR:$LIBS" -d "$A/build/classes" $(find "$A/java" -name '*.java')

echo "▸ d8"
LD_LIBRARY_PATH=$P/lib $J/java -cp $P/share/java/d8.jar com.android.tools.r8.D8 --release --min-api 26 \
  --lib "$AJAR" --output "$A/build" $(find "$A/build/classes" -name '*.class') "$ROOT"/third_party/shizuku/*.jar

echo "▸ aapt2 + 签名"
mkdir -p "$OUT"
LD_LIBRARY_PATH=$P/lib $P/bin/aapt2 compile --dir "$A/res" -o "$A/build/res.zip"
LD_LIBRARY_PATH=$P/lib $P/bin/aapt2 link -o "$A/build/unsigned.apk" -I "$AJAR" \
  --manifest "$A/AndroidManifest.xml" -A "$A/assets" "$A/build/res.zip"
node --input-type=module -e "
import fs from 'node:fs'; import { signApk } from '$B/apklib.mjs';
const r = signApk('$A/build/unsigned.apk', '$OUT/cccodroid.apk',
  [{ name: 'classes.dex', data: fs.readFileSync('$A/build/classes.dex'), method: 8 }], '$KEY');
console.log('  ' + r.entries + ' 个条目 · ' + (r.size / 1048576).toFixed(2) + ' MB');
"
echo "✓ $OUT/cccodroid.apk"
