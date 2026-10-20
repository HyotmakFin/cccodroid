# cccodroid

**English** · [简体中文](README.zh-CN.md) · [Discussions](https://github.com/greyoak111/cccodroid/discussions) · [Contributing](CONTRIBUTING.md)

**A development launcher that runs Claude Code on Android phones.** No root, no custom ROM, no chroot / proot / VM.

Android already runs on a Linux kernel. Once the tools run natively on that kernel, a phone can do real AI-assisted development:
write code, compile C/C++, run Python / Node, build APKs and push with git — all on the phone.

> cccodroid is a third-party project and is not affiliated with Anthropic. It runs the **official, unmodified Claude Code**:
> downloaded from Anthropic's official channel at install time (or, when that is unreachable, the identical file Anthropic publishes on npm, via a mirror), verified against the official sha256 manifest, never modified.

## Why

When you use AI on a phone and the model needs to actually do something (run code, edit files, build a package), the work usually goes to a cloud sandbox, and the phone is just a screen.
cccodroid brings execution back to your own device: the cloud does model inference, while your code, files and toolchain stay local, the environment persists across sessions, and the agent can reach the device itself.
The approach is not tied to one agent — any command-line AI agent that runs on Linux arm64 can be brought to a phone the same way.

See **[Design philosophy](docs/design-philosophy.md)**.

## Features

- **Official Claude Code with a GUI**: chat, streaming output, thinking, tool calls, file browser, session history.
  - Messages sent while Claude is working wait at the end of the chat marked *Queued*; **Send now** delivers one into the running turn without interrupting it. **Stop only stops** — queued messages are paused, never sent automatically.
  - `/compact`, `/context` and other built-in commands show their results immediately.
  - Each reply shows a live generation timer that settles to the total time when it finishes.
  - Light / dark appearance, or follow the system (status bar included); the launch screen, first-run setup screen and in-app browser follow it too. Warm palette, with the CC Mono monospace font in the UI and terminal.
  - Your messages sit on the right and replies span the width, as in the desktop app. Tool calls between two pieces of reply text fold into one "N steps" line; tap to see each step. Groups with a pending approval or a failure open by themselves. Under each reply: **Copy** (the raw Markdown) and **Share** (system share sheet).
  - **Built-in help** (sidebar → Help): a full user guide and advanced tips, with a table of contents, in Chinese and English.
  - **Tablets in landscape and unfolded foldables**: depending on the window width, the layout becomes two columns (chat plus a workspace on the right) or three (plus a docked sidebar). Files, the viewer, the terminal and the in-app browser open on the right without covering the chat, and you can drag the divider between them. Phones in portrait and narrow split screens look the same as before.
  - **Work survives the background**: you get a system notification when a turn finishes or Claude is waiting for your approval. It shows no heads-up banner. The notification only offers *Deny* and *Open*; to allow a command you have to return to the app and read it in full. If the system kills the app, reopening it marks the unfinished turn as *Interrupted* with a *Continue* button, and queued messages are still there.
  - **Session management**: deleted sessions go to a recycle bin first (restorable for 30 days). Pick sessions one by one or all at once and export them as a zip — save it anywhere with the system *Save to* picker, or share it directly — then import the zip on another device and carry on where you left off.
  - **Terminal** (top bar): a real terminal with tabs, running the same bash and toolchain Claude uses — hx (Helix), less, top, git and the rest. A row of extra keys supplies what phone keyboards lack (Esc, Tab, sticky Ctrl / Alt, arrows, Home / End, PgUp / PgDn, paste, font size); a text view lets you long-press to select and copy output. Terminals keep running when you close the panel and replay their output when you come back.
  - **File viewer / editor** (from the file browser): edit text and code and save — if the file changed on disk after you opened it (say Claude edited it), you are asked before anything is overwritten. Markdown renders with an edit toggle; images open fit-to-screen and tap to 1:1; PDFs render with [pdf.js](https://mozilla.github.io/pdf.js/) (CJK text and password-protected files included), pages drawn only as they scroll into view.
  - A **↓ button** appears when you scroll up through a long chat; tap it to jump to the latest message. A dot on it means new output arrived meanwhile.
  - **Paths in replies are links**: tap an absolute path such as `/storage/emulated/0/…/report.pdf` (or `file.js:12`) and it opens in the viewer; a folder opens in the file browser. Claude is told to write full paths so this always works. Tool cards that read or write a file get a ↗ button too.
  - **In-app browser** (globe in the top bar): web links in replies open inside the app — handy for checking a dev server at `http://127.0.0.1:<port>/`. On wide screens it opens in the workspace on the right, next to the chat. It uses the system WebView, so it adds no download. Sign-in pages still go to your normal browser.
  - UI in 9 languages: 简体中文, 繁體中文, English, Français, Español, Русский, العربية (RTL), 日本語, 한국어.
- **Optional components** (Extensions → Optional components): large tools that don't ship with the app; download them only if you need them. Each build matches a specific toolchain release, is checked against its SHA-256 and a per-file manifest before anything is installed, and uninstalls cleanly.
  - **Browser component (headless Chromium 155)**, about 254 MB to download and 750 MB installed: lets Claude open pages headlessly — screenshots, PDF export, the rendered DOM, and scripted browsing with puppeteer-core. It comes with a skill that tells Claude how to use it.
  - **Community components** from the [cccodroid-components](https://github.com/greyoak111/cccodroid-components) repository. There are currently 17, including GitHub CLI (gh), Cloudflare (wrangler), Blender (headless compositing and rendering, 3D on the GPU), Godot (headless runs, APK export), LibreOffice (headless document conversion), LilyPond (music engraving), a music production toolchain (MIDI to audio, synthesis, mastering), llama.cpp (local LLM inference), OpenSCAD, ngspice / gnucap (circuit simulation), Icarus Verilog / Yosys (digital design), a Snapdragon GPU driver (Vulkan / OpenGL / OpenCL) and GPU benchmarks. See the [full list](https://github.com/greyoak111/cccodroid-components#components). Indexes are ed25519-signed and rejected if they do not check out; community components are labelled as such, and builds nobody has verified on a real device ask first.
- **Several ways to connect**:
  - Sign in with a Claude account inside the app; after authorizing in the browser you are brought back automatically. The account card shows your 5-hour and weekly usage limits with their reset times (taken from what Claude Code itself reports after each turn — the app never queries anything with your credentials).
  - Claude API key.
  - The official Anthropic-compatible endpoints of DeepSeek, Zhipu GLM, Qwen and Kimi.
  - Any other compatible third-party endpoint you add.
- **A complete development toolchain** (about 250 packages, taken from the official [Termux](https://termux.dev) repositories):
  - C/C++: clang 21 / lld, make / cmake / ninja, gdb / strace.
  - Languages: Python 3.14 (pip, venv), Node 26 (npm, npx).
  - Android builds: OpenJDK 21, aapt2 / d8 / apksigner — build APKs on the phone.
  - VCS and network: git, ssh, curl.
  - Audio and video: ffmpeg 9 (x264 / x265 / VP9 / AV1 / Opus…) with hardware encoding on the phone (`h264_mediacodec` / `hevc_mediacodec`), more than 3× faster than software encoding.
  - CLI tools: rg / fd / bat / jq / sqlite3 / typst / ImageMagick… Tab completion works in interactive bash; `hx-grammar` installs just the Helix syntax grammars you need; typst finds the system CJK fonts out of the box.
- **System privileges (optional)**: [Shizuku](https://shizuku.rikka.app) integration. In the terminal, `priv '<cmd>'` runs pm / am / settings / logcat / screencap… as the shell user.
  - One-tap install and activation from Settings: downloaded from Shizuku's official release (signing certificate verified), installed with the system installer,
    then activated over Wireless debugging — no computer needed. The pairing code is entered in a notification that stays at the top of the screen, so the pairing dialog stays open.
  - After a reboot, cccodroid turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- **Automatic updates** (on by default; can be turned off or triggered manually in Settings):
  - Claude Code: silent updates from the official channel (stable / latest); running conversations are not affected.
  - cccodroid itself: downloaded, signature-checked, then offered for install; installed silently when idle if Shizuku is available.
  - Toolchain: pre-downloaded on Wi‑Fi only and swapped in the next time the app opens; anything you installed with pip / npm -g is kept.
  - Updates never cut each other off: while the toolchain is downloading or being replaced, the app update waits. The replacement is checked against the release manifest before the old toolchain is touched, and if it is interrupted (app restart, process killed) the next launch finishes it or rolls back.
  - **Verify / Repair** in Settings checks every toolchain file against its recorded hash; Repair reinstalls the same version and keeps your own packages. A quick check also runs at each launch.
- **Extensions**: install, enable, disable and uninstall Claude Code plugins (search the official directory or add other marketplaces), install skills from a zip, and add or remove MCP servers — all from the Extensions tab. Everything goes through Claude Code’s own `claude plugin` / `claude mcp` commands; a plugin that needs to run a command to install shows it to you first.
- **Troubleshooting**:
  - **Safe mode**: if a hook, plugin, MCP server or CLAUDE.md breaks things, turn on safe mode and Claude Code starts with its built-in `--safe-mode` — no customizations loaded, while sign-in, keys, sessions and model stay as they are. Nothing is moved or edited; turning it off restores everything.
  - **I'm stuck · bundle diagnostics** (in Settings, and on the install-failure screen): diagnostics, the app log, the gateway log and the repair ledger, packed into a zip and handed to the system share sheet. Before packing, you see a list of what goes in. Keys, tokens, email addresses and the content of your messages to Claude are scrubbed first, and conversation transcripts are not included.
  - **Plain-language first-install errors**: the app checks free space before downloading and tells you how much it needs. Failures such as being offline, rate limiting or a checksum mismatch are explained in plain words. *Retry* resumes from what was already downloaded.
  - **Repair ledger**: every toolchain install, verification, repair and startup recovery is recorded (what was found, what was done, the result) and can be read in Settings.
  - **Known issues**: problems not yet fully explained or ruled out, and what we know about each, are listed in [docs/known-issues.md](docs/known-issues.md).
- **USB debugging of another device**: connect it with an OTG cable and run `usb-adb`, then `adb devices / install / shell` as usual.
- **Self-test**: `cccodroid-selftest` exercises 73 tools and usages (including ffmpeg and a hardware-encoding probe); the tool notes are injected into Claude's system prompt so it knows what it has.

## Install

1. Download `cccodroid.apk` from [Releases](https://github.com/greyoak111/cccodroid/releases) and install it.
2. Open the app. The first launch automatically:
   - downloads the toolchain (about 650 MB, resumable, sha256-verified, then unpacked);
   - downloads Claude Code from Anthropic's official channel (about 230 MB).
3. Choose how to connect in Settings: sign in with a Claude account, or enter an API key.
4. (Optional) Install and start Shizuku, then grant it in Settings to enable `priv` and stronger keep-alive.

Requirements: Android 8.0+, arm64, about 4 GB free space.

Tested devices: Lenovo TB320FC (Snapdragon 8+ Gen 1, Android 15) and Red Magic 9 Pro NX769J (Snapdragon 8 Gen 3, Android 14, installed from scratch following this section). Non-Snapdragon chips and Android 12 / 13 have not been tested on real hardware yet; reports are welcome.

Versions with a suffix (such as `v0.2.0-rc1`) are pre-releases. In-app updates only offer stable releases; download pre-releases from Releases by hand.

**Allow background running on vendor ROMs**: some vendors' power savers ignore foreground services and freeze the whole app in the background
(measured on RedMagic: frozen about 90 s after leaving the foreground), stopping any running task. When cccodroid detects a freeze during a running task, Settings tells you exactly where to fix it.
RedMagic / ZTE: App info → App battery usage → Battery optimization → **Background running: Allow**, **Auto-start: Allow**.

**Offline install**: put `devkit-cc.codroid.tar.gz` in `/sdcard/cccodroid/`; the first launch uses it instead of downloading.

**Versions**: v0.3.0 is the first stable release. 0.3.x updates only fix problems; new features go into the next version series.

## Community and contributing

- **Questions, ideas, device reports**: [GitHub Discussions](https://github.com/greyoak111/cccodroid/discussions), in English or Chinese. There is also a Chinese-speaking QQ group, 1062538743.
- **Bugs**: in the app, tap Settings → Report on GitHub; your device and self-test results are filled in for you.

**cccodroid is maintained by one person and badly needs help.** Device reports, translation fixes, component recipes, docs and code are all welcome, and you can help without writing code. See the [contributing guide](CONTRIBUTING.md).

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/cccodroid-architecture.en-dark.png">
  <img alt="cccodroid architecture: the user works in the UI (a WebView running app.js), which talks to the Node gateway on 127.0.0.1 over HTTP and SSE; the gateway is started and restarted by the GatewayService foreground service, reads and writes sessions, settings and its token under home/, reaches Shizuku through the Priv relay over a local socket, and drives the official Claude Code over stream-json; Claude Code calls the model API over HTTPS and runs the devkit toolchain through its Bash tool; the Updater / Installer downloads from GitHub Releases and downloads.claude.ai and installs or upgrades Claude Code; the component manager downloads the ed25519-signed index and packages from the component market, installs them into the devkit and copies each component skill into ~/.claude/skills, where Claude Code picks it up and learns the new tools" src="docs/diagrams/cccodroid-architecture.en-light.png">
</picture>

Interactive version (guided views, light/dark, export): download [`docs/diagrams/cccodroid-architecture.en.html`](docs/diagrams/cccodroid-architecture.en.html) and open it in a browser;
the source is `cccodroid-architecture.en.json` in the same directory, with every component tied to the source lines it describes. Generated with [Archify](https://github.com/tt-a1i/archify).

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
- **Credentials**: account sign-in is done by Claude Code itself. The gateway hands the authorization URL to the system browser and never reads or stores claude.ai credentials; it does not handle the one-time authorization code either (see [Terms and compliance](#terms-and-compliance)). Third-party API keys live in the app's private directory and reach claude through `apiKeyHelper`, never through environment variables.

## Terms and compliance

cccodroid aims to follow [Anthropic's terms for products that run Claude Code](https://code.claude.com/docs/en/legal-and-compliance). Below is exactly what the app does, so you can judge for yourself:

- **How the binary runs.** The Claude Code file is byte-for-byte the official linux-arm64 build: checked against the official sha256 manifest and never patched. Android has no `/lib/ld-linux-aarch64.so.1`, so it is started through the toolchain's glibc loader, with a 61-line preload library ([`seccomp-enosys.c`](android/native/seccomp-enosys.c)) that turns system calls Android's seccomp filter forbids into ENOSYS. The library does not read or change Claude Code's code or memory; it only keeps the process from being killed.
- **Signing in with a Claude subscription.** Sign-in is Claude Code's own `claude auth login`. You authorize on Anthropic's page in your browser, Claude Code writes the token to its own `~/.claude/.credentials.json` (the app never reads that file), and while signed in Claude Code talks to api.anthropic.com directly, not through any process of ours. In practice this is the same as SSHing into a Linux machine you own, running Claude Code there and signing in: here the Linux machine is the phone, and the app is the screen and keyboard. Every turn is a message you send yourself; the app has no scheduled or unattended runs. Anthropic's terms cover this case explicitly: they do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- **The one-time authorization code.** Normally the browser hands the code back to Claude Code automatically, on this device, without passing through the app. If that fails (for example you authorized on another device), the app opens its built-in terminal and runs `claude auth login` there; you paste the code into Claude Code's own prompt. The terminal is a generic byte channel, like Termux or SSH; the app has no field that accepts the code and never parses, saves or logs it.
- **Permission prompts.** Like the official CLI, Claude asks before editing files, running commands or going online, and you answer in the chat. The default mode is "Ask each time"; "Allow everything" is available but asks for confirmation first.
- **The name.** cccodroid stands for "Claude Code CLI On droid", modelled on the long-standing Android C/C++ IDE C4droid. The project does not use the Claude or Anthropic names or logos in its name, icon or package name, and does not claim to be made, endorsed or partnered with by Anthropic. If Anthropic asks, the project will be renamed.
- **No resale, no middleman.** cccodroid is free and open source, has no server, and does not provide, pay for or resell any Claude usage: you sign in with your own account or bring your own API key, and usage is billed to you directly. The author has a Claude Console account and has accepted Anthropic's Commercial Terms, which the terms above require for products that run Claude Code.

## Build

```sh
sh scripts/build.sh          # javac → d8 → aapt2 → sign, produces dist/cccodroid.apk
node devkit/devkit.mjs build --target cc.codroid   # build the toolchain (CI can do this too)
```

**No setup needed**: GitHub Actions builds an APK for every pull request and every push to main; download it from that run's Artifacts (see [.github/workflows/apk.yml](.github/workflows/apk.yml)). Builds from main are signed with the release key and install over the released app. Pull requests from forks are signed with a throwaway test key, so you have to uninstall the released app first; a spare device is best.

To build on your own machine, install JDK 17, Node.js, the Android SDK (build-tools and a platform) and the NDK, then set the environment variables described at the top of `build.sh`. `apk.yml` is a working example. The script's default tool paths point at the author's Android tablet.

Release signing certificate SHA-256: `B7:03:61:59:5D:D3:D8:D7:04:DD:21:0E:D5:96:FC:57:70:14:CE:22:72:88:4F:B6:98:0B:F6:96:23:33:8F:E0`.

The toolchain is built and published by GitHub Actions: push a tag like `devkit-YYYY.MM.DD` (see [.github/workflows/devkit.yml](.github/workflows/devkit.yml)).
Which toolchain version the app downloads is set in [devkit-sources.txt](devkit-sources.txt). The size and SHA-256 of that version live in [devkit-pin.json](devkit-pin.json), which ships inside the APK: the first install (from GitHub, the cccodroid.net mirror, or a local file) and the check on local files both trust it rather than the download source. When you switch versions, edit the former, run `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`, and commit both; `build.sh` checks that they match.

Layout:

| Directory | Contents |
|---|---|
| `android/` | Java shell, Manifest, resources, terminal helpers (`assets/bin/`), native libraries (`native/`) |
| `gateway/` | Gateway (`server.mjs`, Node.js) and UI (`web/`, plain JS, no build step) |
| `i18n/` | UI translations: one txt per language plus the generate and check scripts, see [i18n/README.md](i18n/README.md) |
| `devkit/` | Toolchain build script and manifests |
| `docs/design-philosophy.md` | Why the project exists and the principles behind it |
| `docs/large-screen.md` | Large-screen layout (tablets, foldables) and where its code lives |
| `docs/known-issues.md` | Known issues and unresolved risks, plus test actions that create fake bugs |
| `docs/download-sources.md` | Every download chain: sources, trust anchors, server mirrors, how to check and maintain them |
| `docs/operit2-on-device-build.md` | Case study: building Operit2 (Flutter + Rust) from source into an APK on a phone, with every gap and fix |
| `docs/diagrams/` | Architecture diagrams (Archify JSON specs → interactive HTML → light / dark PNG) |
| `third_party/` | Shizuku-API 13.1.5 (MIT, unmodified from Maven Central) |

## Special thanks

- **[DeepSeek Harness for Android](https://github.com/woaiys3/deepseek-harness-android-app)** (woaiys3): running AI agents on a phone without root, elevating through Shizuku, keeping alive with a foreground service — it walked these paths first. cccodroid's early exploration and development happened inside the environment it built; that Claude Code runs on Android the way it does today rests on the foundation laid by it and its author.
- **[Archify](https://github.com/tt-a1i/archify)** (tt-a1i, MIT): the architecture diagram above was made with it and passed its layout checks; license in [ThirdPartyLicenses/Archify](ThirdPartyLicenses/Archify/LICENSE).
- **[Termux](https://termux.dev)**: the toolchain is assembled from its official packages.
- **[Shizuku](https://shizuku.rikka.app)** (RikkaApps): system privileges without root.
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js): the Traditional Chinese UI strings were converted with it, then reviewed by hand.

### Community contributors

- **[CCB-Fox](https://github.com/CCB-Fox)**: the Dimensity GPU driver component ([cccodroid-components#46](https://github.com/greyoak111/cccodroid-components/pull/46)), which led to Mali support in 0.3.3.
- **[Cosmosophius](https://github.com/Cosmosophius)**: a thorough Dimensity 9300 report ([cccodroid-components#47](https://github.com/greyoak111/cccodroid-components/issues/47)).

Reports, device testing and code review are contributions too, and they're recorded here.

## License

cccodroid itself is released under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)).

### Third-party components

- **Claude Code**: proprietary software by Anthropic, **not distributed with this project**. Its use is subject to [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).
- **Toolchain**: taken from the official Termux repositories; each component is distributed under its own license (including GPL). Versions, hashes and build recipes are in the `devkit.lock.json` / `SBOM.tsv` attached to each release. If you need a copy of the source, ask in Issues.
- **Shizuku-API**: MIT, see [third_party/shizuku/LICENSE](third_party/shizuku/LICENSE).
- **xz-decompress** (used at toolchain build time): MIT.
- **[xterm.js](https://xtermjs.org)** (terminal): MIT, see [ThirdPartyLicenses/xterm.js](ThirdPartyLicenses/xterm.js/LICENSE).
- **[pdf.js](https://mozilla.github.io/pdf.js/)** (PDF viewer): Apache-2.0; its bundled OpenJPEG / JBIG2 / QCMS decoders carry their own licenses. See [ThirdPartyLicenses/pdf.js](ThirdPartyLicenses/pdf.js/).
- **CC Mono** (monospace font for the UI and terminal): a subset of [Monaspace Neon](https://github.com/githubnext/monaspace) by GitHub, SIL OFL 1.1, renamed as the Reserved Font Name clause requires. See [ThirdPartyLicenses/ccmono](ThirdPartyLicenses/ccmono/LICENSE).
- **`android.jar`** is not shipped (its license forbids redistribution); download it yourself if you want to compile APKs on the phone.
