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

## 2. The chat sometimes won't scroll

- **Symptom**: dragging up or down over the chat does not scroll it. Buttons and typing still work.
- **When it happened**: a few times in the development build, once during a split-screen test. The release build likely has it too.
- **Known**: while frozen, the chat itself can still scroll (setting the scroll position from script works), nothing covers it, and the page is not zoomed. The page is fine; the finger drag just does not turn into a scroll.
- **Suspected**: the system's gesture listener sends `touchcancel` mid-gesture and leaves half a touch behind, or scrolling is latched onto another element. Not confirmed. Also, swipes injected with `input swipe` get cancelled by the system on the test device's ROM, so tests cannot settle this; only a real finger can.
- **Fallback since 0.1.19**: if a vertical drag over the chat goes some distance and the chat does not move even though it could, the front end resets the chat's scroll state and moves it by script for the rest of that gesture. No restart needed. The root cause is not fixed, only worked around.
- **Diagnostics**: the front end keeps the last 100 touch, cancel and scroll events in `window.__touchLog`, and each fallback is logged there too. Release builds do not enable WebView debugging, so for now only the development build can read it.

## 3. Foldable hinge

The wide layout does not avoid the hinge precisely, because the build chain lacks Jetpack WindowManager. See "Foldable hinge: help wanted" in [large-screen.md](large-screen.md).

## For developers: tests can create fake bugs

Items 1 and 2 are both tied to automated testing. Before fixing one, make sure it **also happens with no tests running**:

- Events injected with `input swipe` / `input tap` get cancelled by some ROMs' gesture listeners, sometimes with an extra tap added.
- Screenshots, simulated secondary displays, launching other windows and switching keyboards with `ime set` can all take input focus or the keyboard connection away from the app.
- For drag, scroll and keyboard problems, trust results from a real finger and a real keyboard.
