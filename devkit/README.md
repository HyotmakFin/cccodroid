# devkit：开发工具包（全部来自官方开源仓库）

这个目录负责把启动台的**基础开发工具**组装成一个 tar，交给 App 解到自己的 `files/` 下运行。
每个组件都能查到出处：版本、哈希、构建配方链接都记在锁文件和 SBOM 里。

## 来源

| 部分 | 来源 | 处理方式 |
|---|---|---|
| 145 个包：clang/lld/cmake/ninja/make、git/ssh、gdb/strace、python、node+npm、JDK 21、aapt2/d8/apksigner、bash/coreutils/grep/sed/awk、rg/fd/bat/delta/helix/yq/jq/sqlite… | [Termux 官方仓库](https://packages.termux.dev)，构建配方开源：[termux-packages](https://github.com/termux/termux-packages) | 构建时下载，校验哈希，**原样**打进 tar，只做前缀改写（见下） |
| `android.jar`（编译 APK 用的平台存根） | Google 官方 SDK 仓库 `platform-36_r02.zip` | **不入包**，许可协议不允许再分发。由用户在设备上自行下载并同意许可，与 Claude Code 本体同样处理 |

**不再使用的：** C4droid 的 GCC 和原 `dshtc/prefix` 里的那批工具，全部被上表取代。

## 为什么能"原样"运行：等长前缀改写

Termux 的程序在编译时把前缀 `/data/data/com.termux/` 写死了，ELF 里是定长槽位。
只要我们的包名**恰好 10 个字符**（和 `com.termux` 一样长），就能逐字节等长替换：

```
/data/data/com.termux/  →  /data/data/li.dsh.dkt/
```

RUNPATH、shebang、配置文件路径一次全部改对。**不需要 `LD_LIBRARY_PATH`、不需要包装脚本、不需要二进制补丁。**
这一版改写了 1651 个文件里的 4977 处。

> ⚠️ **所以发布版 App 的包名必须是 10 个字符。** 测试用的是 `li.dsh.dkt`。

## 用法

```sh
node devkit.mjs resolve [--groups core,build]                 # 只看依赖闭包和体积
node devkit.mjs build --target <10字符包名> [--groups ...]     # 产出 out/devkit-<包名>.tar
```

产物：

- `out/devkit-<包名>.tar`：App 解到 `files/` 下即可。解完后跑一次 `usr/libexec/devkit/first-run.sh`
- `devkit.lock.json`：每个包的版本、文件名、SHA256、配方链接，加上仓库快照时间
- `SBOM.tsv`：同上，表格形式

分组见 `devkit.json`：基础包是 `core build vcs lang android cli`，共 145 个包，下载约 300 MB，解包后约 1.3 GB。
`extra` 组（typst、duckdb、imagemagick）依赖很重，作为选装。

## 构建时做的事（devkit.mjs）

1. **校验索引**：取 `Release`，用它核对 `Packages.gz` 的 SHA256。InRelease 的 GPG 签名暂未验证，见 TODO。
2. **求依赖闭包**：包括 Provides 虚包；`a | b` 取第一个能满足的。
3. **下载**：用 curl，大包分 4 MB 块、8 路并行。整包哈希不对时，换镜像逐块复核，按两个来源一致选块。
4. **解包**：先用 JS 解出 xz 这一个包来自举，之后全部用原生 xz 解压。全量构建约 1 分钟（有缓存时）。
5. **改写**：重写 tar 里的路径、文件内容、软链接目标。
6. **处理 postinst**：
   - 解析 `update-alternatives`，按优先级生成 java/javac/keytool、pager、editor 等链接；
   - 其余步骤（dbus machine-id、glib schema、ssh 目录等）收进 `first-run.sh`。

## 实测（2026-10-13，Adreno 730 平板，以 `li.dsh.dkt` 身份运行）

全部原生运行，没有任何包装：

- **编译**：clang 21 编 C/C++20；cmake + ninja；gdb 断点 + bt
- **语言与网络**：python 3.14（ssl/sqlite）；`git clone` 走 https；`npm install`
- **APK 全链**：aapt2 → javac 21 → d8 → zip → keytool → apksigner（v2+v3）→ 装机启动成功

## 测试工具

- `runner/`：测试 App `li.dsh.dkt`。以它的身份执行命令，输出写回 `run/`
- `dkt.sh '<命令>' [超时]`：从外面驱动它（需要 priv）。第一次用前要授权存储：`pm grant li.dsh.dkt android.permission.{READ,WRITE}_EXTERNAL_STORAGE`
- `ctl.mjs`：列出缓存里各 .deb 的维护脚本

## TODO

- [ ] 验证 InRelease 的 GPG 签名（Termux 仓库公钥），而不只是走 HTTPS
- [ ] SBOM 补许可证列：从配方的 `TERMUX_PKG_LICENSE` 抓取。另外有些包的配方在 `x11-packages/` 或 `root-packages/` 下，链接要修正
- [ ] JDK 21 拖进了 x11/pulseaudio（它是完整 JDK）。看能否换 headless 方案减重
- [ ] App 侧：解包 + first-run + 外部依赖（android.jar）的下载与许可确认界面
- [ ] 换掉旧工具链之后，原来的 `cc4`/`cxx4`/`mk4`、glibc DNS 补丁、shell 槽位补丁就都不需要了
