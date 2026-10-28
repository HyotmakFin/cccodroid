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

## Foldables (experimental, since 0.4.18)

The shell reads the fold from the vendor window extensions library that ships with the system (`androidx.window.extensions`), by reflection, so no AndroidX is needed (`android/java/cc/codroid/Fold.java`). The manifest declares the library as optional, so non-foldables install and run as before. `MainActivity.pushFold` converts the folds to CSS px relative to the WebView and hands them to the page:

- `<html data-fold="none|flat|half" data-fold-dir="v|h" data-folds="N">`, plus `--fold-x/--fold-y/--fold-w/--fold-h` for the first fold;
- `window.__ccFold = { fold, vendor, list: [{ dir, x, y, w, h, type, state }, …] }` (a tri-fold reports two folds) and a `ccfold` event.

`layout.js` then lays out by the folds:

| Situation | Layout |
|---|---|
| One vertical fold, unfolded (book-style, wide foldable) | Three-column rules: docked sidebar on the left page, chat on the right. Opening a pane makes the sidebar step aside; the pane's edge sits on the fold |
| Two vertical folds (tri-fold) | Sidebar, chat and pane on one panel each; both dividers sit on a fold |
| One vertical fold, half-open | Same, and dialogs / bottom sheets cover only the chat page (`html.fold-half-v`, `--fpl` / `--fpr`) |
| Horizontal fold, half-open (tabletop) | The composer starts below the fold (`html.fold-table`, `--fbelow`) |
| Hinge with a width | Counted into the sidebar, whose content is inset (`--fgap`) |

Dragged dividers are remembered under separate keys (`…_f`), so tablet widths are not touched; double-click a divider to snap back to the fold. Settings → Appearance → "Foldable layout (experimental)" turns it off; the row only shows on devices that have reported a fold. `CCLayout.setAvoid(x)` is still there for when there is no fold.

**Testing without a foldable**: the Android emulator. Its Android 36 image maps device states to postures off by one (closed reports half-open, half-open reports flat, open reports nothing), so set the fold explicitly with `adb shell settings put global display_features "fold-[l,t,r,b]-flat"` (or `-half-opened`; separate several folds with `;`). On AVDs with a hinge sensor the device state overrides that after boot; there, hinge angle 120 gives "flat" and 10 gives "half".
