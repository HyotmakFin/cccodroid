#!/system/bin/sh
# ─────────────────────────────────────────────────────────────────────
#  release.sh —— 发布 APK：建 GitHub Release（tag v<版本>）并上传 dist/cccodroid.apk
#
#  APK 在构建机上签名（发布钥匙不进 CI），所以 Release 也从这里建。
#  token：fine-grained，只对本仓库有 Contents 读写，放在构建机私有目录（TOKEN），绝不进仓库。
#  用法:  sh scripts/release.sh            先跑 build.sh；版本取自 AndroidManifest 的 versionName
#         NOTES=说明.md NOTES_EN=notes.en.md sh scripts/release.sh
#  说明是中英双语：中文在前，--- 之后是 ## English。NOTES_EN 缺省时英文部分只有安装与校验
#  正式版直接发；tag 带后缀（v0.2.0-beta1）的标成预发布，App 内更新检查只认正式版
# ─────────────────────────────────────────────────────────────────────
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOKEN=${TOKEN:-/data/user/0/li.dsh.claudecli/files/bldtools/gh-token-cccodroid}
REPO=greyoak111/cccodroid
APK="$ROOT/dist/cccodroid.apk"
[ -s "$TOKEN" ] || { echo "✗ 没有 token：$TOKEN"; exit 1; }
[ -s "$APK" ] || { echo "✗ 没有 $APK，先跑 build.sh"; exit 1; }
VER=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$ROOT/android/AndroidManifest.xml")
TAG="v$VER"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "✗ 工作区有未提交的改动，发布要对应一个确定的提交"; exit 1; }
DEVKIT=$(sed -n 's|.*/download/\([^/]*\)/.*|\1|p' "$ROOT/devkit-sources.txt" | head -1)
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
COMMIT=$(git -C "$ROOT" rev-parse HEAD)

[ -n "$NOTES" ] && [ -z "$NOTES_EN" ] && echo "⚠ 只给了中文说明（NOTES），没给英文（NOTES_EN）"
export TOKEN REPO TAG COMMIT SHA DEVKIT APK NOTES NOTES_EN
node --input-type=module -e '
import fs from "node:fs";
const { TOKEN, REPO, TAG, COMMIT, SHA, DEVKIT, APK, NOTES, NOTES_EN } = process.env;
const auth = { authorization: "Bearer " + fs.readFileSync(TOKEN, "utf8").trim(), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const api = async (method, url, body, extra = {}) => {
  const r = await fetch(url, { method, headers: { ...auth, ...extra }, body });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};
const read = (p) => (p ? fs.readFileSync(p, "utf8").trim() + "\n\n" : "");
const devkitLink = "[" + DEVKIT + "](https://github.com/" + REPO + "/releases/tag/" + DEVKIT + ")";
const body = "**简体中文** · [English](#english)\n\n" + read(NOTES) + [
  "### 安装",
  "下载 `cccodroid.apk` 安装。首次打开会自动下载开发工具包（约 650 MB，断点续传）与官方 Claude Code（约 230 MB）。",
  "",
  "### 校验",
  "- `cccodroid.apk` sha256：`" + SHA + "`",
  "- 配套开发工具包：[" + DEVKIT + "](https://github.com/" + REPO + "/releases/tag/" + DEVKIT + ")",
  "- 源码提交：" + COMMIT,
].join("\n") + "\n\n---\n\n## English\n\n" + read(NOTES_EN) + [
  "### Install",
  "Download and install `cccodroid.apk`. The first launch downloads the toolchain (about 650 MB, resumable) and the official Claude Code (about 230 MB).",
  "",
  "### Verification",
  "- `cccodroid.apk` sha256: `" + SHA + "`",
  "- Matching toolchain: " + devkitLink,
  "- Source commit: " + COMMIT,
].join("\n");
let rel;
try { rel = await api("GET", `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`); console.log("  已有 Release " + TAG + "，更新附件"); }
catch { rel = await api("POST", `https://api.github.com/repos/${REPO}/releases`, JSON.stringify({ tag_name: TAG, target_commitish: COMMIT, name: "cccodroid " + TAG, body, prerelease: TAG.includes("-") })); console.log("  已建 Release " + TAG); }
for (const a of rel.assets || []) if (a.name === "cccodroid.apk") await api("DELETE", a.url);
const up = rel.upload_url.replace(/\{.*\}$/, "") + "?name=cccodroid.apk";
const asset = await api("POST", up, fs.readFileSync(APK), { "content-type": "application/vnd.android.package-archive" });
console.log("  ✓ " + asset.browser_download_url + "  " + (asset.size / 1048576).toFixed(2) + " MB");
console.log("  " + rel.html_url);
'
