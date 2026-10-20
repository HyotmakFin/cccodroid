# Case study: building Operit2 (Flutter + Rust) from source on a phone with cccodroid

[中文](operit2-on-device-build.zh-CN.md)

On 2026-10-20, a complete from-source build of [Operit2](https://github.com/AAswordman/Operit2) was done on an Android arm64 device with cccodroid, producing an installable arm64 release APK that also launched successfully. No PC, no root, no cloud CI — everything ran on the device.

This is not a built-in cccodroid feature; it is a boundary test. The build exercised two runtimes (glibc and bionic), Android NDK cross-compilation, Rust target builds, Flutter AOT, proot, user-mode qemu, and SELinux workarounds. It is written down because most of the pitfalls are not specific to this project: anyone compiling another large project on a phone is likely to meet them again.

## 1. Result

| Item | Result |
|---|---|
| Artifact | Operit2 2.0.0 arm64-v8a release APK |
| Size | 129,228,721 bytes (~129.2 MB) |
| Package / versionCode | `app.operit` / 2021 |
| SDK | minSdk 24, targetSdk 36, compileSdk 36 |
| Signing | V2, builder-generated certificate |
| Build time | ~22 minutes for the last full build (~5 min Rust, ~15 min AOT under qemu) |
| Launch check | Cold start OK; Flutter rendered the first-run and agreement pages; logcat showed no error/exception/fatal |

## 2. Why this is not trivial

| Layer | Conflict |
|---|---|
| Host | Flutter/Dart official Linux tools are glibc binaries; Android is bionic |
| Cross-compilation | The official NDK and CMake ship x86_64 host tools only; the device is arm64 |
| Project | Flutter front end + Rust core + its own terminal runtime (proot/bash/rootfs) |
| AOT | The Android arm64 `gen_snapshot` exists only as an x86_64 binary, and its target features must match the engine exactly |
| System | SELinux blocks some file operations; installation and graphics have extra constraints |

## 3. Environment

### 3.1 Two runtimes

The final setup used two layers:

1. **A proot-distro Ubuntu 26.04 arm64 container (glibc)** to run the official Flutter/Dart Linux tools and an official Linux-aarch64 CMake.
2. **cccodroid's bundled Termux tools (bionic)** — Java 21, clang, Rust, Node, Python, aapt2, ninja — injected into the container through proot binds.

Neither layer alone is enough: the Ubuntu container has no usable Android build tools (apt also hit TLS certificate failures there), while the bionic environment cannot run Flutter's glibc host tools.

### 3.2 Entering the build environment

proot only exposes explicitly bound paths. The login command used was:

```sh
P=/data/user/0/cc.codroid/files/usr
W=/data/user/0/cc.codroid/files/home/workspace

proot-distro login ubuntu --shared-tmp \
  -b /system:/system \
  -b /apex:/apex \
  -b $P:/data/data/cc.codroid/files/usr \
  -b $P:/data/user/0/cc.codroid/files/usr \
  -b $W:/workspace -- /bin/bash -lc '<command>'
```

- `/system` and `/apex` must be bound: on bionic, `/system/bin/linker64` really points at `/apex/com.android.runtime/bin/linker64`; without the bind you get "required file not found".
- Inside the container, always use `/workspace/...` for project paths. Host paths (`/data/user/0/...`) may be openable by some processes and silently invisible to others — especially clang — which shows up as baffling link errors.

### 3.3 Versions

| Tool | Version |
|---|---|
| cccodroid devkit | Java 21.0.12, clang 21.1.8, Rust 1.99.1, Node 26.4.0, Python 3.14.6, aapt2 16.0.0.4, ninja 1.13.2 |
| proot-distro / Ubuntu | 5.10.0 / Ubuntu 26.04.1 LTS arm64 |
| Flutter | 3.41.10-ohos (engine pinned to stock `42d3d75a56efe1a2e9902f52dc8006099c45d937`) |
| Dart | 3.11.5 |
| Android SDK | build-tools 35.0.0, compileSdk 36 |
| NDK | 28.2.13676358 (r28c) |
| CMake | 3.31.6 (official Linux-aarch64) |
| qemu | qemu-user-x86-64 11.1.2 |

## 4. Gaps and how they were filled

| # | Gap | Root cause | Fix |
|---|---|---|---|
| 1 | No glibc build host | Flutter/Dart official tools are glibc binaries | Installed Ubuntu 26.04 arm64 with proot-distro; after apt failed, bound Termux tools into the container instead |
| 2 | The OHOS branch's engine artifacts were unusable | Artifacts are fetched for the OHOS engine revision, and only an x64 Dart SDK exists | Pinned the engine back to stock 42d3 and used Google's official artifacts; stubbed the `linux-sdk` and `desktop_compiler` caches so the tool would stop trying to download desktop engines |
| 3 | Three ohos plugin dependencies could not be fetched | They point at Gitee and anonymous clones require auth | Pulled files through the Gitee API into `thirdparty/flutter_packages_ohos`, then switched pubspec to path dependencies |
| 4 | Stock Dart has no `Abi.ohos*` | fluttertpc hooks/code_assets/jni reference OHOS ABI values | Removed the ohos ABI entries from the corresponding pub-cache files |
| 5 | No Android SDK | None was installed on the device | Downloaded commandline-tools, accepted licenses, installed build-tools, platforms and NDK |
| 6 | NDK tools are x86_64 | The official NDK only ships x86_64 host tools | Wrapped `aarch64-linux-android21..35-clang` and `llvm-*`, forwarding to Termux clang with the NDK sysroot |
| 7 | Wrappers used paths invisible inside proot | See 3.2 | Rewrote everything to `/workspace/...` |
| 8 | clang 21 driver vs clang 19 headers | NDK's clang 19 `arm_neon.h` is parsed by clang 21 | Built a merged resource directory: headers from clang 21, libraries from NDK clang 19 |
| 9 | CMake would not run | AGP's bundled CMake 3.22.1 is x86_64; Termux CMake reports `CMAKE_HOST_SYSTEM_NAME=Android`, so the NDK toolchain cannot derive a host tag | Replaced the SDK `cmake` with a wrapper to official Linux-aarch64 CMake 3.31.6; replaced `ninja` with Termux ninja |
| 10 | CMake compiler probe failed to link | clang 21 translates `-static-libstdc++` into `-Bstatic -lc++_shared`, but the NDK only has the shared library | Added a `libc++_shared.a` copy (same contents as `libc++_static.a`) to the NDK sysroot |
| 11 | Rust bridge failed to link | Build scripts use android clang; Termux Rust's host triple is also android, so build scripts link for the target too, missing crt and `-lunwind` | Wrappers inject `--sysroot` and the merged `-resource-dir`; Gradle sets `CC_/AR_/CARGO_TARGET_…_LINKER` and `OPERIT_LIBCLANG_DIR` |
| 12 | No prebuilt terminal runtime | bash/busybox/proot/loader had to be cross-compiled | Built four `.so` files; added `#include <string.h>` to `ashmem_memfd.c` |
| 13 | Alpine rootfs build failed | Missing TLS certs; apk-tools 3.x writes its database with `O_TMPFILE` + `linkat(/proc/self/fd/…)`, which Android SELinux denies | Switched to an http mirror and copied in a CA bundle; used apk-tools-static 2.14.4 (named temp files); fixed permissions and repacked with a fixed mtime |
| 14 | Plugin packaging tools missing | TypeScript and pnpm dependencies were needed | Installed typescript 5.9.3; ran `pnpm install --frozen-lockfile` in the workflow package |
| 15 | Gradle/AGP environment | Needed a pinned Gradle, aapt2, JVM settings and signing | Pointed the wrapper at a local Gradle distribution; set `android.aapt2FromMavenOverride` to cccodroid's aapt2; tuned JVM memory and worker count; generated a local keystore |
| 16 | **Wrong AOT snapshot target** | The desktop Linux-arm64 `gen_snapshot` emits `arm64 linux no-compressed-pointers`, while the Android engine requires `arm64 android compressed-pointers` | Used the official x86_64 Android `gen_snapshot` under `qemu-user-x86-64` with an x86_64 Ubuntu rootfs; replaced `linux-arm64/gen_snapshot` with a qemu wrapper; cleared the stale build cache |
| 17 | Gradle daemon disappeared mid-build | The daemon was killed near the end of AOT (no hs_err, memory was plentiful) | The kernel dill was cached, so a rerun only redid AOT (~15 min) and succeeded |
| 18 | Install blocked by SELinux | system_server cannot read /sdcard (FUSE) | Copied the APK to `/data/local/tmp` as shell, then ran `pm install` from there |

## 5. Four root causes worth remembering

### 5.1 Path visibility inside proot

proot only exposes bound paths. If a script, wrapper, or environment variable uses a host path, it may "look present" inside the container while the target process cannot open it. **Use `/workspace/...` consistently** and you save an entire debugging cycle of "compiles fine, link says crt is missing".

### 5.2 The clang driver and its resource directory must agree

A clang 21 driver with clang 19 `include` fails on builtin headers such as NEON with `incompatible constant for this __builtin_neon function`; with clang 19 `lib` it links the NDK's `libunwind.a` and `crt*.o` fine. The final layout:

```sh
NDK=/workspace/dl/android-ndk-r28c
mkdir -p /workspace/dl/clang-merged
ln -s /data/data/cc.codroid/files/usr/lib/clang/21/include /workspace/dl/clang-merged/include
ln -s $NDK/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/19/lib /workspace/dl/clang-merged/lib
```

Every NDK wrapper adds `-resource-dir=/workspace/dl/clang-merged`.

Also, under clang 21, `-static-libstdc++` becomes `-Bstatic -lc++_shared`, so a `libc++_shared.a` fallback is needed:

```sh
SYS=$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android
cp -n "$SYS/libc++_static.a" "$SYS/libc++_shared.a"
```

### 5.3 gen_snapshot must match the Android target

This is the one pitfall where every step succeeds and the app still refuses to start. Flutter AOT output must come from the `gen_snapshot` built for the target platform. The desktop Linux-arm64 binary produces:

```
product … arm64 linux no-compressed-pointers
```

while the Android arm64 engine requires:

```
product … arm64 android compressed-pointers
```

It is not just the target OS: the **pointer compression mode** differs too, so the runtime necessarily rejects it. To check:

```sh
head -c 1200 libapp.so | strings -n 20 | grep -o "product .*pointers"
```

The fix is the official x86_64 `gen_snapshot` from the Android artifacts (`android-arm64-release/linux-x64/gen_snapshot`), run through qemu:

```sh
#!/data/data/cc.codroid/files/usr/bin/bash
unset LD_PRELOAD
exec /data/data/cc.codroid/files/usr/bin/qemu-x86_64 \
  -L /workspace/dl/amd64-rootfs \
  /workspace/flutter-sdk/bin/cache/artifacts/engine/android-arm64-release/linux-x64/gen_snapshot "$@"
```

The x86_64 rootfs is just an extracted Ubuntu base amd64 tarball. AOT under qemu takes about 15 minutes, pins one core, and uses about 450 MB of RAM — that is normal.

### 5.4 Flutter build caches are split by configuration hash

AOT output lives at `.dart_tool/flutter_build/<hash>/arm64-v8a/app.so`. After changing `gen_snapshot`, deleting only `build/` may leave the old snapshot in place. Delete the matching hash directory, or the whole directory, to force a rebuild; the kernel dill can be kept to save time.

## 6. Reproduction steps

These steps reflect the versions at the time of writing; re-check after upstream changes.

### 6.1 Preparation

```sh
# Java/clang/Rust/Node/Python/CMake/Ninja/aapt2 are bundled with cccodroid's
# devkit. Just confirm the commands work; reinstalling may override the
# devkit's pinned versions.
pip install proot-distro
proot-distro install ubuntu
pkg install --unverified qemu-user-x86-64
```

The Android SDK needs build-tools 35.0.0, platforms;android-36 and NDK 28.2.13676358. Put both the SDK and NDK under `$HOME/workspace` so they appear as `/workspace` inside the container.

### 6.2 NDK wrappers

For API 23 (repeat for the other API levels):

```sh
#!/data/data/cc.codroid/files/usr/bin/bash
exec /data/data/cc.codroid/files/usr/bin/clang \
  --target=aarch64-linux-android23 \
  --sysroot=/workspace/dl/android-ndk-r28c/toolchains/llvm/prebuilt/linux-x86_64/sysroot \
  -resource-dir=/workspace/dl/clang-merged "$@"
```

Replace `llvm-ar`, `llvm-ranlib`, `llvm-strip`, etc. with scripts forwarding to the Termux tools of the same name (do `rm -f` first; some NDK names are symlinks).

### 6.3 CMake wrappers

```sh
# android-sdk/cmake/3.22.1/bin/cmake
#!/data/data/cc.codroid/files/usr/bin/bash
exec /workspace/dl/cmake-3.31.6-linux-aarch64/bin/cmake "$@"
```

```sh
# android-sdk/cmake/3.22.1/bin/ninja
#!/data/data/cc.codroid/files/usr/bin/bash
exec /data/data/cc.codroid/files/usr/bin/ninja "$@"
```

Reason: row 9 above — Flutter's Gradle plugin attaches an empty CMake project to the app to trigger the NDK download (`forceNdkDownload`), so CMake must work even when the project has no C++.

### 6.4 Project-side changes

Operit2-specific adaptations (see its repository for details):

- point the three ohos dependencies in `pubspec.yaml` at local paths;
- pin the Flutter SDK engine to stock 42d3 and provide local cache stubs;
- remove `Abi.ohos*` references from the pub cache;
- fill in `flutter.sdk`, `sdk.dir` and the four signing keys in `apps/flutter/app/android/local.properties`.

### 6.5 Build script

```sh
#!/bin/bash
export PATH=/data/data/cc.codroid/files/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export JAVA_HOME=/data/data/cc.codroid/files/usr/lib/jvm/java-21-openjdk
export FLUTTER_OHOS_STORAGE_BASE_URL=https://storage.googleapis.com
export OPERIT_LIBCLANG_DIR=/data/data/cc.codroid/files/usr/lib
export ANDROID_HOME=/workspace/android-sdk
export ANDROID_SDK_ROOT=/workspace/android-sdk
export LANG=C.UTF-8
cd /workspace/Operit2/apps/flutter/app || exit 1
exec /workspace/flutter-sdk/bin/flutter build apk --release --split-per-abi \
  --target-platform android-arm64 --build-name 2.0.0 --build-number 21
```

### 6.6 Build pipeline

1. Plugin packaging: tsc + pnpm.
2. Rust core (~500 crates) cross-compiled to `aarch64-linux-android`.
3. Flutter frontend_server produces a kernel dill.
4. The official Android `gen_snapshot` under qemu produces `libapp.so`.
5. AGP: aapt2, Java/Kotlin, D8, native-lib merge, packaging, zipalign, signing.

## 7. Verification

### 7.1 Static checks

```sh
APK=build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
unzip -p $APK lib/arm64-v8a/libapp.so | head -c 1200 | strings -n 20 | grep -o "product .*pointers"
apksigner verify --print-certs $APK
unzip -p $APK assets/android-runtime/arm64-v8a/rootfs.tar.gz.bin | sha256sum
```

### 7.2 Install and launch

SELinux prevents system_server from reading /sdcard, so stage the APK first:

```sh
priv 'cp /sdcard/cccodroid/app.apk /data/local/tmp/app.apk'
priv 'pm install -r /data/local/tmp/app.apk'
priv 'am start -W -n app.operit/.MainActivity'
```

The measured cold start was 518 ms; Flutter rendered the first-run and user-agreement pages, and logcat showed no error/exception/fatal.

## 8. Lessons

- **Inside proot, always use `/workspace/...`**; never put host paths in wrappers.
- **Keep the clang driver and resource directory consistent**: headers and libraries may be split, but know exactly what you are splitting.
- **Validate the AOT features string**, not just "build succeeded"; `linux` vs `android` and pointer compression are both fatal.
- **Clear the build cache after changing tools**: Flutter keys caches by configuration hash; deleting `.dart_tool/flutter_build` is the safe move.
- **15 minutes for AOT is not a hang**: user-mode qemu pins one core and uses about 450 MB.
- **If the daemon disappears, retry**: kernel and cargo caches remain; usually only the last step is redone.
- **SELinux is a recurring blocker**: `O_TMPFILE` hard links and system_server reading /sdcard are both denied; use apk-tools 2.14.4 for the former and `/data/local/tmp` for the latter.
- **Keep the signing key**: upgrades must use the same key, otherwise the only option is uninstall/reinstall.
- **Do not build on /sdcard**: the shared volume cannot execute programs, create symlinks, or reliably install dependencies.

## 9. Scope

This is a one-off case study, not official build support from cccodroid. Versions, script paths and upstream project layouts can change. Verify component versions before following it, generate your own signing key, and never commit someone else's key or password.
