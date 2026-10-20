# Known issues and unresolved risks

[中文](known-issues.zh-CN.md)

These are problems whose root cause we have **not found and cannot fully rule out**. You are unlikely to hit them in normal use, but we would rather not hide them. If you do, tap **Settings → Troubleshooting → Report on GitHub** in the app (device, Android version and self-test results are filled in) and say what you were doing; attach the zip from **I'm stuck · bundle diagnostics** if logs are needed. Problems tied to a particular phone or vendor system are covered in section 5 below.

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

## 5. Phone makers and chips (only two devices tested)

Only two devices have been tested by hand: a **Lenovo TB320FC** (ZUXOS, Android 15, Snapdragon 8+ Gen 1) and a **RedMagic NX769J** (ZTE-based system, Android 14, Snapdragon). The settings paths for other brands below come from public sources and common practice and have **not been verified**; menu names vary between system versions. [dontkillmyapp.com](https://dontkillmyapp.com) has more detailed steps per brand.

If something breaks on your device, go to **Settings → Troubleshooting → Report on GitHub**. Your device, Android version and self-test results are filled in for you; you only describe what went wrong. No GitHub account? Use **I'm stuck · bundle diagnostics** next to it.

If everything works, please tell us too: open a GitHub issue with the [Device report](https://github.com/greyoak111/cccodroid/issues/new?template=device.yml) template, or post in [Discussions](https://github.com/greyoak111/cccodroid/discussions). The more devices are tested, the more reliable this section becomes.

### On every device

- **Android version**: the minimum is Android 8.0; only 14 and 15 have actually been tested.
- **Background**: the app keeps a foreground service running (the notification), which is enough for stock Android's background limits. **It does not stop vendors' own freezers and cleaners.** While frozen, the gateway and any running task stop completely and resume when you come back. If the app notices it was frozen, Settings shows a notice with the steps for your brand.
- **GPU components are Snapdragon-only**: both GPU drivers, GPU benchmarks and clvk need Qualcomm Adreno's `/dev/kgsl-3d0`. On MediaTek Dimensity, Samsung Exynos, Google Tensor and Huawei Kirin devices the extensions page marks them "Snapdragon only" and they can't be installed. Components that can use the GPU, like Blender and llama.cpp, still install there and fall back to the CPU, just slower. Support for other GPUs is being looked into; reports from people with those devices help a lot.

### Lenovo (ZUI / ZUXOS) · tested

The main development device; every feature has been tested on it. No vendor freezing seen.

### RedMagic / Nubia / ZTE · tested

- **The system freezes the whole app after about 90 seconds in the background**, regardless of the foreground service or the battery whitelist. Fix: App info → App battery usage → Battery optimization → **Background running: Allow**.
- Set **Auto-launch** on the same page to Allow as well. When it is "Automatic", the system blocks recovery after updates and starting Shizuku at boot.
- From Android 12 on, system settings pages hide third-party overlays, so the Shizuku wireless pairing code is entered from the notification.
- A half-second grey overlay sometimes appears on cold start when not launched from the home screen; see item 4.

### Xiaomi / Redmi (HyperOS / MIUI) · not tested

Known for aggressive background killing. App info → **Battery saver: No restrictions**, turn **Autostart** on, and lock the cccodroid card in the recents screen so "clear all" doesn't kill it.

### OPPO / OnePlus / realme (ColorOS / OxygenOS / realme UI) · not tested

App info → Battery usage → **Allow background activity** and **Allow auto launch**. Locking the recents card is a good idea here too.

### vivo / iQOO (OriginOS / Funtouch OS) · not tested

Settings → Battery → Background power consumption management → cccodroid: **Allow high background power consumption**. Allow **Autostart** in i Manager.

### Huawei / Honor (HarmonyOS / MagicOS) · not tested

Settings → App launch → cccodroid: turn off "Manage automatically" and allow **Auto-launch**, **Secondary launch** and **Run in background** by hand. HarmonyOS NEXT can't install Android apps at all.

### Samsung (One UI) · not tested

App info → Battery → **Unrestricted**, and in Settings → Battery → Background usage limits, add cccodroid to "Never sleeping apps". Models sold in the US and China are mostly Snapdragon; many others use Exynos, which can't use the GPU components.

### Google Pixel and near-stock systems · not tested

Background rules follow stock Android, so the foreground service is enough. Tensor chips use a Mali GPU, so the GPU components don't work.

## For developers: tests can create fake bugs

Item 1 is tied to automated testing (item 2 has been confirmed not to be). Before fixing a problem like this, make sure it **also happens with no tests running**:

- Events injected with `input swipe` / `input tap` get cancelled by some ROMs' gesture listeners, sometimes with an extra tap added.
- Screenshots, simulated secondary displays, launching other windows and switching keyboards with `ime set` can all take input focus or the keyboard connection away from the app.
- For drag, scroll and keyboard problems, trust results from a real finger and a real keyboard.
