# cccodroid help

cccodroid runs the **official, unmodified Claude Code** on your phone, wraps it in a graphical interface, and ships a full set of developer tools (Python, Node, clang, git, ffmpeg…). Claude can read and write files, run commands and start local servers, just as in a terminal on a computer.

## Getting started

1. **The first launch** downloads the toolchain (about 650 MB) and the official Claude Code (about 230 MB). Downloads resume after interruptions and every file is hash-checked. Free space is checked first; if there is not enough, you are told how much is needed.
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
- **Thinking** is collapsed until you tap it.
- **Folded steps**: tool calls between two pieces of reply text, with the thinking in between, fold into one line such as "3 steps · Bash … · Done". Tap to see each step's input and output. Groups with a pending approval, a failure or an image open by themselves.
- **Paths in replies are links**: an absolute path (or `file.js:12`) opens in the viewer; a directory opens the file browser. Web links open in the in-app browser.
- Under each reply: **Copy** (the raw Markdown text) and **Share** (system share sheet). Your own messages have **Copy** and **Resend** (back into the input box).
- When you scroll up, a ↓ button appears at the bottom right; it takes you back to the latest message and lights a dot when new output arrives.

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
- **Extra directories** (`--add-dir`): let Claude read and write outside the workspace, for example `/sdcard/SomeFolder`. They also become shortcuts in the file browser.
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

## Shizuku and system permissions (optional)

- "Install and activate" in Settings downloads Shizuku from its official release (signature checked) and activates it through Wireless debugging, no computer needed. Enter the pairing code in the notification at the top of the screen.
- Once active, the terminal and Claude can run `priv '<command>'` as the shell user: `pm`, `am`, `settings`, `logcat`, `screencap` and so on.
- After a reboot, cccodroid turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- With Shizuku, keep-alive is more reliable and app updates can install silently when idle.

## Updates and repair

- **Automatic updates** (on by default): Claude Code updates silently from the official channel; cccodroid itself is downloaded, signature-checked and then offered for install; the toolchain is pre-downloaded on Wi‑Fi only and swapped in the next time the app opens, keeping anything you installed with pip / npm -g.
- Updates never cut each other off. A replacement is checked against the release manifest before the old version is touched; if it is interrupted, the next launch finishes it or rolls back.
- **Verify / Repair**: checks every toolchain file against its hash; Repair reinstalls the same version and keeps your own packages.
- **Repair ledger**: every install, verification, repair and startup recovery is recorded and can be read in Settings.

## Troubleshooting

- **Safe mode**: if a hook, plugin, MCP server or CLAUDE.md breaks things, turn it on. Claude Code starts with `--safe-mode` and loads no customizations; sign-in, keys, sessions and model stay as they are. Turning it off restores everything.
- **I'm stuck · bundle diagnostics**: diagnostics, the app log, the gateway log and the repair ledger, packed into a zip for the share sheet. You see the contents first; keys, tokens, email addresses and your messages are scrubbed, and transcripts are not included.
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
