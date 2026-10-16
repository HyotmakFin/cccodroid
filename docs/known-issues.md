# Known issues and unresolved risks

[中文](known-issues.zh-CN.md)

These are problems whose root cause we have **not found and cannot fully rule out**. You are unlikely to hit them in normal use, but we would rather not hide them. If you do, please open an issue with the zip from **I'm stuck · bundle diagnostics** and a note on what you were doing.

## 1. The keyboard stops typing into the message box

- **Symptom**: during or right after a reply, you tap the message box and type, but nothing appears. Only restarting the app fixes it. Seen on both a phone and a tablet.
- **When it happened**: so far only while automated tests were running during development. At the time the tests were taking screenshots from the shell, opening a simulated secondary display (overlay display), switching keyboards with `ime set` and launching other test windows. It has not been reproduced in normal use.
- **Current view**: most likely a side effect of those tests. Input focus moved to another window or virtual display, and the link between the WebView and the keyboard did not come back. **We never caught it in the act, so a bug in the app is not ruled out.**
- **Ruled out**: the message box's attributes (placeholder etc.) are not being rewritten over and over while a reply streams.
- **Workaround**: restart the app.
- **To help**: if it happens, note four things: did the keyboard appear; did the suggestion bar show text; does typing on an English keyboard, or pasting, work; which panes were open (terminal, files, browser).

## 2. Touch scrolling freezes everywhere (patched; root cause is in WebView, not fixed)

- **Symptom**: nothing scrolls by touch any more: not the chat, not the sidebar, not any pane. Buttons and typing still work. It does not recover on its own.
- **When it happens**: it recurred during normal use of the development build with a real finger, so it is not a test artefact. Release builds use the same system WebView and can hit it too.
- **What we found**:
  - While frozen, touch events still reach the page, and the page does not block them (no `preventDefault`, no `touch-action`); no scroll comes out. Scrolling by script or with a mouse wheel still works.
  - Reloading the page does not help, nor does leaving the app and coming back. **Making the WebView load another site and then come back fixes it at once.**
  - So what gets stuck is WebView's own gesture state for this page, not our page code. Whether something we do happens to trigger it is still unknown.
- **Patch since 0.2.0**:
  - **Automatic**: after two drags in a row where the finger moves vertically, the area under it could scroll that way, and it does not move, the app sends the interface to another site and back. It takes about a second. A reply in progress keeps running in the gateway, and unsent text in the message box is put back. This happens at most once a minute.
  - **Manual**: the snowflake button (❄) in the top bar does the same thing. Use it when the automatic one does not kick in.
  - This works around the problem; it does not fix it.
- **Diagnostics**: each unfreeze stores the recent touch log in page storage (`localStorage` key `cc.freezeLog`, last 5 times). For now only the development build can read it.
- **Earlier approach** (0.1.19 to 0.2.0-rc1): when a drag did not scroll, a script took over the scrolling. In testing it did not help and sometimes made things worse, so it is gone.

## 3. Foldable hinge

The wide layout does not avoid the hinge precisely, because the build chain lacks Jetpack WindowManager. See "Foldable hinge: help wanted" in [large-screen.md](large-screen.md).

## 4. A brief grey scrim when not launched from the home screen

When the app is cold-started without the launcher icon animation (adb, a notification, another app), Android 12+ first draws a system splash screen. Since 0.2.0-rc1 it uses the setup screen colour and no icon, but on a Red Magic 9 Pro a translucent grey scrim still covers the page for about half a second as the window opens. It is probably the ROM's own window animation; not confirmed. Launching from the home screen icon does not show it.

## For developers: tests can create fake bugs

Item 1 is tied to automated testing (item 2 has been confirmed not to be). Before fixing a problem like this, make sure it **also happens with no tests running**:

- Events injected with `input swipe` / `input tap` get cancelled by some ROMs' gesture listeners, sometimes with an extra tap added.
- Screenshots, simulated secondary displays, launching other windows and switching keyboards with `ime set` can all take input focus or the keyboard connection away from the app.
- For drag, scroll and keyboard problems, trust results from a real finger and a real keyboard.
