# Work Island (optional integration)

Mirror Claude's live work status in cccodroid onto the **ColorOS 16 fluid cloud / dynamic island**.

- Working: **正在干活** + the current action (running a command / thinking / waiting for approval…)
- Done: **任务完成** + elapsed time
- After 8 s: the capsule collapses; a quiet “waiting for the next run” notification stays in the shade.

This is **optional**: if the Work Island app is not installed, the gateway does not start anything.

---

## Status

> **Pre-release / Alpha**
> Tested only on **OnePlus PJA110 · ColorOS 16.0.3 · Android 16 (SDK 36)**.
> Other ColorOS versions and other OEMs are untested; interfaces and file layout may change.
> Not recommended for production or critical tasks.

See [`STATUS.md`](https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/STATUS.md).

---

## Components

| Part | Location | Role |
|---|---|---|
| Gateway module | `gateway/gw/work-island.mjs` | Detects the app, spawns the driver, watches it every 30 s |
| Driver | `gateway/gw/work-island-driver.mjs` | Subscribes to `/api/events`, sends state via `am` |
| Renderer app | [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android) | Android 16 Live Update + foreground service |

The gateway side uses Node built-ins only — no npm dependency, no build step.

---

## Why it is built this way

1. **ColorOS 16 consumes Android 16 Live Updates directly.**
   The app uses `Notification.ProgressStyle` + `POST_PROMOTED_NOTIFICATIONS` +
   `android.requestPromotedOngoing`; no OPPO private allow-list is required.
2. **Timers cannot live in the app.**
   ColorOS freezes background apps (`do_freezer_trap`, even with a foreground service),
   so the 8-second collapse timer never fires. Timers and the event stream live in the driver.
3. **The driver cannot live in a single Claude run.**
   A run tears down its process tree. The gateway module spawns the driver under the gateway.
4. **Finish detection uses `runs`, not `run`.**
   `run` is the latest run and can be momentarily empty between turns. On `run_end`, wait 2.5 s
   and re-check `/api/state`; then wait 3 s before reporting done, so a new run can cancel it.

---

## Enable

1. Install the Work Island app ([releases](https://github.com/STUTTEFRFIX/WorkIsland-Android/releases))
   and open it once: notifications on / live updates allowed / battery unrestricted.
2. Restart cccodroid so the gateway reloads the module.
3. The gateway log shows:

   ```
   [work-island] driver 已启动 pid=...
   ```

4. Send a message and watch the island.

## Disable

- Set `CCAPP_WORK_ISLAND=0` when starting the gateway.
- Force-enable (skip the install check): `CCAPP_WORK_ISLAND=1`.
- Uninstalling the app makes the gateway skip it on the next start.
- Use `WORK_ISLAND_PKG=your.package` for a different package name.

---

## Known limits

- Force-stopping cccodroid removes both the gateway and the driver; reopen cccodroid to recover.
- Other ColorOS versions and other OEMs are untested.
- The app's notification service is exported; another app can spoof the displayed state.
- The capsule is drawn by the system; no OPPO UPK custom card.
- The APK in the Work Island repo is test-signed.

---

## Links

- Work Island: https://github.com/STUTTEFRFIX/WorkIsland-Android
- Design: https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/01-方案与设计.md
- Test report: https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/03-测试报告.md
