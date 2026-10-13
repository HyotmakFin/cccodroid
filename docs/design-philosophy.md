# Design philosophy

**English** · [简体中文](design-philosophy.zh-CN.md)

## Why this exists

When you use AI on a phone today and the model needs to actually *do* something (run code, edit files, install dependencies, build a package), the work is almost always shipped off to a cloud sandbox: a temporary container somewhere else runs it and sends the result back. The phone is just a screen.

cccodroid sets out to show that **this step is not necessary.**

An Android phone already runs a Linux kernel, with a multi-core CPU, a dozen or more GB of RAM and hundreds of GB of storage. Once the tools run natively on that kernel, an AI agent can execute directly on your own device: your files, your toolchain, your network, with no third-party container in between. The cloud does model inference; execution comes home.

That means more than "you can code offline":

- **Your data stays local.** Code and files don't have to be uploaded to someone else's machine just so the AI can run them.
- **The environment persists.** Installed packages, configuration and projects are still there tomorrow; nothing is torn down when a session ends.
- **It can reach the device itself.** Build an APK and install it on the same phone, run system commands, debug another device over OTG — things a cloud sandbox cannot do.
- **Execution costs nothing extra.** It runs on hardware you already own.

## The approach is not tied to one agent

cccodroid runs the official Claude Code today, but the method underneath is general: a native toolchain, a system-call compatibility layer, a local gateway and a graphical shell. In principle, any AI agent delivered as a command-line program that runs on Linux arm64 can be brought to a phone the same way (Codex CLI or Kimi CLI, for example), and official mobile versions may well appear.

We welcome that. This project is released under Apache-2.0, and both the methods and the pitfalls are documented in this repository. If it helps make on-device execution the norm, it has done its job.

> For the record: the first commit and the first release, v0.1.0, were both published on 2026-10-13.

## Principles

Most of these were not decided up front. They were settled one at a time, each time something broke on a real device.

### 1. Run the original, unmodified
Claude Code is downloaded from Anthropic's official channel, verified against the official sha256 manifest, and never modified by a single byte. The toolchain comes from the official Termux repositories. We only build the layer that makes it run: prefix relocation, system-call compatibility, passing keys through `apiKeyHelper`.

Build on other people's work without tampering with it. That is engineering restraint, and it is respect for upstream terms and for users' trust.

### 2. Work with the platform's native capabilities
No root, no custom ROM, no chroot / proot / virtual machine.

- **Same-length prefix relocation.** Termux binaries have `/data/data/com.termux/` baked in at build time. The package name `cc.codroid` was **chosen deliberately** to be 10 characters, the same length as `com.termux`, so a byte-for-byte replacement fixes every RUNPATH, shebang and config path — no `LD_LIBRARY_PATH`, wrapper scripts or binary patching.
- **System-call compatibility.** Android installs a system-call allow-list on app processes and kills anything outside it with SIGSYS (Android 14 does not allow `epoll_pwait2`). cccodroid does not loosen that restriction — a blocked call is still blocked. It only turns "blocked means killed" into "returns ENOSYS", so the program takes the fallback path it already has. **The security boundary stays where it is; failures just become graceful.**
- Elevated privileges come from [Shizuku](https://shizuku.rikka.app) (optional); background work relies on a foreground service.

Find out what the system actually allows, then do as much as possible within that boundary.

### 3. The real device is the judge
Many problems only show up in real use: a notification that lingers after the app exits, jlink reporting success while producing an image that cannot start, vendor ROMs freezing background processes, FUSE reporting stale file sizes.

We reproduce first, isolate one stage at a time, and confirm with evidence: screenshot comparisons, actually toggling the system's dark mode, a full CRC check of every rewritten archive. "It said it succeeded" doesn't count; "I saw it work" does.

### 4. State lives in the gateway; the UI is a view
Generation, queueing and interruption are all coordinated by the local gateway, and the UI is just one view of it. Reconnecting picks up the turn that is still running; the timer counts from the start time the gateway recorded; reloading the UI never interrupts generation.

The UI can be refreshed or disconnected at any time. Work in progress must not be lost.

### 5. Do exactly what the user meant
**Stop only stops**: queued messages are paused and never sent automatically. **Send now** is an explicit interjection, delivered into the running turn without interrupting it.

The software doesn't make decisions on the user's behalf, least of all irreversible ones.

### 6. Everything can be undone
- Language options are always shown in each language's own name and never translated, so a wrong choice can always be found and reversed; if the UI script fails, a "back to Chinese" button that doesn't depend on the main program appears.
- Toolchain updates keep whatever the user installed with pip / npm -g.
- More aggressive keep-alive settings are opt-in.

Mistakes are allowed; getting stuck is not.

### 7. Secure by default
- The gateway listens on 127.0.0.1 only. Every `/api/*` request must carry a 256-bit token from the app's private directory, and Host and Origin are checked. Other apps and web pages on the phone cannot drive it.
- Account sign-in is done by Claude Code itself; cccodroid never reads, stores or relays claude.ai credentials.
- Third-party API keys live only in the app's private directory and reach claude through `apiKeyHelper`, never through environment variables.
- App and toolchain updates are verified by signature or checksum before they are installed.

Turn the phone into a development machine without turning it into a door for someone else.

### 8. Be candid and traceable
- Release notes are bilingual and state unflattering facts too, such as "this fix had never made it into any toolchain build".
- Every component in the architecture diagram cites the source lines it describes.
- Every toolchain ships with an SBOM and a hashed lock file; third-party licenses and credits are listed one by one.

Anything published should hold up when someone checks it line by line.

## In one sentence

> Without crossing the platform's boundaries or modifying anyone's software, turn the underrated Android phone into a trustworthy, reversible and genuinely useful workbench for AI agents — and bring AI's execution back to the user's own device.
