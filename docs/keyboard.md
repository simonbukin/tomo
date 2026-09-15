# Commands, keys, menus, and the palette

## The registry rule

Tomo has one command registry. `allActions()` in `app/src/actions.ts`
returns it. It merges three sources:

- the `actions` list in `actions.ts`
- the state commands from `stateActions()`
- every `commands` export in `app/src/commands/*.ts`

Each command has an `id`, a `label`, a `run` function, and a `group`.
These surfaces read the registry by command id:

| Surface | File |
|---------|------|
| Keyboard shortcuts | `App.tsx` and `TerminalPane.tsx`, through `findAction` in `keys.ts` |
| Command palette (Cmd+K) | `Palette.tsx` |
| Context menus | `menus.ts` |
| Shortcut reference (`?`) | `ShortcutReference.tsx` |
| macOS menu bar | `appMenu.ts` |
| Tooltip key chords | `useShortcuts()` in `shortcuts.ts` |

Do not put business logic in a surface. A surface calls `runAction(id)`
or a function from `actions.ts`. To add a command, add it to a file in
`app/src/commands/` and give it a `group`. A test fails when a registry
command has no group.

Groups, in display order: `Navigation`, `Worktrees`, `Tabs`, `Panes`,
`Agents`, `Browser`, `General`. `COMMAND_GROUPS` in `actions.ts` gives
the groups for the commands in the `actions` list.

## Keybindings

The daemon merges the default keybindings with `[keybindings]` in
`config.toml` and sends the result in `config.keybindings`. A user key
replaces the default key for that command id. `effectiveBindings` in
`shortcuts.ts` adds the keys that the app handles outside the config:
Cmd with `=`, `-`, and `0` for window zoom, and `?` for the shortcut
reference.

## Shortcut reference

Press `?` when the focus is not in a terminal and not in a text field.
Or run `Keyboard shortcuts` from the palette or the Help menu. The
dialog lists every command that has a key, in groups. It also lists the
keys of the repo Actions of the worktree on screen. Type to filter by
label, command id, group, or key text (for example `mod+h`).

## Command palette

Cmd+K opens the palette. It lists:

- the tabs and panes of the worktree on screen
- live agents in all worktrees (`focus Claude · aogashima`)
- the repo Actions of the worktree on screen (`start App`,
  `focus App logs`, `restart App`, `stop App`)
- runtime endpoints (`open App :3000`)
- every registry command, with its group and key
- worktrees and repos

The ranking is a pure function, `rankEntries` in `paletteModel.ts`.
It sorts by these keys, in this order:

1. context: the entry belongs to the worktree on screen
2. recency: the position in `ui.paletteRecent` (12 keys at most, kept
   in UI state)
3. match: exact, then prefix or word prefix, then substring
4. fuzzy match, fewer gaps first

A match in the hint text counts as a fuzzy match. An entry that does not
match the query does not show.

### Nested actions

A worktree or a repo entry shows `›`. Enter opens a sub-list of its
actions, and the name shows as a breadcrumb in the input. The sub-list
comes from the same builder as the context menu (`worktreeMenu`,
`repoMenu`), plus the worktree's Actions and endpoints. A submenu, for
example `copy`, opens one more level. Backspace in an empty input goes
back one level. Cmd+Enter on a nested entry runs its first action at
once (for a worktree, `open`).

## Context menus

`menus.ts` builds every menu as a `MenuItem[]`. The builders take the
store state as a parameter, so tests call them with a fixture state.

| Object | Items |
|--------|-------|
| Worktree | open, new tab, new terminal, new claude, new codex, new pi · state ›, tags ›, set project, rename · open in (editor), reveal in finder, copy › (path, branch, worktree id) · archive or restore |
| Tab | rename · move left, move right · close, close others |
| Pane | split right, split down, zoom, equalize, rotate, swap with › · send to › · rename pane, copy › (cwd, session id) · kill process tree, close |
| Browser pane | back, forward, reload · open in external browser, copy › (url) · send to › · close |
| Running Action | open, focus logs, restart, stop · copy › (url, port) |
| Runtime endpoint row | open, focus logs, restart, stop · copy › (url, port) |

`move left` and `move right` call `tab_move` with the new 0-based
position. `send to` lists the other tabs of the worktree and calls
`pane_move` with `tab_id` and `place: "right"`. A menu item shows a key
only when the registry command acts on that object: for example, the
pane menu shows `⌘D` on `split right` only for the focused pane.

## Tooltips

Every icon-only control is an `IconButton`. Pass `shortcut` to show a
key chord after the label: `shortcut={shortcut("new_tab")}`, where
`shortcut` comes from `useShortcuts()`. The primitive does not read the
store.

## macOS menu bar

`MENU_BAR_LAYOUT` in `appMenu.ts` lists the menus Tomo, File, Edit,
View, Workspace, Pane, Agent, and Help as command ids and native items.
`menuBarSpec` turns the layout into a spec with registry labels and
accelerators from the keybindings. `useAppMenu` gives the spec to
`Menu.new` from `@tauri-apps/api/menu` and calls `setAsAppMenu`. It
builds the menu again when the keybindings change. Each item calls
`runAction(id)`.

- Edit keeps the native Undo, Redo, Cut, Copy, Paste, and Select All
  items. Text fields and the terminal need them.
- A key without Cmd or Ctrl gets no accelerator, because a native menu
  item takes its key from every text field.
- The `core:default` capability includes `core:menu:default`, so the
  menu API needs no new permission.

## Checks that need the live app

The tests cover the builders, the ranking, the palette navigation, and
the menu spec. Do these checks in the installed app:

- The menu bar shows the eight menus with the correct keys.
- A key such as Cmd+T runs once, not twice (the web view and the menu
  item must not both run it). Do this in a terminal and outside it.
- Cmd+C and Cmd+V work in a text field and in a terminal.
- `?` opens the reference outside text fields, and types `?` in them.
- `send to` and `move left` or `move right` work after the daemon calls
  `pane_move` and `tab_move` are done.
