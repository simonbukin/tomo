# Browser panes

A browser pane shows a web page inside a worktree tab. It sits in the
layout tree like a terminal pane, but it has no PTY, no shell, and no pid.
Its purpose is to look at the running app of a worktree and to send
annotated evidence to an agent that already works in that worktree.

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
| `annotations_send` | `pane_id`, `bundle`             | Types the bundle into the agent pane. See below.          |

The CLI has `tomo browser open [worktree] [--url U]`.

## Worktree identity

A browser pane belongs to exactly one worktree, like every pane. The GUI
lists only the live agents of that worktree in `Send to…`. The daemon
labels the evidence with the worktree name and branch, so the agent knows
which tree the page came from.

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
- A unique label that starts with `browser-`, so that the `browser`
  capability still grants `browser_feedback`, and a link from the popup to
  the pane, so that `browser_close` closes the popups of that pane.
- A way to close the popup: by the user, and by the page itself. Whether
  `window.close()` from the page closes a Tauri window is not known.
- The builder runs inside the `on_new_window` callback, on the main thread,
  while WebKit waits for the answer. Whether `build()` is safe there is the
  first thing to test.

Commands: `browser_create`, `browser_set_bounds`, `browser_set_visible`,
`browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`,
`browser_close` (in `app/src-tauri/src/browser.rs`), and the Agentation
commands `browser_set_annotate`, `browser_clear_annotations` (in
`app/src-tauri/src/agentation.rs`). The main window may call all of them.
`browser_feedback` is the one command a page may call; the `browser`
capability grants it to `browser-*` webviews for `http://*:*` and
`https://*:*` origins.

Browser offers three hooks, and names no addon:

- the `browserToolbar` slot: `BrowserPane` renders each item after the url
  field with `{ paneId, worktreeId, url, setCovering }`, and hides the page
  while an item is covering it;
- `BROWSER_PAGE_LOADED` in `app/src-tauri/src/lib.rs`: `browser_create` calls
  each entry with the webview and the pane id when a page finishes loading;
- `BROWSER_CLOSED` in the same file: `browser_close` calls each entry with the
  app and the pane id.

## Feedback overlay: Agentation

Agentation is an addon on top of Browser. Its code:
`app/src/addons/agentation/` (the toolbar items and the page source in
`page/`), `app/src-tauri/src/agentation.rs`,
`crates/tomod/src/addons/agentation/`, and
`crates/tomo-proto/src/addons/agentation.rs`. Browser works without it; see
"Milestone 7 result: Agentation" in [addons.md](addons.md).

The overlay is [Agentation](https://www.npmjs.com/package/agentation)
(`agentation@3.0.2`), the feedback toolbar that other agent IDEs also
embed. It is a React component. It puts a floating toolbar into the page,
adds its own `<style>` tags, and lets the user click an element and write
a note about it.

### The bundle

`app/src/addons/agentation/page/entry.tsx` wraps the component. `pnpm -C app
build:agentation` builds it with `app/vite.agentation.config.ts` into one
minified IIFE, `app/src-tauri/agentation/agentation.js` (about 622 kB, 157
kB gzip). The file is committed, because the host includes it with
`include_str!`. Build it again after an upgrade of `agentation` or a
change to `app/src/addons/agentation/page/`.

The bundle defines `window.__tomoAgentation = { set(enabled), clear() }`
one time. `set(true)` mounts `<Agentation copyToClipboard={false}>` with
its own React root in a `div[data-tomo-agentation]` on the document
element. `set(false)` unmounts it.

### Injection only when on

The bundle is not an initialization script, and only enabling carries it.
So a page that is never annotated does not load it, and has no
`window.__tomoAgentation`. The toolbar calls
`browser_set_annotate(pane_id, enabled)` only when the user turns Annotate
on or off, never when the pane mounts. The command records the flag for the
pane. Then:

- `enabled: true` evaluates `if (!window.__tomoAgentation) { bundle }` and
  `window.__tomoAgentation.set(true)`, and gives the page keyboard focus. The
  guard makes a second evaluation skip the bundle.
- `enabled: false` evaluates only
  `window.__tomoAgentation && window.__tomoAgentation.set(false)`.

A navigation replaces the page. So on each `PageLoadEvent::Finished` the
Agentation page-load hook evaluates the bundle and `set(true)` again, only
for a flagged pane. The Agentation close hook clears the flag in
`browser_close`.

### The feedback command

The entry keeps the list of notes. It seeds the list from
`loadAnnotations(location.pathname)` when it mounts and updates it from
the add, update, delete, and clear callbacks. After each change it calls
`window.__TAURI_INTERNALS__.invoke("browser_feedback", { kind, count,
markdown })`:

| `kind`   | When                                   | `markdown`                                     |
|----------|----------------------------------------|------------------------------------------------|
| `change` | mount, and each change to the list     | `feedbackMarkdown(url, title, notes)` from `app/src/addons/agentation/page/markdown.ts` |
| `copy`   | the Agentation copy button             | Agentation's own markdown                      |
| `submit` | the Agentation send button             | Agentation's own output                        |

The host reads the pane id from the webview label, never from the page.
It accepts `copy` and `submit` only while the pane is flagged, and it
refuses every other kind. It emits `browser://feedback`
`{ pane_id, kind, count, markdown }` to the main webview.

`feedbackMarkdown` writes a heading with the page title and url, then one
numbered item for each note: the element name, the `elementPath` in
backticks, the comment, and optional `selected`, `nearby`, `react`, and
`source` lines.

### Copy and send

The toolbar is: back, forward, reload, url field, Annotate. When the page
has notes, a count badge, `Copy feedback`, and `Send feedback to an
agent` follow. Open-external is last. Annotate, the count, and the two
buttons are the `browserToolbar` item of Agentation. `change` updates the count and the
markdown. `copy` puts the markdown on the clipboard. `submit` opens the
Send menu, and the page hides while it is open. A change of the pane url
(a link in the page, Enter in the url field, or a daemon navigation) resets
the count until the page reports again.

The Send menu lists the live agents of the worktree (`Claude — working`)
and `Copy as markdown`. The toolbar never scrolls sideways: the buttons
do not shrink, the url field shrinks to 40 px, and under a pane width of
360 px the count badge and open-external are hidden.

## Evidence bundle

An agent entry calls `annotations_send` with an `EvidenceBundle`:

```json
{
  "source": "browser feedback",
  "worktree_id": "a3dc426aa592",
  "url": "http://localhost:1420/",
  "action_id": null,
  "annotations": [],
  "instruction": "Review and address this feedback.",
  "markdown": "## Tomo (http://localhost:1420/)\n\n1. button `main > button` …",
  "note_count": 3
}
```

The daemon requires a live agent (Claude, Codex, or Pi) in the target pane.
When `markdown` is present, it is the body of the text:

```text
Browser feedback from Tomo
worktree: labor (feat/labor-relations)
runtime: http://localhost:1420/

## Tomo (http://localhost:1420/)

1. button "Save" `form > .actions > button`
   wrong color
   selected: "Save"

Review and address this feedback.
```

Without `markdown`, the body is the older list of `annotations`
(`1. [#save] "Save" — wrong color`). `runtime` is the source label of a
running pane in the worktree whose Action id is `action_id`, else the url. The text goes to the agent's PTY
inside a bracketed paste (`ESC [200~ … ESC [201~`) followed by a carriage
return, so a multi-line block arrives as one input and then submits
(`Daemon::paste_to_agent`, a Core function). The Agentation addon records an `annotations_sent` activity event (payload: the bundle)
with the title `Sent 3 notes → Claude` when `note_count` is set, else
`Sent N annotations → Claude`. It runs the `annotation.sent` hooks. The
GUI calls `browser_clear_annotations`, which runs
`window.__tomoAgentation.clear()`, and shows `Sent 3 notes to Claude`.

## What is persisted

- Agentation keeps notes in the page's `localStorage`, one list for each
  path. A reload or a return to the path shows them again. `clear()`
  saves an empty list for the current path.
- The daemon stores only the bundles that were sent, in the `activity`
  table.

## What is not persisted

- Page history, cookies, and form state live in the webview. They stay
  while the pane exists, a tab switch included, and they vanish when the
  pane closes or when the GUI restarts.
- Scrollback does not exist for a browser pane.
- The `annotate` toggle is component state; it resets when the pane
  remounts.
