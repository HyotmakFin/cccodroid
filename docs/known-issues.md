# Known issues and unresolved risks

[中文](known-issues.zh-CN.md)

These are problems whose root cause we have **not found and cannot fully rule out**. You are unlikely to hit them in normal use, but we would rather not hide them. If you do, tap **Settings → Troubleshooting → Report on GitHub** in the app (device, Android version and self-test results are filled in) and say what you were doing; attach the zip from **I'm stuck · bundle diagnostics** if logs are needed. Problems tied to a particular phone or vendor system are covered in section 5 below.

## 1. The keyboard stops typing into the message box (the mystery mobile bug)

- **Symptom**: you tap the message box, it highlights, the keyboard comes up and the suggestion bar shows what you're typing, but nothing lands in the box. One tap on the snowflake button (❄, freeze escape) in the top bar fixes it.
- **When it happened**:
  - During development while automated tests ran, on both a phone and a tablet (the tests were taking shell screenshots, opening a simulated secondary display and switching keyboards with `ime set`).
  - From 2026-10-21 one phone hit it in normal use too, most often on the first launch after a cold start, when the gateway had just come up. Its owner said "almost every time".
  - The same day, reinstalling the **same version** (0.3.5) from the website over the existing install made it go away. Not a line of code changed; we don't know why.
- **Current view**: it looks a lot like the scroll freeze in section 2. WebView's internal state for this page gets stuck and a cross-site hop and back clears it. The keyboard believes it is sending text; the page receives none of it. What gets it stuck is unknown.
- **Tried, didn't help**: 0.3.5 asks for WebView focus as soon as the page is shown; that didn't fix it. An automatic freeze escape when the keyboard sent text but the page saw no input events didn't work on the affected phone either, and was dropped.
- **Ruled out**: the box does have focus, and its attributes (placeholder etc.) are not rewritten over and over while a reply streams.
- **Workaround**: tap the snowflake button (❄) in the top bar. If that doesn't work, swipe the app away and reopen it.
- **To help**: when it happens, before tapping the snowflake, try three things:
  1. long-press the box and paste some text: does it go in?
  2. switch keyboards (the system English keyboard, or voice input): can you type?
  3. with a keyboard that shows pinyin in its own bar first, pick a suggestion: does it land?

  Also note what happened before that cold start, e.g. an update, a phone restart, another app you had just opened. Write it up via **Settings → Troubleshooting → Report on GitHub**.

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
- **Most GPU components are Snapdragon-only**: the two Snapdragon GPU drivers, GPU benchmarks and clvk need Qualcomm Adreno's `/dev/kgsl-3d0`. Since 0.3.3, devices with a Mali GPU (MediaTek Dimensity and others) can install `gpu-driver-mali`, which uses the vendor's own Vulkan driver; it has been tested on a Redmi K70 Ultra and a vivo V2502A ([#14](https://github.com/greyoak111/cccodroid/issues/14)). On Samsung Exynos and Huawei Kirin devices the extensions page marks them "Snapdragon only" and they can't be installed. Components that can use the GPU, like Blender and llama.cpp, still install where no matching driver exists and fall back to the CPU, just slower. Reports from people with those devices help a lot.

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

Background rules follow stock Android, so the foreground service is enough. Tensor G1–G4 use a Mali GPU, so `gpu-driver-mali` should work, but nobody has tested it yet; the other GPU components don't work.

## For developers: tests can create fake bugs

Item 1 is tied to automated testing (item 2 has been confirmed not to be). Before fixing a problem like this, make sure it **also happens with no tests running**:

- Events injected with `input swipe` / `input tap` get cancelled by some ROMs' gesture listeners, sometimes with an extra tap added.
- Screenshots, simulated secondary displays, launching other windows and switching keyboards with `ime set` can all take input focus or the keyboard connection away from the app.
- For drag, scroll and keyboard problems, trust results from a real finger and a real keyboard.
