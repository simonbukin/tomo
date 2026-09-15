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
2. crash: an unresolved `crash` attention item (`× Sampler crashed`)
3. active agents (`● Claude`, with the process icon)
4. the primary HTTP runtime (`App ↗ :3000`)
5. memory over `resource_warning_bytes` (`⚠ 4.8 GB`)
6. a merged pull request or failed checks

A healthy quiet worktree shows at most `Claude ●` and `App ↗`. The dots
and colors are the shared status vocabulary from `base.css`. No new colors,
no cards inside cards. The list row keeps its grid and puts the signals in
the `agents` column. The board card shows name, `project · state`, the
signals, then `+12 −4` when the diff is not empty.

## Activity view

`app/src/Activity.tsx` is the fourth view (`home`, `worktree`, `towns`,
`activity`). The sidebar `History` button and the palette command
`Activity` open it. The header holds `activity`, the filter
(`All | Needs me | This worktree`), and the `UsageStrip` on the right. The
list groups events by day (`today`, `yesterday`, `Mon 14 Sep`) with
`.section-label` headings and 30 px rows: time, who (agent with process
icon, action label, `You`, or the worktree), title, detail, and text-button
actions derived from the event kind (`Open App`, `Go to Claude`, `Logs`,
`Restart`, `Resolve`, `Restore`).

The store loads 200 events with `activity_list` when the view opens,
prepends `activity_added` events, and keeps at most 500 in memory. `load
more` pages with `before_ms`. Every daemon call fails soft: an empty list,
no toast.

`UsageStrip` shows one item per provider (`claude 48% 5h · 83% wk`, or
`codex — unavailable` with the reason in a tooltip). A click opens a
popover with one bar per bucket and a `refresh` link. Over 80 % uses
`--waiting`, over 95 % uses `--hot`. The strip lives in the Activity
header only.

## Sidebar order, appearance, and terminal keys

- The main worktree of a repo shows a star and always sorts first, in
  every sort mode.
- Drag a worktree row or a repo header to reorder it. The first drop
  switches the sidebar to `manual` sort and keeps the order that was on
  screen for everything else. The order lives in UI state
  (`manualOrder`, `repoOrder`). Dragging uses dnd-kit pointer and
  keyboard sensors: HTML5 drag and drop is unreliable in the Tauri
  webview.
- Cmd or Ctrl with `+`, `-`, and `0` zooms the whole window through the
  webview zoom. A chip in the title bar shows a zoom other than 100 % and
  resets it on click.
- The Settings dialog (⌘,, the title bar button, or `Settings…` in the
  palette) edits `config.toml` through `config_set`: theme, accent, color
  overrides, terminal font, keybindings, agents, notifications, archive
  cleanup, and the editor. `config.toml` is the source of truth for theme
  and terminal font. Only the zoom lives in UI state. See
  [theming.md](theming.md).
- Shift+Enter in a terminal sends ESC CR instead of a bare CR, so Claude
  Code, Codex, and Pi insert a newline. The mapping is `keyOverride` in
  `appearance.ts`, with a unit test.
- The usage strip draws one `[█████░░░░░]` spark per bucket. Pi has no
  row: it runs on the Claude allowance.

## Tabs, panes, and dividers

- Drag a tab to reorder it. The other tabs stay in place; an accent line
  shows where the tab lands. The strip changes at once, then the
  `tabs_changed` snapshot from `tab_move` wins. The order persists.
- Drag a pane by its title chip in the legend. The terminal body never
  starts a drag, so text selection works as before. While the drag is
  active, the pane under the pointer shows where the pane lands: the outer
  quarter of each side splits that side (`split left`, `split right`,
  `split up`, `split down`), the middle swaps the two panes. Escape cancels.
- Drop a pane on another tab to add it to that tab as a right split. If
  the pane was the last one of its tab, that empty tab closes; no process
  stops. A tab that already holds `max_panes_per_tab` panes refuses the
  drop. Panes never move to another worktree.
- A drop always calls `pane_move`, which uses the same split-tree
  functions as the commands. `LayoutDnd.tsx` holds the one drag context
  for the tab strip and the split layout. `layoutModel.ts` holds the pure
  helpers (drop region from the pointer, tab reorder) with unit tests.
- Known limit: a browser pane has no drag handle and is not a drop
  target. Its body is a native webview that does not get pointer events
  from the Tomo window.
- Dividers are invisible until hover. The grab area is 8 px wider than
  the line. Double-click a divider to set that split to 50/50.
- Rest the pointer on a background terminal tab to see the last lines of
  its output (`pane_tail`, plain text, no terminal rendering).
- Home board: drag a card to another state column. This only sets
  `worktree.state`. The order inside a column stays the configured sort.

Keyboard parity (palette groups `Tabs` and `Panes`, defaults in
[data-model.md](data-model.md)): `move_tab_left`, `move_tab_right`,
`move_pane_left/right/up/down` (swap with the neighbor in that direction),
and `equalize_panes`.

The torture page (`#ui-torture`) has a tab strip and a nested pane grid on
local state. Use it to try every drop region, a drop on self, a cancel, and
a small window.

## Status glyphs

`app/src/glyphs.ts` holds the one status vocabulary:

```text
● working    ◉ needs user    ○ idle    ✓ complete    × failed    ? unknown
```

`agentStatus` and `activityStatus` map agent states and activity kinds onto
it. Dense rows (sidebar, Home, tabs, checkpoint banner, signals) draw the
round `.state` dot from `dotClass(status)`. Text surfaces (Activity rows,
palette hints, the crash signal) print `GLYPH[status]`. Do not add a glyph
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

A toast is for an error, an important background completion, a config
problem, or the result of a destructive operation. Tomo does not toast a
success that the UI already shows (copy, bulk tag, bulk restore, nothing to
jump to).

A new attention item goes through `attentionRoute` in
`app/src/notifyRoute.ts`:

| Tomo window                        | Result                                           |
|------------------------------------|--------------------------------------------------|
| not focused                        | desktop notification when `[notifications] desktop` is on |
| focused, other worktree, view, or pane | the in-app indicators only (sidebar dot, tab dot, `N need you`) |
| focused on that pane or worktree   | nothing extra; a waiting item is marked seen     |

Desktop notifications use `tauri-plugin-notification`. A human checkpoint
also calls `playChime("checkpoint")`, which plays only when
`[notifications] sounds` is on.

## Terminal links and file drop

- Cmd-click a URL in a terminal: the worktree browser pane opens it. A plain
  click does nothing.
- Cmd-click `path:line` or `path:line:col`: the daemon call `open_location`
  starts `editor_command` at that place. A relative path resolves against
  the pane cwd. See `editor_command` in [data-model.md](data-model.md).
- Drop Finder files on a terminal pane: Tomo types the shell-escaped
  absolute paths, separated by spaces, through `pane_send`.

The pure parts are `findLinks` and `resolvePath` in `links.ts`, and
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

`app/src/styles/tokens.css` holds the palette, fonts, sizes, spacing, radius,
durations, and shadows. Inter is the interface font. Geist Mono is for
terminal-adjacent text: branches, paths, ids, commands, process rows, and
shortcuts. Murasaki `--accent` marks active state, selection, and focus only.
Semantic colors (`--working`, `--waiting`, `--hot`, `--ins`, `--del`) keep
their meaning everywhere.

Spacing uses 4, 8, 12, 16. Radius is 3 to 6 px. Motion is 80 to 150 ms and
only for floating surfaces and small state changes.

### Motion tokens

The motion block at the end of `tokens.css` holds the curves and the named
moments. It has no colors. `--dur-fast` (80 ms) and `--dur` (140 ms) stay
the base.

| Token | Value | Use |
|-------|-------|-----|
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | hover, press, open |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | close |
| `--dur-hover` | 100 ms | background and color on hover |
| `--dur-press` | 80 ms | the press scale (`--press-scale`, 0.97) |
| `--dur-open` | 140 ms | menus, popovers, dialogs, attention arrival |
| `--dur-close` | 100 ms | the same surfaces when they close |
| `--dur-reveal` | 150 ms | the town reveal |
| `--hit-min` | 24 px | the smallest clickable area |
| `--focus-ring-width` | 2 px | the focus ring |

Under `prefers-reduced-motion: reduce` every duration is 0 and the press
scale is 1. The guard in `base.css` also stops every animation. No springs,
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

## Window chrome

- The title bar is a drag region (`data-tauri-drag-region`) on its empty
  space, the title text, and the offline label. Buttons in it do not drag.
- `useWindowChrome` in `app/src/windowChrome.ts` sets `data-fullscreen` on
  the root in native fullscreen. The title bar then drops the 84 px
  traffic-light inset.
- When the window gets focus back and nothing holds focus, the active pane
  of the active tab gets focus (`paneToRestore`). An open dialog, the
  palette, or a focused input keeps focus.

## CSS layout

```text
styles/
  index.css     imports, in order
  tokens.css    variables, light and dark
  base.css      reset, typography, status dots, motion
  ui.css        primitives
  layout.css    app grid, title bar, worktree header, tabs, inspector
  sidebar.css   left navigation
  home.css      list rows and board
  terminal.css  splits and panes
  palette.css   command palette
  towns.css     Japan map
  activity.css  activity feed and usage strip
  interaction.css  motion, focus, hit targets, scroll, skeleton, empty and error states
```

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
