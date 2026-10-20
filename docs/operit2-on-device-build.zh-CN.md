# 案例：在 cccodroid 里从源码构建 Operit2（Flutter + Rust）APK

[English](operit2-on-device-build.md)

2026-10-20，在一台 Android arm64 设备上，用 cccodroid 从源码完整构建了 [Operit2](https://github.com/AAswordman/Operit2)，得到可安装、可启动的 arm64 release APK。整个过程没有电脑、没有 root、没有云 CI，全部在本机完成。

这不是 cccodroid 的内置功能，而是一次边界测试：它同时用到了 glibc 与 bionic 两套运行时、Android NDK 交叉编译、Rust 目标构建、Flutter AOT、proot、qemu 用户态模拟和 SELinux 规避。把经过写下来，是因为其中大部分坑与具体项目无关——凡是“在手机上编译另一个大型项目”，都可能再遇到。

## 1. 结果

| 项目 | 结果 |
|---|---|
| 产物 | Operit2 2.0.0 arm64-v8a release APK |
| 大小 | 129,228,721 字节（约 129.2 MB） |
| 包名 / versionCode | `app.operit` / 2021 |
| SDK | minSdk 24，targetSdk 36，compileSdk 36 |
| 签名 | V2，构建者自建证书 |
| 构建耗时 | 最后一次完整构建约 22 分钟（Rust 约 5 分钟，qemu 下的 AOT 约 15 分钟） |
| 启动验证 | 冷启动成功，Flutter 渲染首启页与用户协议页，logcat 无 error/exception/fatal |

## 2. 为什么这件事不简单

| 层面 | 冲突 |
|---|---|
| 宿主 | Flutter/Dart 官方 Linux 工具是 glibc 二进制；Android 是 bionic |
| 交叉编译 | 官方 NDK、CMake 只提供 x86_64 主机工具；设备是 arm64 |
| 项目 | Flutter 前端 + Rust 核心 + 自带终端运行时（proot/bash/rootfs） |
| AOT | Android arm64 的 `gen_snapshot` 只有 x86_64 版，且必须与引擎的目标特性完全匹配 |
| 系统 | SELinux 会拦截部分文件操作，图形/安装链路也有额外限制 |

## 3. 环境

### 3.1 两层运行时

最终采用“两层”结构：

1. **proot-distro 的 Ubuntu 26.04 arm64 容器（glibc）**：运行 Flutter/Dart 官方 Linux 工具，以及官方 Linux-aarch64 CMake。
2. **cccodroid 自带的 Termux 工具（bionic）**：Java 21、clang、Rust、Node、Python、aapt2、ninja 等，通过 proot 绑定注入容器。

只用其中一层都不够：Ubuntu 里没有可用的 Android 构建工具（apt 在该容器里还遇到 TLS 证书问题），而 bionic 环境又跑不了 Flutter 的 glibc 宿主工具。

### 3.2 进入构建环境

proot 只会暴露显式绑定的路径。实际使用的登录命令：

```sh
P=/data/user/0/cc.codroid/files/usr
W=/data/user/0/cc.codroid/files/home/workspace

proot-distro login ubuntu --shared-tmp \
  -b /system:/system \
  -b /apex:/apex \
  -b $P:/data/data/cc.codroid/files/usr \
  -b $P:/data/user/0/cc.codroid/files/usr \
  -b $W:/workspace -- /bin/bash -lc '<命令>'
```

- `/system` 与 `/apex` 必须绑定：bionic 程序的 `/system/bin/linker64` 实际指向 `/apex/com.android.runtime/bin/linker64`，缺了会报 “required file not found”。
- 容器内的项目路径统一用 `/workspace/...`。写宿主机路径（`/data/user/0/...`）时，有些进程能打开、有些工具（尤其 clang）会静默看不到，表现为莫名其妙的链接错误。

### 3.3 版本

| 工具 | 版本 |
|---|---|
| cccodroid devkit | Java 21.0.12、clang 21.1.8、Rust 1.99.1、Node 26.4.0、Python 3.14.6、aapt2 16.0.0.4、ninja 1.13.2 |
| proot-distro / Ubuntu | 5.10.0 / Ubuntu 26.04.1 LTS arm64 |
| Flutter | 3.41.10-ohos（引擎固定为 stock `42d3d75a56efe1a2e9902f52dc8006099c45d937`） |
| Dart | 3.11.5 |
| Android SDK | build-tools 35.0.0，compileSdk 36 |
| NDK | 28.2.13676358（r28c） |
| CMake | 3.31.6（官方 Linux-aarch64） |
| qemu | qemu-user-x86-64 11.1.2 |

## 4. 缺口与补齐

| # | 缺口 | 根因 | 处理 |
|---|---|---|---|
| 1 | 没有 glibc 构建宿主 | Flutter/Dart 官方工具是 glibc | 用 proot-distro 安装 Ubuntu 26.04 arm64；apt 失败后改为绑定 Termux 工具 |
| 2 | OHOS 分支的引擎产物不可用 | 产物按 OHOS 引擎版本取，只有 x64 的 Dart SDK | 把引擎版本统一改回 stock 42d3，并从 `storage.googleapis.com` 取官方产物；给 `linux-sdk`、`desktop_compiler` 做本地缓存桩，避免工具反复下载桌面引擎 |
| 3 | 三个 ohos 插件依赖拉不下来 | 依赖指向 Gitee，匿名 clone 要认证 | 用 Gitee API 按文件拉取到 `thirdparty/flutter_packages_ohos`，pubspec 改为本地 path 依赖 |
| 4 | 官方 Dart 没有 `Abi.ohos*` | fluttertpc 的 hooks/code_assets/jni 引用了 OHOS 枚举 | 在 pub-cache 对应文件里删除 ohos ABI 条目 |
| 5 | 没有 Android SDK | 设备上原本没有 | 下载 commandline-tools，接受 licenses；装 build-tools、platforms、NDK |
| 6 | NDK 工具是 x86_64 | 官方 NDK 只带 x86_64 主机工具 | 用 wrapper 把 `aarch64-linux-android21..35-clang`、`llvm-*` 转发给 Termux clang，并注入 NDK sysroot |
| 7 | wrapper 用了 proot 里不可见的路径 | 见 3.2 | 全部改成 `/workspace/...` |
| 8 | clang 21 驱动 + clang 19 头文件冲突 | NDK 自带 clang 19 的 `arm_neon.h` 被 clang 21 解析 | 建合并资源目录：头文件用 clang 21，库用 NDK clang 19 |
| 9 | CMake 无法执行 | AGP 装的 CMake 3.22.1 是 x86_64；Termux CMake 又报告 `CMAKE_HOST_SYSTEM_NAME=Android`，NDK 算不出主机标签 | SDK 的 `cmake` 换成官方 Linux-aarch64 CMake 3.31.6 的 wrapper；`ninja` 换成 Termux ninja |
| 10 | CMake 编译器探测链接失败 | clang 21 把 `-static-libstdc++` 翻成 `-Bstatic -lc++_shared`，NDK 只有共享版 | 在 NDK sysroot 放一份 `libc++_shared.a`（内容同 `libc++_static.a`） |
| 11 | Rust 桥接链接失败 | 构建脚本用 android clang；Termux rust 的 host triple 也是 android，build script 同样按目标链接，缺 crt 与 `-lunwind` | 由 wrapper 统一注入 `--sysroot` 与合并 `-resource-dir`；Gradle 设 `CC_/AR_/CARGO_TARGET_…_LINKER` 与 `OPERIT_LIBCLANG_DIR` |
| 12 | 终端运行时没有现成产物 | 需要交叉编译 bash/busybox/proot/loader | 按目标 ABI 编译出四个 `.so`；`ashmem_memfd.c` 补 `#include <string.h>` |
| 13 | Alpine rootfs 构建失败 | TLS 证书缺失；apk-tools 3.x 用 `O_TMPFILE` + `linkat(/proc/self/fd/…)` 写数据库，被 Android SELinux 拒绝 | 换 http 镜像并拷入 CA；改用 apk-tools-static 2.14.4（命名临时文件）；修目录权限后固定 mtime 重新打包 |
| 14 | 插件打包工具缺失 | 需要 TypeScript 与 pnpm 依赖 | 装 typescript 5.9.3；在 workflow 包目录执行 `pnpm install --frozen-lockfile` |
| 15 | Gradle/AGP 环境 | 需要固定 Gradle、aapt2、JVM 参数与签名 | Gradle wrapper 指向本地发行版；`android.aapt2FromMavenOverride` 指向 cccodroid 自带 aapt2；调 JVM 内存与 worker 数；生成本地 keystore |
| 16 | **AOT 快照目标错误** | 桌面 Linux-arm64 的 `gen_snapshot` 生成 `arm64 linux no-compressed-pointers`，Android 引擎要求 `arm64 android compressed-pointers` | 用官方 x86_64 Android `gen_snapshot` + `qemu-user-x86-64` + x86_64 Ubuntu rootfs 生成；替换 `linux-arm64/gen_snapshot` 为 qemu wrapper；清掉旧构建缓存 |
| 17 | Gradle daemon 中途消失 | AOT 收尾阶段 daemon 被杀（无 hs_err，内存充足） | kernel dill 已缓存，直接重跑；AOT 重跑约 15 分钟后成功 |
| 18 | 安装被 SELinux 拦住 | system_server 不能读 /sdcard（FUSE） | shell 先复制到 `/data/local/tmp`，再从那里 `pm install` |

## 5. 四个关键根因

### 5.1 proot 的路径可见性

proot 只暴露绑定路径。任何脚本、wrapper、环境变量里如果写了宿主机路径，在容器内可能“看起来存在”但目标进程打不开。**统一写 `/workspace/...`**，可以省掉一整轮“编译通过、链接报缺 crt”的排查。

### 5.2 clang 驱动与资源目录必须同源

clang 21 的驱动配 clang 19 的 `include`，会在 NEON 等内置头文件上报 `incompatible constant for this __builtin_neon function`；配 clang 19 的 `lib` 则能正常链接 NDK 的 `libunwind.a` 和 `crt*.o`。最终做法：

```sh
NDK=/workspace/dl/android-ndk-r28c
mkdir -p /workspace/dl/clang-merged
ln -s /data/data/cc.codroid/files/usr/lib/clang/21/include /workspace/dl/clang-merged/include
ln -s $NDK/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/19/lib /workspace/dl/clang-merged/lib
```

所有 NDK wrapper 加 `-resource-dir=/workspace/dl/clang-merged`。

另外，`-static-libstdc++` 在 clang 21 下会变成 `-Bstatic -lc++_shared`，需要 `libc++_shared.a` 兜底：

```sh
SYS=$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android
cp -n "$SYS/libc++_static.a" "$SYS/libc++_shared.a"
```

### 5.3 gen_snapshot 必须匹配 Android 目标

这是唯一一个“所有步骤都成功、装上也起不来”的坑。Flutter 的 AOT 产物要用对应目标平台的 `gen_snapshot` 生成；桌面 Linux-arm64 版本生成的是：

```
product … arm64 linux no-compressed-pointers
```

而 Android arm64 引擎要求：

```
product … arm64 android compressed-pointers
```

不仅目标 OS 不同，**指针压缩模式**也不同，运行时必然拒绝加载。检查方法：

```sh
head -c 1200 libapp.so | strings -n 20 | grep -o "product .*pointers"
```

解决办法是使用官方 Android 构建产物里的 x86_64 `gen_snapshot`（`android-arm64-release/linux-x64/gen_snapshot`），通过 qemu 运行：

```sh
#!/data/data/cc.codroid/files/usr/bin/bash
unset LD_PRELOAD
exec /data/data/cc.codroid/files/usr/bin/qemu-x86_64 \
  -L /workspace/dl/amd64-rootfs \
  /workspace/flutter-sdk/bin/cache/artifacts/engine/android-arm64-release/linux-x64/gen_snapshot "$@"
```

x86_64 rootfs 用 Ubuntu base amd64 解压即可。qemu 下 AOT 约 15 分钟、单核跑满、内存约 450 MB，属正常。

### 5.4 Flutter 构建缓存按配置哈希分目录

AOT 产物在 `.dart_tool/flutter_build/<hash>/arm64-v8a/app.so`。换了 `gen_snapshot` 后，如果只删 `build/`，构建系统仍可能复用旧快照。要么删掉对应 hash 目录，要么整目录删掉重编；kernel dill 可以保留以节省时间。

## 6. 复现步骤

以下步骤以本文记录时的版本为准；上游变化后需要重新确认。

### 6.1 准备

```sh
# Java/clang/Rust/Node/Python/CMake/Ninja/aapt2 由 cccodroid 的 devkit 自带，
# 先确认命令可用即可，不必重复安装，以免覆盖工具包里的版本。
pip install proot-distro
proot-distro install ubuntu
pkg install --unverified qemu-user-x86-64
```

Android SDK 需要 build-tools 35.0.0、platforms;android-36、NDK 28.2.13676358。SDK 与 NDK 都放在 `$HOME/workspace` 下（容器内可见为 `/workspace`）。

### 6.2 NDK wrapper

以 API 23 为例（其余 API 同理）：

```sh
#!/data/data/cc.codroid/files/usr/bin/bash
exec /data/data/cc.codroid/files/usr/bin/clang \
  --target=aarch64-linux-android23 \
  --sysroot=/workspace/dl/android-ndk-r28c/toolchains/llvm/prebuilt/linux-x86_64/sysroot \
  -resource-dir=/workspace/dl/clang-merged "$@"
```

`llvm-ar`、`llvm-ranlib`、`llvm-strip` 等也换成转发到 Termux 同名工具的脚本（注意先 `rm -f`，NDK 里这些名字可能是符号链接）。

### 6.3 CMake wrapper

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

原因见上表第 9 项：Flutter 的 Gradle 插件会强行给 app 挂一个空 CMake 工程来触发 NDK 下载，所以即使项目没有 C++，也必须让 CMake 可用。

### 6.4 项目侧改动

Operit2 自己的适配（细节见其仓库）：

- `pubspec.yaml` 的三个 ohos 依赖改为本地 path；
- Flutter SDK 引擎版本统一为 stock 42d3，并准备本地缓存桩；
- pub-cache 里删除 `Abi.ohos*` 引用；
- `apps/flutter/app/android/local.properties` 写入 `flutter.sdk`、`sdk.dir` 与签名四项。

### 6.5 构建脚本

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

### 6.6 构建链路

1. 插件打包：tsc + pnpm；
2. Rust 核心约 500 个 crate 交叉编译到 `aarch64-linux-android`；
3. Flutter frontend_server 生成 kernel dill；
4. qemu 中的官方 Android `gen_snapshot` 生成 `libapp.so`；
5. AGP：aapt2、Java/Kotlin、D8、合并 native libs、打包、zipalign、签名。

## 7. 验证

### 7.1 产物静态校验

```sh
APK=build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
unzip -p $APK lib/arm64-v8a/libapp.so | head -c 1200 | strings -n 20 | grep -o "product .*pointers"
apksigner verify --print-certs $APK
unzip -p $APK assets/android-runtime/arm64-v8a/rootfs.tar.gz.bin | sha256sum
```

### 7.2 安装与启动

SELinux 不允许 system_server 读 /sdcard，安装时要中转：

```sh
priv 'cp /sdcard/cccodroid/app.apk /data/local/tmp/app.apk'
priv 'pm install -r /data/local/tmp/app.apk'
priv 'am start -W -n app.operit/.MainActivity'
```

实测冷启动 518 ms，Flutter 渲染出首启页与用户协议页，logcat 无 error/exception/fatal。

## 8. 经验清单

- **proot 内一律写 `/workspace/...`**，不要把宿主机路径写进 wrapper。
- **clang 驱动与资源目录同源**：头文件与库可以拆开，但要明确知道自己在拆什么。
- **AOT 快照必须校验特性串**，不要只看构建成功；`linux` 与 `android`、指针压缩与否都不兼容。
- **换工具后清构建缓存**：Flutter 按配置哈希分目录，删 `.dart_tool/flutter_build` 最稳。
- **AOT 15 分钟不是卡死**：qemu 用户态模拟单核跑满、约 450 MB 内存。
- **daemon 消失先重试**：kernel 与 cargo 缓存都在，重跑通常只补最后一步。
- **SELinux 是常见拦路虎**：`O_TMPFILE` 硬链接、system_server 读 /sdcard 都会被拒；前者换 apk-tools 2.14.4，后者走 `/data/local/tmp`。
- **签名钥匙要留住**：升级必须同钥匙，否则只能卸载重装。
- **别在 /sdcard 上编译**：共享存储不能执行程序、不能建符号链接，依赖安装也会失败。

## 9. 边界

这是一次性案例记录，不是 cccodroid 的官方构建支持。版本、脚本路径和上游项目结构都可能变化；照做前先确认各组件版本，并自建签名密钥，不要把别人的密钥或口令写进仓库。
