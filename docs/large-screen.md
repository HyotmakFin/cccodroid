# Large-screen layout (tablets, foldables, landscape)

Since 0.1.18 the interface adapts to the **window width** (not orientation — a phone in landscape is wide but short, an unfolded foldable is nearly square, split screen gives you half a window):

| Window width (CSS px) | Layout |
|---|---|
| < 840 | Single column. Files, viewer and terminal cover the screen (unchanged from earlier versions). |
| ≥ 840 | Two columns: chat + a workspace on the right. Files / viewer / terminal open there, side by side with the chat. |
| ≥ 1000 | Three columns: the sidebar (sessions / settings / capabilities / extensions) also stays docked on the left. The ☰ button or ✕ collapses it. |
| height < 500 | No extra columns; top bar and composer get more compact. |

When the window narrows (split screen, folding the device) the panes fall back to full-screen overlays with their state intact.

- The divider between the chat and the workspace can be dragged; the ratio is remembered. Double-tap it to reset.
- With several panes open, tabs at the top of the workspace switch between them.
- The built-in browser also opens in the workspace, as a pane with its own tab. It is a native `WebView` (`BrowserPane.java`) laid over a placeholder (`#browser`). `layout.js` reports the placeholder rect via `CCApp.paneBounds(x, y, w, h)` and reports 0 to hide it while another pane is on top or an overlay (lightbox, sheet, sidebar overlay) is open. On narrow windows the browser still opens full screen (`BrowserActivity`, same `BrowserPane` inside).
- Back gesture: on wide screens the most recently opened pane closes first. The docked sidebar is not treated as an overlay.

## Where the code lives

Everything is in one file: `gateway/web/layout.js`. The rest of the UI only hides and shows elements as before. `layout.js` watches those changes and sets classes on `<html>` (`data-lay`, `dock-l`, `has-right`, `ws-multi`, `short`) plus the CSS variables `--lw` and `--rw`. The matching styles are the last block of `style.css`.

## Foldable hinge: help wanted

We do not avoid the hinge precisely. That needs Jetpack WindowManager (AndroidX + Kotlin runtime), which our on-device build chain does not include. In book posture the default 50/50 split lines up with the hinge closely enough.

If you want to do it properly, call this from the Android shell:

```js
CCLayout.setAvoid(x)   // x = vertical line to avoid, in CSS px from the left; null to clear
```

As long as the user has not dragged the divider, the workspace's edge is placed on that line. Getting the hinge position into the page is up to the shell. For example, feed `FoldingFeature.bounds` (divided by the display density) into `evaluateJavascript`.
