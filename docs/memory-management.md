# Memory: reading the numbers, finding the culprit, and how the memory manager works

[中文](memory-management.zh-CN.md)

The worst thing that can happen during heavy work on a phone (frame-by-frame rendering, big parallel builds, long transcodes) is the system killing the whole app halfway through. These are lessons from real devices, and the reasoning behind the memory manager (`cc-mem`).

## 1. Read the right number

`free` will scare you. On a 15 GB tablet it once reported 11 GB "used". Broken down:

| Item | Size | Notes |
|---|---|---|
| Actually held by processes (AnonPages) | 2.6 GB | |
| File cache | 5.9 GB | Recently read files, dropped by the kernel the moment memory is needed |
| Available (MemAvailable) | 10.8 GB | What you can really still use |

To decide whether you have enough memory, look at **MemAvailable** in `/proc/meminfo`. To see who holds what, run `priv 'dumpsys meminfo'`; the `Total RAM` section at the end is the clearest summary of what is in use and what can be reclaimed (free + kernel caches + cached background apps).

## 2. If something got killed, find out who did it

When memory runs out, Android's low-memory killer (lmkd) kills **whole apps**. A heavy job runs as a child of the app, so when it eats all the memory it takes the app, and the conversation in progress, down with it. Afterwards:

```sh
priv 'logcat -d -b events' | grep -E 'killinfo|am_mem_factor|am_kill'
```

- A rising `am_mem_factor` means the system entered a low-memory state.
- Many apps' services scheduled for restart in the same second (`am_schedule_service_restart`) means the whole device ran dry and everything got cleared out at once.
- `killinfo` records how much free memory and file cache were left at the moment of the kill.

## 3. Suspect your own code first

The thing that cut our session twice was not some background app. It was our own render script. The WebAssembly build of resvg was given a new object for every frame and never `free()`d. WebAssembly memory is outside JavaScript's garbage collector, so every frame leaked an 8 MB canvas. Six parallel workers grew to roughly 20 GB in total.

After the fix each worker stayed flat at about 135 MB. Eight workers rendered an 86-second 1080p video in 66 seconds, and available memory stayed around 10 GB the whole time.

Lesson: **before scaling out, run one worker for a while and watch whether its RSS grows.** Check every WebAssembly or native-binding object (sharp, canvas and the like) for a `free` or `dispose` method.

## 4. The memory manager (cc-mem)

Even with no leaks of your own, background apps that come back after you swipe them away still compete for memory. The logs show exactly how they return: their own watchdog services, bundled third-party push SDKs, scheduled jobs literally named "keep alive", and being woken up when another app queries their data.

The memory manager is off by default; turn it on in Settings. It does three things:

- `cc-mem status`: where memory goes, which apps can be stopped, which are protected and why.
- `cc-mem clear`: stops background apps that aren't on the allowlist.
- `cc-mem run -- command`: clears the field and compacts system memory before starting, checks every 2 seconds while the job runs and stops anything that comes back, and reports at the end.

### What is protected

No hard-coded package lists. It asks the system:

1. **Android's own ranking.** `dumpsys activity lru` tags each process with an importance class. Foreground, visible, perceptible and persistent processes (the other half of a split screen, a proxy or music player with a foreground notification, the keyboard) are never touched. Only the "service" and "cached" classes are candidates.
2. **Auto-detected roles:** current launcher, keyboard, accessibility services, VPN, WebView provider, Shizuku, cccodroid itself, core system components.
3. **The user's allowlist.**
4. **Dependencies** (the easiest to miss; see below).

### Stopping one package can kill others

We found this the hard way. When Android stops a package, **it also kills every process that has that package loaded**:

- Stopping the WebView package killed every app that renders with WebView, cccodroid included.
- Stopping Lenovo's calendar killed the system split-screen service, because it had loaded a calendar component.

There is a second kind. If an app holds a stable ContentProvider connection to another app's data, killing the provider also kills the client.

So the memory manager reads `packageList`, `packageDependencies` and stable provider connections for every process from `dumpsys activity processes`. Any package that a **surviving** process depends on is protected as well. Protecting one more package keeps more processes alive, and their dependencies need protecting too, so it iterates until the set stops changing.

### Other details

- **A process name is not a package name.** `com.huawei.hwid.core` is a process; its package is `com.huawei.hwid`. Running `am force-stop` with the process name silently does nothing. Always go by `packageList`.
- **Two strengths.** Routine cleanup uses `am stop-app`, which keeps the app's scheduled alarms and jobs, so the app may wake up later. `run` uses `am force-stop`, which cancels them, so the app stays down until the user opens it.
- **Dropping the file cache is impossible here and unnecessary.** `/proc/sys/vm/drop_caches` needs root; the shell user is denied. The file cache is reclaimable anyway: the kernel drops it on demand, and clearing it in advance only makes later programs read from flash again.
- **Apps that keep coming back** can be restricted for good with `cc-mem tame <package>` (`am set-bg-restriction-level … restricted`). `cc-mem untame` restores the previous level.
