# UI foundation

Tomo's frontend is React, Vite, TypeScript, xterm.js, Lucide, and Base UI.
Base UI solves interaction. Tomo owns the design. The result must feel like
Tomo, not like a component library.

## Rules

- Before you build a menu, dialog, popover, tooltip, select, button, or
  command surface, use `app/src/components/ui/`. Do not hand-roll a generic
  interaction primitive.
- Files in `components/ui` know nothing about worktrees, agents, repos, or
  the store. They take props and use CSS classes from `app/src/styles/ui.css`.
- Product components live next to the feature (`Sidebar.tsx`, `Home.tsx`,
  `WorktreeHeader.tsx`). They call the primitives and the store.
- Style with Tomo CSS classes and tokens. No utility-class soup in product
  code. No hard-coded colors in components.
- Every icon-only control is an `IconButton` with a `label`. The label is
  the tooltip and the accessible name. Pass `shortcut` when a registry
  command does the same thing, so the tooltip shows its key.
- Keys, the palette, context menus, the shortcut reference, and the menu
  bar read one command registry. See `docs/keyboard.md`.
- Use `ConfirmDialog` for every confirmation. Pass `destructive` only when
  the action cannot be undone.
- Use Popover for small anchored UI. Use Dialog only when the user must
  finish a task before they continue.

## NOW cards

A worktree row or card shows signals, not a status dump. `signalsFor` in
`app/src/Signals.tsx` calls `nowSignals` in `app/src/activityModel.ts` and
keeps at most three, in this order:

1. needs attention: an open checkpoint (`◉ review requested`), then a
   waiting agent. A waiting agent is its own agent line in amber
   (`● Claude needs input`), never a second item. A waiting attention item
   counts only while its agent still waits; the daemon resolves it when the
   agent moves on
2. crash: an unresolved `crash` attention item (`× Storybook crashed`)
3. active agents (`● Claude`, with the process icon)
4. the primary HTTP runtime (`App ↗ :3000`)
5. memory over `resource_warning_bytes` (`⚠ 4.8 GB`)
6. addon signals from the `worktreeSignals` slot, in `builtins` order. The
   GitHub addon adds a merged pull request (`merged`) or failed checks
   (`checks failed`) that the session already knows

A healthy quiet worktree shows at most `Claude ●` and `App ↗`. The dots
and colors are the shared status vocabulary from `base.css` and
`app/src/signals.css`. No new colors,
no cards inside cards. The list row keeps its grid and puts the signals in
the `agents` column. The board card shows name, the repo, the
signals, then `+12 −4` when the diff is not empty.

## Activity view

`app/src/Activity.tsx` is the fourth view (`home`, `worktree`, `towns`,
`activity`). The sidebar `History` button and the palette command
`Activity` open it. The header holds `activity`, the filter
(`All | Needs me | This worktree`). Usage lives in the bottom strip, not
here. The list groups events by day (`today`, `yesterday`, `Mon 14 Sep`) with
`.section-label` headings and 30 px rows: time, who (agent with process
icon, action label, `You`, or the worktree), title, detail, and text-button
actions derived from the event kind (`Open App`, `Go to Claude`, `Logs`,
`Restart`, `Resolve`, `Restore`).

The store loads 200 events with `activity_list` when the view opens,
prepends `activity_added` events, and keeps at most 500 in memory. `load
more` pages with `before_ms`. Every daemon call fails soft: an empty list,
no toast.

## New worktree dialog

The branch field is the `Combobox` primitive, not a plain input. It lists the
branches of the repository from the daemon call `branch_list`, newest commit
first. Typing filters the list, and text that matches nothing stays in the box,
so a branch name from a pull request works with one paste.

- Picking a branch that exists turns `create this branch` off.
- Picking a branch that only a remote has keeps `create this branch` on and
  starts it from `<remote>/<name>`, which the dialog shows as
  `tracks origin/<name>`.
- An empty box is valid. The placeholder shows the branch the daemon will make:
  `branch_prefix` plus the worktree name (see [data-model.md](data-model.md)).
  The Create button is enabled with an empty box.
- Keyboard: type, arrow to a branch, Enter creates. Enter with nothing
  highlighted creates from the text in the box.

## Sidebar order, appearance, and terminal keys

- The main worktree of a repo shows a star and always sorts first, in
  every sort mode.
- Every worktree row has the same height: two lines, 42 px. The first line
  holds the status dot, the name, the star, and the row menu. The second
  line holds the archive mark, the branch, the tags, and then the signals. Neither
  line wraps. Each part cuts with an ellipsis, and the signals keep their
  width before the branch does.
- Drag a worktree row or a repo header to reorder it. The first drop
  switches the sidebar to `manual` sort and keeps the order that was on
  screen for everything else. The order lives in UI state
  (`manualOrder`, `repoOrder`). Dragging uses dnd-kit pointer and
  keyboard sensors: HTML5 drag and drop is unreliable in the Tauri
  webview.
- Cmd or Ctrl with `+`, `-`, and `0` zooms the whole window through the
  webview zoom. The bottom status slot shows the new zoom. `Reset zoom` in
  the View menu goes back to 100 %.
- The Settings dialog (⌘,, the bottom strip button, or `Settings…` in the
  palette) edits `config.toml` through `config_set`: theme, accent, color
  overrides, terminal font, keybindings, agents, notifications, archive
  cleanup, and the editor. `config.toml` is the source of truth for theme
  and terminal font. Only the zoom lives in UI state. See
  [theming.md](theming.md).
- Shift+Enter in a terminal sends ESC CR instead of a bare CR, so Claude
  Code, Codex, and Pi insert a newline. The mapping is `keyOverride` in
  `appearance.ts`, with a unit test.

## Tabs, panes, and dividers

- The `+` after the last tab opens a new tab (terminal, browser, claude,
  codex, pi) or splits the focused pane of the current tab (`split right`,
  `split down`, `split with` a browser or an agent). Each pane header also
  has split right and split down buttons.
- A tab chip shows what leads the tab: the process icon of the agent or the
  command, the globe of the pane legend when the lead pane is a browser, or
  the amber dot when an agent waits.
- Drag a tab to reorder it. The other tabs stay in place; an accent line
  shows where the tab lands. The strip changes at once, then the
  `tabs_changed` snapshot from `tab_move` wins. The order persists.
- Pin a tab with `pin tab` in its menu or in the palette (`tab_pin`,
  `tomo tab pin`). The daemon stores the pin. A pinned tab is one 28 px
  square at the left of the strip: the process icon and a small state
  mark, with no title and no close button. The title is in the tooltip,
  and a rename opens a dialog. Pinned tabs never shrink.
- Pinned tabs always come before unpinned tabs. A drag or `move left`
  and `move right` never pin or unpin: the tab stays inside its own group,
  and the daemon clamps the position to that group. A new pin goes to the
  end of the pinned tabs; an unpin goes to the start of the unpinned tabs.
- The mark of a tab: the agent mark when an agent runs in the tab.
  Otherwise, for a tab that a pane-mode hook opened: `working` while the
  hook command runs, `done` when it exits 0, and `dead` when it exits with
  another code. A plain shell has no mark. The hook script prints a
  private OSC (`ESC ] 7771 ; tomo-hook-exit=<code> BEL`) that the daemon
  reads into `hook_exit_code` on the pane. It is memory only, so the hook
  mark goes away after a daemon restart.
- `next_tab` and `prev_tab` include pinned tabs, in strip order. A pinned tab closes with the same confirmation as other tabs.
- Drag a pane by its title chip in the legend. The terminal body never
  starts a drag, so text selection works as before. While the drag is
  active, a translucent shape shows the layout that the drop makes, not the
  region under the pointer: the box the pane takes, with the box the target
  keeps as a dashed outline. The outer quarter of each side splits that side
  (`split left`, `split right`, `split up`, `split down`), and the middle
  swaps the two panes. The shape moves at `--dur-open` and `--ease-out`, and
  the region holds until the pointer moves 10 px, so a boundary does not
  flicker. Escape cancels.
- Drop a pane on another tab to add it to that tab as a right split. If
  the pane was the last one of its tab, that empty tab closes; no process
  stops. A tab that already holds `max_panes_per_tab` panes refuses the
  drop. Panes never move to another worktree.
- A pane whose agent sleeps shows `SleepView`: the saved terminal in a
  read-only xterm under a bar that says `asleep · a key or a click wakes the
  agent`. Scroll, select, copy, and Cmd-K terminal search work. A key or a
  click (not a drag) calls `pane_wake`; the key is not sent. App shortcuts
  and Cmd chords still work. While the agent resumes, the bar says
  `waking…`, and the live terminal comes back at the first hook event. The
  pane menu has `wake` and a `keep awake` check. In Cmd-K, a sleeping
  agent shows as `wake Claude · <worktree>`.
- A drop always calls `pane_move`, which uses the same split-tree
  functions as the commands. `LayoutDnd.tsx` holds the one drag context
  for the tab strip and the split layout, and it draws the preview.
  `layoutModel.ts` holds the pure helpers (drop region from the pointer,
  the region that holds at a boundary, the box of each pane, the boxes
  after a move, tab reorder) with unit tests. The preview calls the same
  `movePane` as the drop, so the picture cannot disagree with the result.
- Known limit: a browser pane has no drag handle and is not a drop
  target. Its body is a native webview that does not get pointer events
  from the Tomo window.
- An editor pane keeps its buffer, its undo history, and its scroll when
  the tab switches away or the pane moves. The legend and the tab show `●`
  before the file name while the buffer has edits. See [editor.md](editor.md).
- A browser pane keeps its page when the tab switches away. The webview
  sleeps: it stays in memory with its page and its session, and it stops
  drawing. It comes back at the new size, and it closes with the pane. So
  a login survives a tab switch. See [browser.md](browser.md).
- Dividers are invisible until hover. The grab area is 8 px wider than
  the line. Double-click a divider to set that split to 50/50.
- Rest the pointer on a background terminal tab to see the last lines of
  its output (`pane_tail`, plain text, no terminal rendering).
- Home board: group by `tag` gives one column for each tag and one column
  for no tag. A worktree with two tags has a card in each column. Drag a
  card from column A to column B to replace tag A with tag B. A drop on the
  no-tag column only removes tag A. The order inside a column stays the
  configured sort.

Keyboard parity (palette groups `Tabs` and `Panes`, defaults in
[data-model.md](data-model.md)): `move_tab_left`, `move_tab_right`,
`move_pane_left/right/up/down` (swap with the neighbor in that direction),
and `equalize_panes`.

The torture page (`#ui-torture`) has a tab strip and a nested pane grid on
local state. Use it to try every drop region, a drop on self, a cancel, and
a small window. A line under the grid names the pane under the pointer and
its region, so you can see the preview and the region together.

## Status glyphs

`app/src/glyphs.ts` holds the one status vocabulary:

```text
● working    ◉ needs you    ○ idle    ■ done    ✓ complete    × failed    ? no signal
```

A live mark is always a square. Motion and fill tell the states apart, then
color. The mark means one thing on every surface: the sidebar row, the Home
card and row, the rail, tabs, the pane legend, the hover card, and a
subagent line (a smaller matrix). [agent-states.md](agent-states.md) is the source of these rules.

| Mark | Status | Meaning | Tooltip |
|------|--------|---------|---------|
| green, all cells twinkle | working | a turn is in progress, or a subagent of the agent runs | `working · 2 min` |
| green, all nine cells, still | done | the turn finished and nobody has looked at the pane since | `done · finished 3 min ago` |
| amber plus, beats in unison | needs | the agent waits for an answer or a permission | `needs you` |
| grey center cell | idle | the agent is alive, has no turn, and was seen | `idle` |
| red X | failed | the agent ended with a failure | `dead · exited` |
| grey corners | unknown | Tomo has no hook events from the agent | ``no signal · run `tomo integrations install` `` |
| grey Z | sleeping | Tomo ended the idle agent; a key wakes it | `sleeping · idle 2 h · a key wakes it` |
| green Z | sleeping-done | the agent slept after a turn that nobody looked at | `sleeping · done 2 h · a key wakes it` |
| grey, all cells twinkle | archiving | Tomo checkpoints and removes the worktree | `archiving` |
| no mark | none | no agent |  |

The mark is a 3×3 matrix of whole-pixel cells: 2px cells with 1px gaps at
8px, and no gaps at the 6px subagent size. Color says what, motion says busy,
and the pattern tells the still states apart. When the state changes, the
same element keeps its cells, which fade to the new pattern. With
`prefers-reduced-motion`, nothing twinkles or beats. A state that the CPU fallback estimated
(`AgentPresence.estimated`) looks the same, and its tooltip ends with
`(estimated from CPU)`. `complete` (the green ring) is for work that
ended, such as a merged PR or an Action that exited 0. It is not an agent
mark.

`StateMark`, `AgentMark`, and `WorktreeMark` in `app/src/StateMark.tsx` draw
every mark. `effectiveState` in `glyphs.ts` shows a done or idle agent with a
running subagent as working. `worktreeLead` in `app/src/homeQuery.ts` picks
the agent whose mark is the worktree mark, first match wins: needs you, dead
and not seen, working, done, dead and seen, idle, no signal, sleeping after
done, sleeping. An awake agent always wins over a sleeping one. Only agents
count. `agentMark` in `glyphs.ts` gives the mark of one agent. A crash of an Action is a row signal (`storybook exited 1`) and a red
square on its own Action button, never the worktree mark. It stays in the
attention list.

`useAgentSeen` in `app/src/agentSeen.ts` calls `agent_seen` when an agent
pane has focus in a focused, visible window. When the turn ends while you
look, it waits 1.5 s first, so the done mark is visible. A sidebar row, a Home card, and a Home list row each grow one unit
for each live subagent, indented under the name. They show every subagent,
with no count of the rest. All three use `SubagentList` from
`app/src/WorktreePreview.tsx`.

`agentStatus` maps agent states onto it. `activityStatus` in
`app/src/activityKinds.ts` maps activity kinds onto it through the kind
registry (see [activity.md](activity.md)). Dense rows (sidebar, Home, tabs, checkpoint banner, signals) draw the
square `.state` mark from `StateMark` or `dotClass(status)`. Text surfaces (Activity rows,
palette hints) print `GLYPH[status]`. Do not add a glyph
or a status color for one feature.

## Hover previews

`HoverCard` (`components/ui/preview-card.tsx`, Base UI `PreviewCard`) opens
after 500 ms on hover. `app/src/HoverPreviews.tsx` renders the content from
data that the client already has:

- agent signal: kind, state, short session id, time since the last state
  change
- runtime signal and the endpoint arrow on an Action button: label,
  host:port, process and pid, time since discovery
- worktree header branch: ahead/behind, changed and untracked files,
  `+ins −del`, head, path

Clicks inside a card do not reach the row under it.

## Notifications

See [notifications.md](notifications.md) for the full model. In short: a
small success that the user started is a status message in the bottom strip
(`✓ Copied path`). A failure or an exceptional event is a toast in the dock
at the bottom right, above the strip. Tomo internals go to Diagnostics, not
to a toast and not to Activity. A dismissed toast never resolves attention.

A new attention item goes through `attentionDelivery` in
`app/src/notifyRoute.ts`. The in-app indicators (sidebar dot or rail `◉`,
tab dot, Activity count) always render from state:

| Tomo window | Crash | Waiting agent | Human checkpoint |
|-------------|-------|---------------|------------------|
| not focused | toast + desktop | desktop | chime + toast + desktop |
| focused, elsewhere | toast with `Logs` and `Restart` | nothing extra | chime + toast with `Open` and `Resolve` |
| focused on that pane | nothing extra | nothing extra; marked seen | chime |

Desktop notifications use `tauri-plugin-notification` and need
`[notifications] desktop`. The chime plays only when `[notifications] sounds`
is on.

## Palette search

A typed query in the palette shows groups. [search.md](search.md) has the
sources, the prefixes, and the numbers.

- A group header is one unit high: the group name in mono `--fs-0` and
  `--fg-3`, with a line above it. It shows `searching…` while its daemon
  source has not finished, and `+N` when a group that no prefix narrows to
  has more hits.
- A name hit is one unit high. A content hit (a session message, a
  terminal line, an activity detail) is two units high: the label and
  `worktree · age` on the first line, the snippet in mono `--fs-1` on the
  second.
- `mark` shows the match: the substring, or the characters of a fuzzy
  match. It uses `--accent-soft`; on the active row it is a lighter
  mix of `--bg`.
- `+N more in files` is a row of its own, with the prefix in a key cap.
- The footer lists the prefixes while the query is empty, and the keys
  while a query is typed.

`app/src/searchModel.ts` holds the pure parts (scope, groups, rows,
highlight). `app/src/search.ts` holds the daemon hook and what Enter does.

## Terminal links and file drop

- Move the pointer over a URL or a file path in a terminal: a light dotted
  line shows under it. Hold Cmd: the line is solid and the pointer changes.
  A plain click does nothing. xterm draws only a solid underline, so the
  dotted line is an element over the cells of the link (`.term-link-hint`).
- Cmd-click a URL: the worktree browser pane opens it.
- Cmd-click `path`, `path:line`, or `path:line:col` inside the worktree:
  an editor pane opens the file at that place (see [editor.md](editor.md)).
  A pane that already shows the file takes the focus. A path outside the
  worktree goes to the daemon call `open_location`, which starts
  `editor_command` at that place. See `editor_command` in
  [data-model.md](data-model.md).
- A relative path resolves against the pane cwd first, then against the
  worktree root. A path is a link only when the daemon call `paths_exist`
  finds it on disk.
- Right-click a URL: `open in pane`, `open in external browser` (the system browser),
  and `copy link`. Right-click a file path: `open in pane` (only inside the
  worktree), `open in editor` (`editor_command`), `reveal in finder`, and
  `copy path`.
- Drop Finder files on a terminal pane: Tomo types the shell-escaped
  absolute paths, separated by spaces, through `pane_send`. On macOS, wry
  gives the drop position in view points, not in physical pixels. The hit
  test divides it by the webview zoom only.
- Cmd-V with an image and no text on the clipboard: the app command
  `clipboard_image` saves the image as a PNG file in
  `$TMPDIR/tomo-paste` through `osascript`. Tomo then pastes the
  shell-escaped path. Claude Code, Codex, and other agents attach an image
  from a pasted path. A shell gets a plain path. Tomo does not send Ctrl-V,
  because only some agents read the clipboard on Ctrl-V, and a shell reads
  it as a quoted insert.

The pure parts are `findLinks`, `resolvePath`, and `candidatePaths` in `links.ts`, and
`shellEscape`, `dropText`, and the hit test in `fileDrop.ts`. The xterm link
provider and the Tauri drop listener are in `terminalHooks.ts`.

## Primitives

| Component | File | Base UI part |
|-----------|------|--------------|
| `Button`, `IconButton` | `button.tsx` | plain `<button>` plus `Tooltip` |
| `DropdownMenu*`, `MenuItems`, `AnchoredMenu` | `menu.tsx` | `Menu` |
| `ContextMenu*` | `context-menu.tsx` | `ContextMenu` |
| `Dialog*` | `dialog.tsx` | `Dialog` |
| `ConfirmDialog` | `confirm-dialog.tsx` | `Dialog` |
| `Popover*` | `popover.tsx` | `Popover` |
| `PreviewCard*` | `preview-card.tsx` | `PreviewCard` |
| `HoverCard` | `preview-card.tsx` | `PreviewCard` |
| `Tooltip`, `TooltipProvider` | `tooltip.tsx` | `Tooltip` |
| `Select` | `select.tsx` | `Select` |
| `Combobox` | `combobox.tsx` | `Autocomplete` |
| `Separator` | `separator.tsx` | `Separator` |
| `Skeleton`, `SkeletonRows` | `skeleton.tsx` | none |

`MenuItems` renders the declarative `MenuItem[]` shape that `menus.ts`
builds. Pass a function so the items are computed when the menu opens.
`AnchoredMenu` opens a menu at a point or next to an element; `MenuHost.tsx`
uses it for every `openMenu(e, items)` call and puts focus back where it was,
a terminal included. It renders a zero-size hidden `Menu.Trigger` at the
anchor on purpose: Base UI registers a root menu's floating node through its
trigger, and a root without one closes itself (reason `sibling-open`) as soon
as a submenu opens.

## Tokens

`app/src/styles/tokens.css` holds every token, in the groups `DESIGN.md`
names: surfaces, text, borders, identity, semantic state, floating, type,
space, shape, and motion. Sofia Sans is the interface font, Sofia Sans Extra
Condensed is the display face, and Red Hat Mono is for terminal-adjacent
text: branches, paths, ids, commands, process rows, and shortcuts. Tomo
bundles all three. Selection is inversion: `--accent` is the text color.
Semantic colors (`--working`, `--waiting`, `--danger`, `--success`) keep their
meaning everywhere.

Rows and cells are one unit, `--u` (28 px), or two, `--u2`. Text sits
`--inset` (14 px) in. Spacing inside a cell uses 4, 8, 12, 16, 24. Every
radius is 0. Motion is 120 or 240 ms on one curve. `--traffic-inset` lives
in `layout.css`, not in `tokens.css`. Do not add a component token such as
`--sidebar-row-active-hover-background`. Write local CSS instead.

### Motion tokens

`tokens.css` holds one curve and two speeds. `--ease-in` and `--dur-hover`
stay as names for the same values, so older CSS still reads.

| Token | Value | Use |
|-------|-------|-----|
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | every transition |
| `--ease-in` | the same curve | close |
| `--dur-fast` | 120 ms | hover, press, and small state changes |
| `--dur-hover` | 120 ms | background and color on hover, and a surface that closes |
| `--dur-open` | 240 ms | menus, popovers, dialogs, the selection block |
| `--press-scale` | 1 | nothing scales |
| `--hit-min` | 28 px | the smallest clickable area |

The focus ring is 2 px and lives in `base.css`. The town reveal keeps its own
`--dur-reveal` in `addons/towns/towns.css`, because one addon uses it.

Lists never jump. `app/src/useFlip.ts` checks the sidebar, the Home cards, and the Home
list after every render. An item that
moves slides from where it was. A new item opens from its top edge, and a removed
item (an archived worktree, a finished subagent) stays where it was and shuts,
in step with the items that slide to make or close its space. A new item that takes
the exact place of a removed item replaces it at once, so the two lines never
show on top of each other. It uses `--dur-open`
and `--ease-out`, and it stops while a drag runs. Home does not animate the render
where the scope, the view, the grouping, or the search mode changes, because that
render shows a different page and not the same list. The board has no motion, because
its columns scroll on their own axis.

Under `prefers-reduced-motion: reduce` every duration is 0. The guard in `base.css` also stops every animation. No springs,
no bounce. `styles/interaction.css` applies the tokens.

## States

- **Loading.** Use `Skeleton` or `SkeletonRows` from `components/ui` in the
  place where the content will be. Never a full-screen spinner and never a
  bare `loading…` line. Data that is already on screen stays on screen
  while it refreshes.
- **Empty.** Use `EmptyState` from `app/src/states.tsx`: one short sentence,
  an optional detail, at most one action. Home shows `No repositories yet.`,
  `No active worktrees.`, or `No worktrees match.`; Activity shows
  `No activity yet.` or `Nothing needs you.`; Towns shows
  `0 / 1681 municipalities unlocked.` The copy lives in `emptyStates.ts`.
- **Error.** Show the error on the object that failed. A dialog shows
  `InlineError` above its buttons. A failed archive, restore, or Action run
  puts `× archive failed` on the worktree row in the sidebar, on Home, and in
  the worktree header (`RowError`, `setRowError` in the store). Hover shows
  the message, a click dismisses it, and the next success clears it. A toast
  can also show, but never alone.

## Focus, hit targets, and scroll

- Every control shows a subtle accent ring on `:focus-visible`.
- The focused pane has an accent border and a 1 px accent halo. The other
  panes in a split have a quiet border and a dimmed title.
- An icon button, a text link, and a disclosure toggle get an invisible hit
  area of at least 24 px. The visual size stays compact. Resize handles are
  8 px wide.
- Lists scroll inside their panel with `overscroll-behavior: contain`. The
  page itself never scrolls. Home rows drop the branch and diff columns
  below 760 px, so Home has no horizontal scroll bar.

## Shell geometry

The shell is a 3 x 3 grid (`.app` in `styles/layout.css`):

```text
top-left      | top-middle              | top-right
left sidebar  | middle workspace        | right sidebar
bottom strip (three sections on the same columns)
```

- The top strip (`--title-h`) and the bottom strip (`--bottom-h`) have a
  fixed height. They are never draggable. Fullscreen keeps both.
- `.app` sets `--left-col` and `--right-col` to the column width that is on
  screen: 0, the rail width (48 px), or the open width. The top strip and
  the bottom strip align their sections to these properties.
- Top-left: the traffic-light safe area, the Tomo mark (click goes Home),
  and the left sidebar control. This region is never narrower than
  `--top-left-min` (144 px, 72 px in fullscreen). When the left column is
  a rail or 0, the traffic lights do not move and no workspace UI goes
  under them.
- Top-middle: for a worktree, `WorktreeHeader` (name, branch, state on the
  left; `topbar` Actions, the editor button (`Zed` from `editor_command`),
  the Finder button (`reveal_finder`), runtime, and the overflow menu on
  the right). The `+` menu sits after the
  last tab. For Home, Activity, and Towns, a short view title. Nothing
  else: usage, metrics, daemon health, and Settings live in the bottom
  strip. The checkpoint banner stays at the top of the middle column.
- Top-right: only the inspector control.
- Zoom (Cmd `+`, `-`, `0`) shows `Zoom 110%` in the bottom status slot.

## Bottom strip

`app/src/shell/BottomStrip.tsx` fills the fixed bottom row. Its three
sections sit on the shell columns (`--left-col`, `--right-col`). A section
is never narrower than its content. The middle section starts with
`.bottom-items`: the `bottomItem` of each addon, in `builtins` order.

```text
?          + | Claude ━━━━━━━── 83%  Codex —   ✓ Copied branch   FPS 60  CPU 12%  MEM 8.4G  GPU 3% | ⚙ ● 0.1.3
```

- Bottom-left: `?` runs `keyboard_shortcuts`. The `+` at the right edge of
  the section opens the dialog that adds a repo. In the open sidebar, `+` is
  a `RevealButton`: on hover or focus, the label `new repo` opens to the
  left over the empty space, and nothing beside it moves. In the minimal
  rail, `+` is an `IconButton` with the tooltip `New repo`. When the left
  sidebar is closed on screen, the section is gone. The strip reads the mode
  on screen from `shellLayout`, not the saved mode.
- Usage (the usage addon, `app/src/addons/usage/`, see
  [usage.md](usage.md)): one item for each plan and one for each model
  scope that the adapter reports (`Claude`, `Fable`, `Codex`, `Sol`). A bucket's `scope`
  field names the model; a bucket without a scope counts for the whole
  plan. Pi runs on the Claude allowance and has no item. Each item shows its
  bucket with the highest use as a mono micro-bar and a percent.
  Hover shows every bucket with its reset time. A click opens a larger
  popover with a `refresh` link. A provider without data shows `—`; the
  reason is in the preview. Tomo never guesses a value. At 80 % the percent
  and the bar use `--waiting`, at 95 % `--hot`.
- Status slot: `StatusSlot` sits in the center between usage and metrics.
- System metrics: `CPU 12%  MEM 8.4G  GPU 3%` from the daemon call
  `system_stats` and the `system_stats` event (every 5 s while a client is
  subscribed). GPU shows only when the machine reports it. Whole percents
  and one decimal for memory. CPU at 85 % and memory at 85 % of total use
  `--waiting`; 95 % uses `--hot`. Hover or click shows CPU, memory used of
  total, GPU and VRAM when present, the worktree with the most memory, and
  the daemon's own memory. Metrics hide while the daemon is disconnected.
  Each label and its number center on one line. The UI face and the mono
  face put their capitals at different heights, so `text-box: trim-both cap
  alphabetic` trims each label and each number to its cap height and
  baseline. The version and the `new repo` label use the same trim.
  `FPS` before the metrics counts the frames of the webview. A click stops
  or starts the count.
- Bottom-right: the gear opens Settings. It is an `IconButton` with a
  tooltip and the shortcut. Then come the health dot and the app version
  (`getVersion`, else the daemon version). The dot has a text label (`Daemon healthy`,
  `Daemon reconnecting`, `Daemon disconnected`). Hover shows the daemon
  summary. A click opens diagnostics. See [diagnostics.md](diagnostics.md).

`HoverPopover` (`app/src/shell/HoverPopover.tsx`) joins a `PreviewCard` and
a `Popover` on one trigger. The preview closes while the popover is open.
The pure rules (headline bucket, thresholds, metric formatting, health
labels, diagnostics merge) are in `app/src/shell/bottomModel.ts` with unit
tests.

On macOS the daemon reads GPU utilization from
`ioreg -r -d 1 -w 0 -c IOAccelerator` (`Device Utilization %`) outside the
state lock. VRAM shows only when the driver reports `vramUsedBytes` and
`vramFreeBytes`; Apple silicon has unified memory and shows no VRAM. On
other systems GPU and VRAM are absent.

## Sidebar modes

Each sidebar has three modes (`leftMode`, `rightMode` in UI state):

| Mode | Left | Right |
|------|------|-------|
| open | full tree, 180 to 480 px | inspector sections |
| minimal | 48 px rail: Home, Activity with the attention count, Towns, one mark per worktree | one icon per inspector section |
| closed | column width 0 | column width 0 |

- The sidebar control, the shortcut, the View menu, and the palette run
  `toggle_left_sidebar` or `toggle_right_sidebar`: open, minimal, closed,
  open. The cycle starts from the mode on screen. The palette also has
  `left_sidebar_open`, `left_sidebar_minimal`, `left_sidebar_closed`, and
  the same three for the right.
- A worktree in the left rail is one status dot from the shared vocabulary:
  waiting (an agent needs input or a checkpoint is open), failed (an
  unresolved crash), else the agent state. A thin line separates repos. The
  accessible name says the state in words. The tooltip opens with no delay
  and shows the name, the branch, and the worktree signals, so a sweep over
  the rail reads at once.
- The right rail shows `*` on git when the tree is dirty, `×` on the pull
  request when checks failed, `✓` when it merged, and `●` on processes
  when processes run. Each mark is a badge in the corner of the button
  (`.rail-marker`), over the icon, so the rail stays one straight column
  of icons. A click opens the inspector at that section (`rightSection` in
  UI state).
- The Files section has two views. The link in the heading changes the
  view, and the view does not persist. `recent` (the default) is a flat list
  of the 50 newest files, from the daemon call `fs_recent`. That call reads
  `git ls-files`, so it skips the files that `.gitignore` excludes. Each row
  shows the file name and a short age (`now`, `12m`, `3h`, `2d`). A hover
  shows the full path. The list loads again every 10 seconds. `tree` reads
  one directory at a time with `fs_list`, in the daemon order: directories
  first, then name. A click on a directory opens it in place. In both views,
  a click on a file opens it in an editor pane, and a right click gives the
  file menu: open in pane, open in editor, reveal in finder, copy path, copy
  relative path (`fileMenu` in `menus.ts`).
- The rail and the open inspector read one table of id, label, and icon in
  `app/src/sections.tsx`. `SectionLabel` draws each inspector heading: the
  icon, the lowercase label, then the control of the section (`refresh`,
  `show`, or a count). An addon section calls `SectionLabel` with its own
  id, so it gets the icon of its `inspectorSections` entry.

## Resize and snapping

- Drag a boundary between a sidebar and the middle. The handle covers the
  body row only. It is 10 px wide over a 2 px line that shows on hover.
- The drag snaps: under 24 px is closed, under 114 px is minimal, above
  that the sidebar is open and resizes freely between 180 and 480 px.
- Minimal and closed keep the open width. Open again restores it. Modes
  and open widths persist in UI state and survive a restart.
- When the window is too narrow for a 400 px middle, the shell shows the
  right sidebar as minimal, then closed, then does the same to the left.
  The saved preference does not change, so a wider window brings the
  sidebars back.
- The pure rules (`snapSidebar`, `shellLayout`, `cycleSidebar`) are in
  `app/src/shell/sidebarMode.ts` with unit tests.

## Window chrome

- Empty space in the top strip is a drag region (`data-tauri-drag-region`
  on the strip, each region, the worktree header, and the view title).
  Buttons do not drag.
- `useWindowChrome` in `app/src/windowChrome.ts` sets `data-fullscreen` on
  the root in native fullscreen. The top-left region then drops the 84 px
  traffic-light inset. `useWindowWidth` gives the width for the narrow
  window rule.
- When the window gets focus back and nothing holds focus, the active pane
  of the active tab gets focus (`paneToRestore`). An open dialog, the
  palette, or a focused input keeps focus.

## CSS layout

```text
styles/
  index.css     imports, in order
  tokens.css    every token, in groups, light and dark
  base.css      reset, typography, selection, focus, status dots, motion guard
  ui.css        primitives, form controls, key caps
  layout.css    shell grid and geometry, top strip, worktree header, tabs, inspector, resize handles
  sidebar.css   left navigation and the minimal rails
  home.css      list rows and board
  terminal.css  splits and panes
  ../signals.css          the NOW signal line, beside Signals.tsx
  ../WorktreeRow.css      the sidebar worktree row, beside Sidebar.tsx
  ../browser/browser.css  browser pane toolbar and host box
  ../editor/editor.css    editor pane notice bar, compare view, error body
  palette.css   command palette
  towns.css     Japan map
  activity.css  activity feed
  bottom.css    bottom strip, its previews and popovers, diagnostics
  interaction.css  motion, focus, hit targets, scroll, skeleton, empty and error states
```

### The two layers

- **Global** (`app/src/styles/`): the design language. Tokens for color,
  space, type, and motion; the status vocabulary (`.state`, the dot classes,
  the glyph tones); the resets; and every class that more than one component
  uses.
- **Feature** (a plain `.css` file beside the component): the layout and the
  local states that one surface owns. Class names carry a feature namespace:
  `.wt-*`, `.towns-*`, `.browser-*`, `.activity-*`, `.rail-*`.
- **The rule:** if a change must reach the whole app, it is a token or a
  shared class. If a change reaches one surface, it is local CSS.

Tomo does not use CSS Modules. Plain CSS greps better, an agent can find the
rule from the class name, and collisions are manageable at this scale. Revisit
only if real collisions become a problem.

Feature CSS reads tokens. `app/src/WorktreeRow.css` writes no color, no
typeface, and no duration, so `[theme]` in `config.toml` stays the one theming
surface (see [theming.md](theming.md)). `Sidebar.test.tsx` fails if a row
loses a slot, or if that file holds a color, a typeface, or a duration.

`DESIGN.md` at the repository root holds the design language itself: brand
character, hierarchy, color, shape, type, density, motion, and how much
freedom a surface has.

## Torture page

Run the dev server and open `http://localhost:1420/#ui-torture`. The page
shows every primitive and every state, with menus at each viewport corner.
Use it when you change a shared primitive. It is not linked from the product
and is not in the production bundle.

## Tests

`app/src/components/ui/ui.test.tsx` runs in jsdom with Testing Library. It
covers menu open and close, keyboard navigation, submenus, disabled and
checked items, dialog focus return, popover dismissal, and the select.
Run `pnpm -C app test`.

## Manual checks before a release

Test the installed Tauri app, not only the browser:

- light and dark, small and large window
- menus near the right and bottom edges, nested submenus
- a dialog over a terminal, then Escape: the terminal has focus again
- a popover from the inspector
- Cmd+K, run a command, focus returns to the terminal
