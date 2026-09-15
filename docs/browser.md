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
main window may call all of them. `browser_feedback` is the one command a
page may call; the `browser` capability grants it to `browser-*` webviews
for `http://*:*` and `https://*:*` origins.

## Feedback overlay: Agentation

The overlay is [Agentation](https://www.npmjs.com/package/agentation)
(`agentation@3.0.2`), the feedback toolbar that other agent IDEs also
embed. It is a React component. It puts a floating toolbar into the page,
adds its own `<style>` tags, and lets the user click an element and write
a note about it.

### The bundle

`app/agentation/entry.tsx` wraps the component. `pnpm -C app
build:agentation` builds it with `app/vite.agentation.config.ts` into one
minified IIFE, `app/src-tauri/agentation/agentation.js` (about 620 kB, 157
kB gzip). The file is committed, because the host includes it with
`include_str!`. Build it again after an upgrade of `agentation` or a
change to `app/agentation/`.

The bundle defines `window.__tomoAgentation = { set(enabled), clear() }`
one time. `set(true)` mounts `<Agentation copyToClipboard={false}>` with
its own React root in a `div[data-tomo-agentation]` on the document
element. `set(false)` unmounts it.

### Injection only when on

The bundle is not an initialization script, so a page that is never
annotated does not load it. `browser_set_annotate(pane_id, enabled)`
records the flag for the pane, then evaluates
`if (!window.__tomoAgentation) { bundle }` and
`window.__tomoAgentation.set(enabled)`. The guard makes a second
evaluation skip the bundle. A navigation replaces the page, so on each
`PageLoadEvent::Finished` the host evaluates the bundle and `set(true)`
again for a flagged pane. `browser_close` clears the flag. Enabling also
gives the page keyboard focus.

### The feedback command

The entry keeps the list of notes. It seeds the list from
`loadAnnotations(location.pathname)` when it mounts and updates it from
the add, update, delete, and clear callbacks. After each change it calls
`window.__TAURI_INTERNALS__.invoke("browser_feedback", { kind, count,
markdown })`:

| `kind`   | When                                   | `markdown`                                     |
|----------|----------------------------------------|------------------------------------------------|
| `change` | mount, and each change to the list     | `feedbackMarkdown(url, title, notes)` from `app/agentation/markdown.ts` |
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
agent` follow. Open-external is last. `change` updates the count and the
markdown. `copy` puts the markdown on the clipboard. `submit` opens the
Send menu. A url change from the page resets the count until the page
reports again.

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
(`1. [#save] "Save" — wrong color`). `runtime` is the label of the Action
named by `action_id`, else the url. The text goes to the agent's PTY
inside a bracketed paste (`ESC [200~ … ESC [201~`) followed by a carriage
return, so a multi-line block arrives as one input and then submits. The
daemon records an `annotations_sent` activity event (payload: the bundle)
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

- Page history, cookies, and form state live in the webview and vanish
  when the pane closes or the tab switches away.
- Scrollback does not exist for a browser pane.
- The `annotate` toggle is component state; it resets when the pane
  remounts.
