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
React component `app/src/BrowserPane.tsx` renders a toolbar and an empty
host box; it measures the box with a `ResizeObserver` and on every render,
and pushes the bounds to `browser_set_bounds` in logical pixels. The child
webview covers the box.

The host emits `browser://state` to the main webview on navigation, page
load, and title change. The component updates the url field and the pane
legend, and persists each new url with `browser_navigate` so a daemon
restart restores the last page.

A child webview paints above the main webview. While a menu, a dialog, or
the palette is open, the component hides the child with
`browser_set_visible` so the floating surface stays visible. The child is
closed when the component unmounts, so a tab switch reloads the page.

Commands: `browser_create`, `browser_set_bounds`, `browser_set_visible`,
`browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`,
`browser_close`, `browser_set_annotate`, `browser_clear_annotations`. The
main window may call all of them. `browser_annotations` is the one command
a page may call; the `browser` capability grants it to `browser-*`
webviews for `http://*:*` and `https://*:*` origins.

## Annotation overlay

`app/src-tauri/src/annotate.js` is the initialization script of every
browser webview. It runs on each page and stays idle until the host calls
`window.__tomoAnnotate.set(true)`. When it is on:

- the page takes keyboard focus, and the element under the pointer gets
  an outline;
- a click selects the element and opens a small note box; Enter saves the
  note, Escape cancels it; the page does not receive the click;
- a badge in the corner shows the note count.

Each saved note is an `Annotation`: the note text, `location.href`, a
short CSS selector (the element id, or a `tag:nth-of-type(n)` chain of at
most six levels that is unique on the page), the first 120 characters of
the element text, and the element rectangle in CSS pixels.

After every change the page calls
`window.__TAURI_INTERNALS__.invoke("browser_annotations", …)`. The host
reads the pane id from the webview label, never from the page, and emits
`browser://annotations` to the main webview. The component shows
`N annotations · Send to…`.

## Evidence bundle

`Send to…` lists the live agents of the worktree and `Copy as text`. An
agent entry calls `annotations_send` with an `EvidenceBundle`:

```json
{
  "source": "browser annotation",
  "worktree_id": "a3dc426aa592",
  "url": "http://localhost:1420/",
  "action_id": null,
  "annotations": [ … ],
  "instruction": "Review and address these annotations."
}
```

The daemon requires a live agent (Claude, Codex, or Pi) in the target pane.
It formats the bundle as plain text:

```text
Browser annotations from Tomo
worktree: labor (feat/labor-relations)
runtime: http://localhost:1420/

1. [#save] "Save" — wrong color
2. [main > p:nth-of-type(2)] "Hello" — cut off

Review and address these annotations.
```

`runtime` is the label of the Action named by `action_id`, else the url.
The text goes to the agent's PTY inside a bracketed paste
(`ESC [200~ … ESC [201~`) followed by a carriage return, so a multi-line
block arrives as one input and then submits. The daemon records an
`annotations_sent` activity event (`Sent N annotations → Claude`, payload:
the bundle) and runs the `annotation.sent` hooks. The GUI clears the notes
and shows a toast.

## What is not persisted

- Page history, cookies, and form state live in the webview and vanish
  when the pane closes or the tab switches away.
- Notes live in the page. A navigation or a reload drops the notes that
  were not sent. The daemon stores only the bundles that were sent, in the
  `activity` table.
- Scrollback does not exist for a browser pane.
- The `annotate` toggle is component state; it resets when the pane
  remounts.
