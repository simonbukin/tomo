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
  the tooltip and the accessible name.
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
  (`manualOrder`, `repoOrder`). Dragging is pointer-driven in
  `useRowDrag.ts`: HTML5 drag and drop is unreliable in the Tauri
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

## Primitives

| Component | File | Base UI part |
|-----------|------|--------------|
| `Button`, `IconButton` | `button.tsx` | plain `<button>` plus `Tooltip` |
| `DropdownMenu*`, `MenuItems`, `AnchoredMenu` | `menu.tsx` | `Menu` |
| `ContextMenu*` | `context-menu.tsx` | `ContextMenu` |
| `Dialog*` | `dialog.tsx` | `Dialog` |
| `ConfirmDialog` | `confirm-dialog.tsx` | `Dialog` |
| `Popover*` | `popover.tsx` | `Popover` |
| `Tooltip`, `TooltipProvider` | `tooltip.tsx` | `Tooltip` |
| `Select` | `select.tsx` | `Select` |
| `Separator` | `separator.tsx` | `Separator` |

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

Spacing uses 4, 8, 12, 16. Radius is 3 to 6 px. Motion is 80 to 140 ms and
only for floating surfaces and small state changes.

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
