# cccodroid help

cccodroid runs the **official, unmodified Claude Code** on your phone, wraps it in a graphical interface, and ships a full set of developer tools (Python, Node, clang, git, ffmpeg…). Claude can read and write files, run commands and start local servers, just as in a terminal on a computer.

## Getting started

1. **The first launch** installs the toolchain (about 650 MB) and the official Claude Code (about 230 MB). For the toolchain it first asks where to get it: **GitHub**, the **cccodroid.net mirror**, or a **local file** (for example a `devkit-cc.codroid.tar.gz` you downloaded on a computer; see [cccodroid.net/download](https://cccodroid.net/en/download/#devkit)). The two download sources back each other up: if one stalls, the app switches to the other and resumes. Whatever the source, the file is checked against the SHA-256 that ships inside the APK. Free space is checked first; if there is not enough, you are told how much is needed.
2. **Connect a model** (Settings → Provider). Pick one:
   - **Sign in with a Claude account**: if you have a Pro / Max subscription or a Console account, authorize once in the browser and you are sent back to the app. No key needed.
   - **Enter an API key**: an Anthropic key, or the official Anthropic-compatible endpoints of DeepSeek, Zhipu GLM, Qwen or Kimi. You can also add any compatible endpoint.
3. **Send your first message**: a new conversation shows a few examples. Tapping one only fills the input box, so you can edit it before sending.

> Keys stay in the app's private directory and reach Claude Code on demand, never through environment variables. Account sign-in is done by Claude Code itself; the app never touches your credentials.

## The screen

**Top bar** (left to right):

| Button | What it does |
|---|---|
| ☰ | Sidebar: Sessions / Settings / Capabilities / Extensions / Help |
| 📁 | File browser |
| >_ | Terminal |
| 🌐 | In-app browser |
| ‹› | Command palette (slash commands) |
| ❄ | Unfreeze: tap it when nothing scrolls (see Troubleshooting) |
| ＋ | New conversation |

The thin bar under it shows **context usage**: how much of the model's window this conversation already fills. It changes colour when it is nearly full.

**Input area**:

- ＋: common actions (attach a file, switch model, thinking effort, context / cost, compact, and more).
- 📎: attach images or files. You can also paste images.
- The line under the input box: the current model, the **permission mode** (tap to change), and this turn's time and output size.

## Conversations

- **Enter sends.** Pasting multi-line text works fine.
- **Keep typing while Claude works**: Enter queues the message until this turn ends; ⚡ (interject) slips it into the running turn without stopping it. Queued messages wait at the end of the conversation and can be sent right away.
- **Stop only stops**: queued messages are put on hold, not sent automatically.
- `/` opens slash commands, `@` inserts a file path (with suggestions as you type).
- **Handing things to Claude**: the paperclip attaches files; in your gallery, file manager or browser, Share → cccodroid turns the file into an attachment (shared text goes into the input box); "Screenshot to Claude" in the + panel captures the screen (needs Shizuku), including the other half in split screen, and "Screenshot in 5 s" gives you time to switch apps, then brings you back.
- **Thinking** is collapsed until you tap it.
- **Folded steps**: tool calls between two pieces of reply text, with the thinking in between, fold into one line such as "3 steps · Bash … · Done". Tap to see each step's input and output. Groups with a pending approval, a failure or an image open by themselves.
- **Paths in replies are links**: an absolute path (or `file.js:12`) opens in the viewer; a directory opens the file browser. Web links open in the in-app browser.
- Under each reply: **Copy** (the raw Markdown text) and **Share** (system share sheet). Your own messages have **Copy** and **Resend** (back into the input box).
- When you scroll up, a ↓ button appears at the bottom right; it takes you back to the latest message and lights a dot when new output arrives.
- **Goals (`/goal`)**: type `/goal <condition>` and Claude keeps working, round after round, until the condition is met. Above the input you see the goal, how many times it has been checked and how long it has run; once met, how many rounds, how long and how many tokens it took. "Give up" stops the current round and clears the goal.
- **Background tasks**: commands, subagents and workflows Claude starts in the background are listed above the input, each with its own "Stop".
- **Task list**: on longer jobs Claude keeps a task list (TaskCreate). Above the input you see how many items are done and which one is in progress; tap to expand the whole list, and tap ✕ to dismiss it once everything is done. The list belongs to the conversation and is still there next time you open it.
- **Subagent steps**: every step a subagent (Agent) takes is tucked under its Agent card in “Subagent steps”. Expand it to see which commands it ran, which files it read and what it reported; while it runs, the card shows what it is doing. For older conversations the record is loaded when you expand it.
- **Rewind to here**: every message you sent has a rewind button. It first works out which files Claude changed after that point and how many lines, then lets you choose “Revert code only” or “Revert code and ask again from here”. Asking again opens a new conversation with that message back in the input box; the original is kept. Only changes made with the editing tools (Edit / Write) are reverted — files changed by commands and installed packages are not restored. Messages from before v0.2.13 have no snapshots, so only the conversation can be rewound.
- **Undo a cleared draft**: if text in the input box gets deleted (not sent), "Restore what you just cleared" appears under it for 20 seconds; with a hardware keyboard, ↑ in the empty box does the same.

## Permissions and safety

Before Claude edits files, runs commands or goes online, the **permission mode** decides whether it asks first:

| Mode | Behaviour |
|---|---|
| Ask each time (default) | Reads freely; asks before editing, running commands or going online |
| Accept edits | Edits without asking; still asks before commands |
| Plan only | Reads and drafts a plan, then waits for your approval |
| Auto | Claude's classifier decides what needs asking (experimental) |
| Allow everything | Never asks. Use only when you trust the task and can live with the consequences |

- **Approval cards** appear under the tool card they belong to, and a bar above the input box stays visible even if you scroll away. Choose Allow, Always allow (only the rules Claude itself suggests) or Deny (optionally with a reason, or deny and stop).
- **Plan approval**: "Approve, ask each time" or "Approve, accept edits" also sets the permission mode from then on; or ask for changes.
- When several permission requests are waiting, the bar shows "1 of 3".
- **Nothing is lost in the background**: you get a notification (no pop-up banner) when a turn ends or Claude is waiting for you. The notification only offers Deny and Open; to allow something you must come back and see the full command.

## Sessions

Sidebar → Sessions:

- Tap one to switch. You can **rename** and **delete** (deleted sessions go to the trash for 30 days).
- **Select**: tick sessions or select all and **export** them as a zip (save anywhere or share).
- **Import**: import that zip on another device and carry on.
- **Close current**: the next message starts a new conversation; the old one stays in the list.
- If the system kills the app mid-turn, reopening it marks that turn "Interrupted" with a **Continue** button. Queued messages are still there.

## Files, viewer, terminal, browser

**File browser** (📁): browse the workspace and extra directories. Tap a file to open it in the viewer; download or save it anywhere.

**Viewer / editor**:

- Edit and save text and code directly. If the file changed on disk after you opened it (say Claude edited it), you are asked before anything is overwritten.
- Markdown is rendered, with an edit toggle. Images fit the screen; tap for 1:1. PDFs render page by page as you scroll (CJK text and password-protected files work).
- HTML files open as a live web page (CSS, JS and images next to it load too) and reload when the file changes; switch to the source or open it in the browser. The page runs in its own sandbox and can't touch the app or your sessions.
- Office files: Word (docx) shows text, headings, tables and images directly; Excel (xlsx / xls / ods) shows as a grid with sheet tabs at the bottom — tap a cell to see its full content and formula. PowerPoint, legacy doc files and the “Original layout” button use LibreOffice in the background to convert to PDF (install it with one tap the first time, about a 190 MB download; results are cached, so reopening is instant).

**Terminal** (>_):

- A real terminal running the same bash and toolchain Claude uses, with multiple tabs.
- A key row adds what phone keyboards lack: Esc, Tab, sticky Ctrl / Alt, arrows, Home / End, PgUp / PgDn, paste, font size.
- "Text view" lets you long-press to select and copy output. Closing the panel keeps the terminal running; its output replays when you come back.

**In-app browser** (🌐):

- Handy for local dev servers: type `127.0.0.1:port` in the address bar.
- Web links in replies open here too; ↗ hands the page to the system browser. Sign-in pages always go to the system browser.

## Large screens and split screen

The layout follows the **window width**, not the orientation:

- Narrow (phone portrait, narrow split screen): one column; files, terminal and browser cover the screen.
- Wide (≥ 840): chat plus a workspace on the right, where files, viewer, terminal and browser open. Drag the divider; double-tap it to reset.
- Wider (≥ 1000): the sidebar also stays docked on the left; ☰ or ✕ collapses it.
- With several panes open, tabs at the top of the workspace switch between them; the back gesture closes the most recently opened one first.

## Settings

- **Language**: nine interface languages, or follow the system.
- **Appearance**: light / dark / follow the system. The launch screen, setup screen and in-app browser follow this too.
- **Provider**: pick a provider, enter a key, test the connection; account sign-in lives here as well.
- **Model**, **thinking effort** (`--effort`, higher thinks longer), **output style**, **auto-compact window** (summarize history when the conversation nears this many tokens).
- **Idle compaction** (on by default): with a Claude account or an Anthropic API key, a conversation over 200K tokens that has been idle for about 54 minutes is compacted once before its 1-hour prompt cache expires, so picking it back up doesn't reprocess the whole history at full price.
- **Extra directories** (`--add-dir`): let Claude read and write outside the workspace, for example `/sdcard/SomeFolder`. They also become shortcuts in the file browser.
- **On-device model**: with the llama-cpp component installed you can chat with a small model offline (download Qwen2.5 0.5B / 1.5B / 3B from the llama-cpp component on the Extensions page). Phone hardware is limited, so only chat is built in. To tinker, write `~/.cccodroid/local-mode.json` for a custom mode — the card has a ready-made sentence you can copy to a cloud model so it sets one up for you.
- **Notifications**: whether to notify when a task ends or Claude is waiting for you.
- **Shizuku**, **updates** and **troubleshooting** are covered below.

## Extensions

Sidebar → Extensions:

- **Optional components**: large tools you install only when needed, such as a headless Chromium browser, GitHub CLI, Blender, Godot, LibreOffice, llama.cpp or GPU drivers. Signatures and per-file manifests are checked before installing, and uninstalling removes everything. Each component ships a skill, so Claude knows how to use it.
- **Plugins**: search the official directory or add other marketplaces; install, enable, disable, uninstall.
- **Skills**: install from a zip or from the official skills library.
- **MCP servers**: add and remove.

Changes take effect with the **next message**. Everything goes through Claude Code's own `claude plugin` / `claude mcp` commands; anything that needs to run a command to install shows it to you first.

Sidebar → Capabilities lists the slash commands, tools, skills, subagents, MCP servers and plugins currently available.

**Packages from the Termux repository: `pkg`** (in the terminal; Claude uses it too):

- Install with `pkg install rust`, search with `pkg search <word>`, remove with `pkg uninstall` (dependencies nothing else needs go too). Packages are rewritten for cccodroid's paths and run as they are.
- Packages tested on a device install directly: rust / cargo, golang, zig, ruby, php, lua, python-numpy, neovim, vim, tmux, redis, postgresql and more; `pkg verified` lists them all. Anything else needs `--unverified`; try it after installing.
- Packages that come with the devkit (clang, python, node…) aren't upgraded by pkg; they update with the devkit. After a devkit update, run `pkg restore` to bring back what you installed with pkg (you'll be reminded).

## Shizuku and system permissions (optional)

- "Install and activate" in Settings downloads Shizuku from its official release (signature checked) and activates it through Wireless debugging, no computer needed. Enter the pairing code in the notification at the top of the screen.
- Once active, the terminal and Claude can run `priv '<command>'` as the shell user: `pm`, `am`, `settings`, `logcat`, `screencap` and so on.
- After a reboot, cccodroid turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- With Shizuku, keep-alive is more reliable and app updates can install silently when idle.
- Every command run through `priv` is logged (time, who started it, the command, exit code). See it under Shizuku in Settings → "Privileged command log". The log stays on the device.

## Device tools (optional, off by default)

Lets Claude use a few phone features directly: post notifications, read and write the clipboard, share a file to another app, open a link or an app, check battery and network. Turn them on in Settings → Device tools; each tool can be switched off on its own.

- **When to turn them on**: when you want Claude to test an app you're building, or to send a PDF, image or APK it made to a chat app. While on, every turn carries one or two thousand extra tokens of tool descriptions, so leave it off otherwise.
- **Anything that opens another app only pre-fills it**: calendar, alarm, email, SMS and the dialer get the details filled in; you tap save, send or call yourself. When cccodroid is in the background Android won't let it show a screen, so it posts a notification you tap instead.
- **Screen reading and tapping** need the accessibility service, a separate setting that is off by default:
  - **On when needed**: switched on when Claude reads the screen and off again after a few idle minutes, so it doesn't run all the time or drain the battery. Needs Shizuku activated.
  - **Always on**: stays on and uses more battery.
  - Without Shizuku you have to turn cccodroid on in the system accessibility settings yourself. On Android 13 and later, sideloaded apps first need App info → top-right menu → Allow restricted settings.
- Each call is confirmed like any other tool, according to your permission mode.

## Memory manager (optional, off by default)

During heavy work (compiling, rendering, transcoding), background apps that keep restarting themselves compete for memory. The memory manager can stop them first and keep them down until the job finishes. It needs Shizuku; turn it on in Settings.

- **Never stopped**: whatever you are looking at, split-screen apps, apps with a foreground notification (proxy, music), the launcher, keyboard, accessibility services, VPN, Shizuku, system components, and anything those depend on. When Android stops an app it also kills every app that has it loaded, so dependencies are protected too.
- **Allowlist**: add apps you always want messages from (such as chat apps), one package name per line. You can find package names in the system app info page, or tap "Check memory" first.
- **Clean up now** stops the remaining background apps. The system may wake some of them again later.
- **In the terminal**:
  - `cc-mem status` shows where memory goes;
  - `cc-mem run -- command` runs a heavy job: it clears the field first, stops anything that comes back while the job runs, and reports at the end;
  - `cc-mem tame <package>` restricts an app's background activity for good, and `cc-mem untame` undoes it;
  - `make -j$(cc-mem jobs)` picks a safe parallel job count from the memory available right now (works without turning the memory manager on).
- A stopped app may not deliver messages until you open it again. That is why the switch is off by default.

## Updates and repair

- **Automatic updates** (on by default): Claude Code updates silently from the official channel; cccodroid itself is downloaded, signature-checked and then offered for install; the toolchain is pre-downloaded on Wi‑Fi only and swapped in the next time the app opens, keeping anything you installed with pip / npm -g.
- Updates never cut each other off. A replacement is checked against the release manifest before the old version is touched; if it is interrupted, the next launch finishes it or rolls back.
- **Verify / Repair**: checks every toolchain file against its hash; Repair reinstalls the same version and keeps your own packages.
- **Local file…**: installs the toolchain from a file you've already downloaded (offline, or when the network is too slow). It's checked against the published releases first; if it doesn't match, you're told plainly and decide yourself.
- **Repair ledger**: every install, verification, repair and startup recovery is recorded and can be read in Settings.

## Troubleshooting

- **Safe mode**: if a hook, plugin, MCP server or CLAUDE.md breaks things, turn it on. Claude Code starts with `--safe-mode` and loads no customizations; sign-in, keys, sessions and model stay as they are. Turning it off restores everything.
- **I'm stuck · bundle diagnostics**: diagnostics, the app log, the gateway log and the repair ledger, packed into a zip for the share sheet. You see the contents first; keys, tokens, email addresses and your messages are scrubbed, and transcripts are not included.
- **Report on GitHub**: opens a new GitHub issue with your device, Android and vendor system version, self-test results and installed components already filled in; you just describe what happened. No logs or conversations are included. Needs a GitHub account. Per-brand background settings and chip limits are on the website's Known issues page.
- **Nothing scrolls (unfreeze)**: now and then nothing scrolls by touch, while buttons still work. This is a fault in the system WebView, not something you did, and we cannot fix it at the root yet. The app detects it and recovers in about a second; a reply in progress is not affected, and unsent text is put back. If it does not recover on its own, tap ❄ in the top bar. Details are in item 2 of "Known issues".
- **Run doctor**: at the bottom of Settings; runs Claude Code's own self-check.
- **Common situations**:
  - A reply stays "generating" with no progress: check the status line and your network; stop and resend if needed, or bundle diagnostics.
  - A file or folder will not open: make sure it is in the workspace or an extra directory.
  - A component fails to install: usually network or space; retrying resumes the download.
- Problems not yet explained are listed in the project's "Known issues" document.

## Advanced

**Use the toolchain directly in the terminal**:

```
python3 -m venv .venv && . .venv/bin/activate && pip install requests
npm i -g typescript
pkg install rust && cargo new demo                # packages from the Termux repo
clang hello.c -o hello && ./hello
ffmpeg -i in.mp4 -c:v h264_mediacodec out.mp4   # hardware encoding
cccodroid-selftest                                # check the whole toolchain
```

**Teach Claude your habits**: put a `CLAUDE.md` in the project directory (or a global `~/.claude/CLAUDE.md`) with conventions, common commands and caveats. Every conversation reads it.

**Your own slash commands and skills**:

- `~/.claude/commands/name.md` adds a `/name` command; the file is the prompt Claude receives.
- `~/.claude/skills/name/SKILL.md` is a skill. Say clearly at the top when to use it; Claude reads it when it fits.

**Web apps and services**: ask Claude to serve on `127.0.0.1:port` and open it in the in-app browser. On wide screens you can watch the page and the chat side by side.

**Files outside the workspace**: Settings → Extra directories, add something like `/sdcard/Download`.

**USB-debug another phone**: connect it with an OTG cable, run `usb-adb` in the terminal, then use `adb devices / install / shell` as usual.

**Save context**: compact long conversations with `/compact` or set an auto-compact window; start a new conversation for unrelated tasks.

**Models and cost**: `/model` switches models, `/effort` sets thinking effort, `/cost` and `/usage` show spending and quota (with account sign-in, the account card in Settings also shows the 5-hour and weekly quota).

**Debugging the UI itself**: WebView debugging is off by default (when on, any computer connected over adb can read the page). To debug with Chrome's `chrome://inspect`, run `touch ~/.webdebug` in the terminal and reopen the app; `rm ~/.webdebug` when you are done.
