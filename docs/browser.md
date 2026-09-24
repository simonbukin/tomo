# Browser panes

A browser pane shows a web page inside a worktree tab. It sits in the
layout tree like a terminal pane, but it has no PTY, no shell, and no pid.
Its purpose is to look at the running app of a worktree.

## Surface model

`Pane.kind` is `terminal` or `browser`. A browser pane carries `Pane.url`
and reports `live: true` with `pid: null` and no agent. The daemon refuses
`pane_send`, `pane_resize`, and `pane_attach` on a browser pane with
`bad_request`. `pane_close`, `pane_swap`, `pane_zoom`, `pane_rename`, and
the layout calls work as for any pane. The process monitor and the agent
heuristics skip a pane that has no PTY.

Calls:

| Call               | Params                          | Effect                                                    |
|--------------------|---------------------------------|-----------------------------------------------------------|
| `browser_open`     | `worktree_id`, `url?`, `tab_id?` | Creates a browser pane. Without `tab_id` it opens a new tab titled `Browser`. Returns `{ pane, tab }`. |
| `browser_navigate` | `pane_id`, `url`                | Stores the url and emits `pane_changed`.                  |

The CLI has `tomo browser open [worktree] [--url U]`.

## Worktree identity

A browser pane belongs to exactly one worktree, like every pane.

## Child webview mechanics

The Tauri process owns the page. The main window is a plain window whose
React webview (`main`) is itself a child webview that auto-resizes with
the window; `tauri.conf.json` declares the window with `create: false`
and `open_main_window` in `app/src-tauri/src/lib.rs` builds it. This
matters on macOS: a webview created as the window content replaces the
content view, and a child added later lands in the old view and never
paints. For each browser pane the GUI asks the host for a child webview
labelled `browser-<pane id>` in that window (`tauri` with the `unstable`
feature, `Window::add_child`). The
React component `app/src/browser/BrowserPane.tsx` renders a toolbar and an empty
host box; it measures the box with a `ResizeObserver` and on every render,
and pushes the bounds to `browser_set_bounds` in logical pixels. The child
webview covers the box.

The host emits `browser://state` to the main webview on navigation, page
load, and title change. The component updates the url field and the pane
legend, and persists each new url with `browser_navigate` so a daemon
restart restores the last page.

A child webview paints above the main webview. While a menu, a dialog, or
the palette is open, the component hides the child with
`browser_set_visible` so the floating surface stays visible.

## Lifetime: the pane owns the webview

Only the active tab renders, so the component unmounts on a tab switch, on
a worktree switch, and on a move to a global view. The component does not
own the webview. On unmount it hides the child and keeps it alive, so the
page, its heap, and its session cookies stay.

`BrowserHost` in `BrowserPane.tsx` is mounted for the whole session, beside
the addon `mount` slots in `App.tsx`. It watches the browser pane ids in the
store and calls `browser_close` for each id that leaves. That covers a pane
close, a tab close, a worktree whose tabs go, and a daemon reconnect that
drops the pane. `browserPaneIds` in `browser.ts` is the sorted list, so an
unchanged set gives an unchanged array.

A remount calls `browser_create` again. The command finds the webview, sets
the bounds, and then shows it. The order is necessary: a hidden webview
keeps the rect that it had before, so a show before the bounds paints the
page in the old place for one frame.

### What sleep gives back

A hidden pane sleeps, but it does not stop. `browser_set_visible(false)`
becomes `WKWebView.setHidden(true)` in wry
(`wry-0.55.1/src/wkwebview/mod.rs`, line 1031). The web process stays.
macOS stops the drawing of a hidden view. WebKit also ties the visibility
of a page to the view, so the timers of the page are throttled and the
animation frames stop; this part is not proved here, because no window can
run in this environment. A human must confirm it with a page that has a
clock.

Tauri 2.11.5 gives no other control. The `Webview` API has `show`, `hide`,
`set_bounds`, `set_zoom`, `set_background_color`, `eval`, `reparent`, and
`close`. There is no call to suspend the process, to mute the audio, or to
drop the heap. So sleep here is "hidden but alive", and the honest cost is
one live web process for each browser pane.

Cost: each pane is one `com.apple.WebKit.WebContent` process, because wry
makes a new `WKWebViewConfiguration` for each webview
(`wry-0.55.1/src/wkwebview/mod.rs`, line 216). On this machine the main
webview of Tomo holds 87 MB resident and a physical footprint of 396 MB.
A page pane is usually smaller, but it is the same kind of process. There
is no cap on the count (decision 0 in `backlog.md`). If many sleeping panes
become expensive, the policy to try first is to close the browser panes of
the worktrees that the user does not look at, not a cap.

### Popups and OAuth

`on_new_window` still denies the popup and navigates the same webview, so
an OAuth flow that needs its opener still fails. A real child webview needs
these parts, and none of them can be proved without a window:

- `NewWindowResponse::Create { window }` (tauri 2.11.5,
  `src/webview/mod.rs`, line 249) with
  `WebviewWindowBuilder::window_features(features)`
  (`src/webview/webview_window.rs`, line 1362). On macOS that call copies
  the `WKWebViewConfiguration` of the opener. Without the same
  configuration the popup gets no `window.opener`.
- A unique label that starts with `browser-`, and a link from the popup to
  the pane, so that `browser_close` closes the popups of that pane.
- A way to close the popup: by the user, and by the page itself. Whether
  `window.close()` from the page closes a Tauri window is not known.
- The builder runs inside the `on_new_window` callback, on the main thread,
  while WebKit waits for the answer. Whether `build()` is safe there is the
  first thing to test.

Commands: `browser_create`, `browser_set_bounds`, `browser_set_visible`,
`browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`,
`browser_close` (in `app/src-tauri/src/browser.rs`). The main window may
call all of them.

Browser offers three hooks, and names no addon:

- the `browserToolbar` slot: `BrowserPane` renders each item after the url
  field with `{ paneId, worktreeId, url, setCovering }`, and hides the page
  while an item is covering it;
- `BROWSER_PAGE_LOADED` in `app/src-tauri/src/lib.rs`: `browser_create` calls
  each entry with the webview and the pane id when a page finishes loading;
- `BROWSER_CLOSED` in the same file: `browser_close` calls each entry with the
  app and the pane id.

## Toolbar

The toolbar is: back, forward, reload, url field, the `browserToolbar`
items, and open-external. The toolbar never scrolls sideways: the buttons
do not shrink, and the url field shrinks to 40 px.

An addon can add toolbar items that send the page to an agent. For an
example, see the Agentation addon on the
[`simon-main`](https://github.com/simonbukin/tomo/tree/simon-main) branch.

## What is not persisted

- Page history, cookies, and form state live in the webview. They stay
  while the pane exists, a tab switch included, and they vanish when the
  pane closes or when the GUI restarts.
- Scrollback does not exist for a browser pane.
