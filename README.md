# cccodroid

**English** · [简体中文](README.zh-CN.md)

**A development launcher that runs Claude Code on Android phones.** No root, no custom ROM, no chroot / proot / VM.

Android already runs on a Linux kernel. Once the tools run natively on that kernel, a phone can do real AI-assisted development:
write code, compile C/C++, run Python / Node, build APKs and push with git — all on the phone.

> cccodroid is a third-party project and is not affiliated with Anthropic. It runs the **official, unmodified Claude Code**:
> downloaded from Anthropic's official channel at install time, verified against the official sha256 manifest, never modified.

![cccodroid runtime architecture](docs/diagrams/architecture.en.svg)

<sub>Interactive version (zoom, search, focus, path tracing): [docs/diagrams/architecture.en.html](docs/diagrams/architecture.en.html) — see [docs/diagrams](docs/diagrams/README.md).</sub>

## Features

- **Official Claude Code with a GUI**: chat, streaming output, thinking, tool calls, file browser, session history.
  - Messages sent while Claude is working wait at the end of the chat marked *Queued*; **Send now** delivers one into the running turn without interrupting it. **Stop only stops** — queued messages are paused, never sent automatically.
  - `/compact`, `/context` and other built-in commands show their results immediately.
  - UI in 8 languages: 简体中文, English, Français, Español, Русский, العربية (RTL), 日本語, 한국어.
- **Several ways to connect**:
  - Sign in with a Claude account inside the app; after authorizing in the browser you are brought back automatically.
  - Claude API key.
  - The official Anthropic-compatible endpoints of DeepSeek, Zhipu GLM, Qwen and Kimi.
  - Any other compatible third-party endpoint you add.
- **A complete development toolchain** (about 200 components, taken from the official [Termux](https://termux.dev) repositories):
  - C/C++: clang 21 / lld, make / cmake / ninja, gdb / strace.
  - Languages: Python 3.14 (pip, venv), Node 26 (npm, npx).
  - Android builds: OpenJDK 21, aapt2 / d8 / apksigner — build APKs on the phone.
  - VCS and network: git, ssh, curl.
  - CLI tools: rg / fd / bat / jq / sqlite3 / typst / ImageMagick…
- **System privileges (optional)**: [Shizuku](https://shizuku.rikka.app) integration. In the terminal, `priv '<cmd>'` runs pm / am / settings / logcat / screencap… as the shell user.
  - One-tap install and activation from Settings: downloaded from Shizuku's official release (signing certificate verified), installed with the system installer,
    then activated over Wireless debugging — no computer needed. The pairing code is entered in a notification that stays at the top of the screen, so the pairing dialog stays open.
  - After a reboot, cccodroid turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- **Automatic updates** (on by default; can be turned off or triggered manually in Settings):
  - Claude Code: silent updates from the official channel (stable / latest); running conversations are not affected.
  - cccodroid itself: downloaded, signature-checked, then offered for install; installed silently when idle if Shizuku is available.
  - Toolchain: pre-downloaded on Wi‑Fi only and swapped in the next time the app opens; anything you installed with pip / npm -g is kept.
- **USB debugging of another device**: connect it with an OTG cable and run `usb-adb`, then `adb devices / install / shell` as usual.
- **Self-test**: `cccodroid-selftest` exercises 71 tools and usages; the tool notes are injected into Claude's system prompt so it knows what it has.

## Install

1. Download `cccodroid.apk` from [Releases](https://github.com/greyoak111/cccodroid/releases) and install it.
2. Open the app. The first launch automatically:
   - downloads the toolchain (about 600 MB, resumable, sha256-verified, then unpacked);
   - downloads Claude Code from Anthropic's official channel (about 230 MB).
3. Choose how to connect in Settings: sign in with a Claude account, or enter an API key.
4. (Optional) Install and start Shizuku, then grant it in Settings to enable `priv` and stronger keep-alive.

Requirements: Android 8.0+ (tested on Android 14 / 15), arm64, about 4 GB free space.

**Allow background running on vendor ROMs**: some vendors' power savers ignore foreground services and freeze the whole app in the background
(measured on RedMagic: frozen about 90 s after leaving the foreground), stopping any running task. When cccodroid detects a freeze during a running task, Settings tells you exactly where to fix it.
RedMagic / ZTE: App info → App battery usage → Battery optimization → **Background running: Allow**, **Auto-start: Allow**.

**Offline install**: put `devkit-cc.codroid.tar.gz` in `/sdcard/cccodroid/`; the first launch uses it instead of downloading.

## How it works

```
cccodroid.apk (Java shell: installer + foreground service + WebView)
  ├─ files/usr/      toolchain: official Termux packages, run natively after same-length prefix relocation
  ├─ official Claude Code (linux-arm64 glibc build, unmodified binary)
  │     └─ started by the toolchain's glibc loader with --preload of a tiny seccomp library
  └─ gateway gateway/server.mjs (Node): runs claude, event stream, queue, provider config → UI gateway/web/
```

- **Same-length prefix relocation**: Termux binaries have `/data/data/com.termux/` baked in at build time. The package name `cc.codroid` has exactly the same 10 characters as `com.termux`, so a byte-for-byte replacement fixes every RUNPATH, shebang and config path — no `LD_LIBRARY_PATH`, wrapper scripts or binary patching. Entries inside zip / jmod archives are rewritten too. See [devkit/README.md](devkit/README.md).
- **seccomp**: Android installs a syscall allow-list on app processes and kills anything outside it with SIGSYS. Android 14 does not allow `epoll_pwait2`, so Claude Code would be killed at startup. [`seccomp-enosys.c`](android/native/seccomp-enosys.c) turns such calls into ENOSYS so programs take their own fallback path; `enosys-run` does the same from outside (ptrace) for static binaries.
- **Gateway access control**: the gateway listens on 127.0.0.1 only, and every `/api/*` request must carry a 256-bit token from the app's private directory; Host and Origin are checked as well. Other apps and web pages on the phone cannot drive it.
- **Credentials**: account sign-in is done by Claude Code itself. The gateway only hands the authorization URL to the system browser; it never reads, stores or relays claude.ai credentials. Third-party API keys live in the app's private directory and reach claude through `apiKeyHelper`, never through environment variables.

## Build

```sh
sh scripts/build.sh          # javac → d8 → aapt2 → sign, produces dist/cccodroid.apk
node devkit/devkit.mjs build --target cc.codroid   # build the toolchain (CI can do this too)
```

`build.sh` currently runs on the author's Android device and relies on the JDK, d8, aapt2, GCC and signing tools there. Paths are at the top of the script; adjust them to build elsewhere.

The toolchain is built and published by GitHub Actions: push a tag like `devkit-YYYY.MM.DD` (see [.github/workflows/devkit.yml](.github/workflows/devkit.yml)).
Which toolchain version the app downloads is set in [devkit-sources.txt](devkit-sources.txt).

Layout:

| Directory | Contents |
|---|---|
| `android/` | Java shell, Manifest, resources, terminal helpers (`assets/bin/`), native libraries (`native/`) |
| `gateway/` | Gateway and UI (currently sourced from the author's other repository and synced by `scripts/sync-shared.sh`) |
| `devkit/` | Toolchain build script and manifests |
| `docs/diagrams/` | Architecture diagrams (Archify JSON specs → interactive HTML → static SVG) |
| `third_party/` | Shizuku-API 13.1.5 (MIT, unmodified from Maven Central) |

## License

cccodroid itself is released under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)).

### Third-party components

- **Claude Code**: proprietary software by Anthropic, **not distributed with this project**. Its use is subject to [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).
- **Toolchain**: taken from the official Termux repositories; each component is distributed under its own license (including GPL). Versions, hashes and build recipes are in the `devkit.lock.json` / `SBOM.tsv` attached to each release. If you need a copy of the source, ask in Issues.
- **Shizuku-API**: MIT, see [third_party/shizuku/LICENSE](third_party/shizuku/LICENSE).
- **xz-decompress** (used at toolchain build time): MIT.
- **`android.jar`** is not shipped (its license forbids redistribution); download it yourself if you want to compile APKs on the phone.
