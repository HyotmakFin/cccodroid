# 运行环境：cccodroid（安卓上原生运行，不是 chroot / proot / 虚拟机）

- 安卓 aarch64，无 root；你以本应用的普通 uid 运行。开发工具来自 Termux 官方仓库，已改写为本应用的路径，前缀 `$PREFIX`。
- 工作区 `{{WORKSPACE}}`（应用私有目录）：在这里建项目、编译、运行。
- `{{SHARED}}` 是与其他应用交换文件的共享目录：交付给用户的文件（APK、图片、文档）拷到这里，用户在文件管理器里能看到。
  共享存储（/sdcard 下）**不能执行程序、不能建符号链接、npm install 会失败** —— 别在那里编译或装依赖。从那里拷出的文件没有可执行位，要 `chmod +x`。
- 临时文件用 `$TMPDIR`；`/tmp` 不可写。
- 安卓没有 `/usr/bin/env`、`/bin/bash`，但 shell 已加载 termux-exec：`#!/usr/bin/env node|python3`、`#!/bin/bash` 的脚本照常直接执行。
- **没有 pkg / apt**（Termux 仓库的包路径写死，装进来跑不了）。缺系统级工具就如实告诉用户；Python / Node 的库照常用 pip / npm 装。

## 可用工具（cccodroid-selftest 逐项实测）

- **C/C++**：`cc`/`c++`/`clang`/`clang++` 21（`gcc` 也指向 clang），lld，C++20 可用。**只能动态链接**：没有静态 libc，别用 `-static`。产物由 `/system/bin/linker64` 加载，库在 `$PREFIX/lib`、头文件在 `$PREFIX/include`。
- **构建**：make、cmake（默认 Makefile，`-G Ninja` 亦可）、ninja、pkg-config；`./configure` 这类脚本可直接跑。
- **调试**：gdb（可 run / bt）、strace、patchelf。
- **Python 3.14**：ssl、sqlite3、ctypes 可用。装库用 `pip install --user <包>`（或在 venv 里装）；`python3 -m venv <目录>` 建出的环境自带 pip。带 C 扩展的包会现场用 clang 编译，较慢。
- **Node 26 + npm 11**：npm install、npx、`node_modules/.bin` 均可（项目要放在工作区，不能放 /sdcard）。
- **Java / 安卓构建**：openjdk-21（java、javac、jar、keytool），aapt2、d8、apksigner。没有自带 `android.jar`（Android SDK 平台包需用户自行下载，许可不允许随包分发）。
- **版本控制与网络**：git（https / ssh）、curl、openssl、ssh、ssh-keygen。
- **命令行工具**：rg、fd、bat、delta、hx、jq、yq、sqlite3、typst、duckdb、magick（ImageMagick）、man、file、tar、xz、zstd、zip / unzip。
- **Claude Code** 本身：终端里 `claude` 命令可用。

## 系统权限：priv

需要 pm / am / settings / dumpsys / logcat / screencap / input 之类的系统能力时，用 `priv '<命令>'`：经 Shizuku 以 shell 身份（uid 2000）执行，标准输入、输出与退出码都照常传递；`priv -- 程序 参数…` 不经 sh 直接执行。
先 `priv --status` 看是否可用：没装 / 没启动 / 没授权 Shizuku 时如实告诉用户去 cccodroid 设置页处理，别反复重试。

## 出问题时

工具表现异常先跑 `cccodroid-selftest -q`（只列失败项），再据此判断，别凭印象认定"安卓上不行"。

**如果第三方程序只有一行 `SIGSYS: bad system call` 就死**，套一层 `enosys-run`：

```sh
enosys-run <程序> [参数...]
enosys-run -v <程序> ...        # 打印每次拦截，确认是不是这个原因
```

原因是安卓 seccomp 拦了白名单外的系统调用 —— 动态链接的程序由 `seccomp-enosys.so`
兜住，**静态二进制（Go CLI 居多：gh / lazygit / kubectl / terraform…）挂不上 `--preload`**，
所以要用这个命令从外面做同样的事（ptrace，**不改动目标程序**）。

判断特征：**同一个程序里有的子命令崩、有的正常** —— 比如 `gh api` 一直好使而
`gh pr create` 必崩（前者不查找可执行文件，后者要找 `git`）。别据此以为"只是个别命令有 bug"。

**如果刚编出来的程序一跑就 `Illegal instruction`（退出码 132）**，先看是不是用了 `-march=native` / `-mcpu=native`：

```sh
clang -O2 -march=native prog.c          # ✗ 编译器生成 SVE 指令，本机执行必崩
clang -O2 -mcpu=native+nosve prog.c     # ✓ 保留原生调优，只是不用 SVE
clang -O2 -march=armv8.6-a+dotprod+i8mm+bf16 prog.c   # ✓ 显式基线
```

骁龙 8 Gen 3 的核都是 Armv9，clang 按 CPU 型号就认定有 SVE2。它确实也读了 `/proc/cpuinfo`，
但 `llvm::sys::getHostCPUFeatures()` 只会把「看到的」特性置为开，**从不把「没看到的」置为关**，
于是型号自带的 SVE2 就留了下来。这台机器上内核报的能力到处都是「没有」：
Features 行里没有 `sve`，`HWCAP_SVE` 是 0，EL0 能读到的 `ID_AA64PFR0_EL1` 里 SVE 段也是 0。

**不止 `native`：`-mcpu=cortex-x4` / `cortex-a720` / `cortex-a520`、`-march=armv9-a` / `armv9.2-a`
同样会开 SVE，一样崩。**

上游已在 LLVM 22 修复（[`9458d2a0f403`](https://github.com/llvm/llvm-project/commit/9458d2a0f403)，PR #176340），
release/21.x 没有回溯，本应用自带的 clang 21.1.8 在这个修复之前 —— 工具链升到 22+ 之后这段可以删掉。

确认是不是它：`gdb -batch -ex run -ex 'x/i $pc' ./程序`，若停在 `index z0.s, #0, #1` 这类
带 `z` 寄存器的指令、或 `ptrue` / `whilelt` 上，就是 SVE。
