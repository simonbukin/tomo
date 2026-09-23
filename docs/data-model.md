# Data model

All persistent Tomo state lives in one SQLite file:
`<data dir>/tomo.sqlite3` (WAL mode). The data directory is
`~/Library/Application Support/tomo` unless `TOMO_DATA_DIR` says otherwise.

Every column has a category:

- **A** authoritative Tomo metadata. Only the user changes it.
- **C** cached external observation. Discovery overwrites it.
- **R** recoverable runtime state. Restart rebuilds from it.

Git remains the authority for branches and for whether a worktree exists.
No table stores a branch name.

## repos

| Column        | Category | Meaning                                  |
|---------------|----------|------------------------------------------|
| `id`          | A        | UUID v5 of the canonical path, 12 hex chars |
| `path`        | A        | Repository top level, canonical          |
| `added_at_ms` | A        | Insertion time                           |

## worktree_meta

| Column           | Category | Meaning                                                 |
|------------------|----------|---------------------------------------------------------|
| `id`             | A        | Worktree id (see identity below)                        |
| `repo_id`        | C        | Owning repository                                       |
| `path`           | C        | Last known canonical path                               |
| `gitdir`         | C        | Name under `<common>/worktrees/`; NULL for the main worktree |
| `display_name`   | A        | Optional; the path's last component is the fallback     |
| `project`        | —        | Unused. A value that is still there reads as a tag; the next write sets NULL |
| `state`          | —        | Unused. A value that is still there reads as a tag; the next write sets NULL |
| `priority`       | —        | Unused since Phase 2.5; always written as NULL          |
| `tags`           | A        | JSON array of strings; unparsable text reads as `[]`. No leading `#`, no duplicates |
| `last_active_ms` | R        | Set when a worktree is opened or a pane is focused      |
| `first_seen_ms`  | C        | When discovery first saw the worktree                   |
| `archived_at_ms` | C        | Set by `worktree archive`; NULL once the path exists again |
| `archived_branch`| C        | Branch at archive time; used by `worktree restore`      |
| `town_slug`      | —        | Unused since Phase 2. Old databases keep the column; a new database does not get it. The `towns` table owns the mapping |

Tags are the only way to group worktrees. An old database can have a
`project` or `state` value from before tags replaced them. When Tomo reads
such a row, it adds each value to the end of `tags`, unless the tag is
already there. The next write of the row saves the new tags and sets both
old columns to NULL. There is no separate migration step.

Discovery inserts a row for every worktree it sees, so metadata can attach
to it later. Deleting a row loses organization only; the worktree stays
usable.

## towns

| Column           | Category | Meaning                                  |
|------------------|----------|------------------------------------------|
| `slug`           | A        | Town slug from `app/src/addons/towns/data/japan-towns.json` |
| `worktree_id`    | A        | Worktree that unlocked the town          |
| `repo_id`        | A        | Repository of that worktree              |
| `unlocked_at_ms` | A        | When the worktree was created            |

The Towns addon (`crates/tomod/src/addons/towns`) creates this table and is the only code that queries it. The table is the only owner of the worktree→town mapping; clients read it through `town_list`. A town unlocks once. Archiving or deleting the worktree keeps the unlock. A move or a restore at a new path moves the row to the new worktree id.
The dataset itself (1681 municipalities with coordinates, population,
Wikipedia link, and a rarity tier from population) ships in the binary.

## tabs

| Column           | Category | Meaning                                  |
|------------------|----------|------------------------------------------|
| `id`             | R        | Random 12 hex chars                      |
| `worktree_id`    | R        | Owning worktree                          |
| `title`          | R        | `Tab N` unless renamed                   |
| `position`       | R        | Order inside the worktree                |
| `layout`         | R        | Layout tree as JSON (below)              |
| `active_pane_id` | R        | Focused pane                             |
| `is_active`      | R        | One active tab per worktree              |

A row whose `layout` fails to parse is skipped on load.

## panes

| Column          | Category | Meaning                                                  |
|-----------------|----------|----------------------------------------------------------|
| `id`            | R        | Random 12 hex chars; also `TOMO_PANE_ID` in the shell    |
| `tab_id`        | R        | Owning tab                                               |
| `worktree_id`   | R        | Owning worktree                                          |
| `user_title`    | A        | Name set by the user, or NULL                            |
| `cwd`           | R        | Shell working directory, refreshed by the process monitor |
| `cols`, `rows`  | R        | Last terminal size                                       |
| `agent_kind`    | R        | `claude`, `codex`, `pi`, or NULL                         |
| `session_ref`   | R        | Native session reference for resume                      |
| `created_at_ms` | R        | Creation time                                            |
| `action_id`     | none     | Not read or written since the Actions addon. An old database keeps the column; a new database does not get it |

Nothing here records the running command. On restart a pane gets a shell,
and only a known agent kind with a session reference gets a resume line.

The pane source (`Pane.source`, for example the Action that started the
pane) is in memory only. A restored pane has no source, so the restored
shell is never taken for the running Action. `Pane.action_id` on the wire
comes from the source.

## attention

| Column          | Category | Meaning                          |
|-----------------|----------|----------------------------------|
| `id`            | R        | Random id                        |
| `worktree_id`   | R        | Target worktree                  |
| `pane_id`       | R        | Target pane or NULL              |
| `level`         | R        | `attention` or `info`            |
| `message`       | R        | Text                             |
| `created_at_ms` | R        | Creation time; orders "next"     |
| `viewed_at_ms`  | R        | NULL until focused or viewed     |
| `kind`          | R        | `waiting`, `checkpoint`, or `crash`; NULL reads as `waiting` |
| `url`           | R        | Link given to `tomo checkpoint`, or NULL |
| `agent_kind`    | R        | Agent in the pane when the item was made, or NULL |
| `resolved_at_ms`| R        | NULL until `tomo checkpoint resolve`; a resolved item is hidden from `attention list` |

The daemon keeps the newest 200 viewed items.

## activity

| Column           | Category | Meaning                                              |
|------------------|----------|------------------------------------------------------|
| `id`             | R        | Random id                                            |
| `kind`           | R        | Kind string, e.g. `action_crashed`; see [activity.md](activity.md). An unknown string reads back unchanged |
| `occurred_at_ms` | R        | Event time; indexed, orders the list newest first    |
| `worktree_id`    | R        | Worktree, or NULL for a hook with no worktree        |
| `pane_id`        | R        | Pane, or NULL                                        |
| `agent_kind`     | R        | `claude`, `codex`, `pi`, or NULL                     |
| `title`          | R        | One line for a person                                |
| `detail`         | R        | Optional second line                                 |
| `payload`        | R        | JSON text; `action_crashed` holds `action_id`, `exit_code`, `pane_id` |
| `attention_id`   | R        | The attention item the event opened or resolved      |

The daemon keeps the newest 10 000 rows. It is a log for people, not a
source of truth; delete it freely. See [activity.md](activity.md).

## kv

| Key        | Category | Meaning                                      |
|------------|----------|----------------------------------------------|
| `ui_state` | R        | JSON: view, active worktree, sidebar widths and open state, collapsed and hidden repos, sidebar order, Home options, appearance. The GUI checks every field on load; see [state-and-recovery.md](state-and-recovery.md) |

## Worktree identity

```text
id = uuid_v5(NAMESPACE_URL, canonical_path)[..12]
```

Deterministic: the same path always yields the same id, with no registry.

When Git reports a worktree whose id has no row, and a row exists with the
same `repo_id` and `gitdir` whose `path` no longer exists, the daemon calls
`rebind_worktree(old_id, new_id, new_path)`. This updates `worktree_meta`,
`tabs`, `panes`, and `attention` in one step. A moved worktree keeps its
name, tags, tabs, and panes.

The main worktree has no gitdir name, so it cannot be rebound after a move;
it gets a fresh identity.

## Layout tree

A tab's layout is a binary tree. Leaves are panes. Splits carry an id so a
client can address them for resizing.

```json
{"type": "leaf", "pane_id": "a1b2c3d4e5f6"}

{"type": "split", "id": "…", "direction": "horizontal", "ratio": 0.5,
 "first": {"type": "leaf", "pane_id": "…"},
 "second": {"type": "split", "id": "…", "direction": "vertical", "ratio": 0.4,
            "first": {"type": "leaf", "pane_id": "…"},
            "second": {"type": "leaf", "pane_id": "…"}}}
```

`horizontal` places `first` left of `second`. `vertical` places `first`
above `second`. `ratio` is the share of `first`, clamped to 0.1–0.9.
Removing a leaf replaces its parent split with the sibling. Removing the last
leaf deletes the tab.

## Scrollback files

`<data dir>/scrollback/<pane id>.bin` holds the last 1 MB of raw pane
output, written on daemon stop and on pane close. Category R. Safe to
delete.

## Integration files

`<data dir>/integrations/claude-hooks.json` and
`<data dir>/integrations/tomo-status.ts` are regenerated on every daemon
start from the embedded templates and the absolute `tomo` path. Do not edit
them.

## config.toml

`<data dir>/config.toml`. Every key is optional. The daemon writes a
commented copy when the file is missing.

| Key                   | Default                                   | Meaning                                 |
|-----------------------|-------------------------------------------|-----------------------------------------|
| `shell`               | `$SHELL`, else `/bin/zsh`                 | Started as a login shell (`-l`)         |
| `editor_command`      | `["zed", "{path}"]`                       | `{path}` is replaced; appended if absent; falls back to `open` when the program is missing. For a Cmd-click on `path:line` in a terminal, `{path}` becomes `path:line:col`. To place the numbers yourself, use `{line}` and `{col}`, for example `["code", "-g", "{path}:{line}:{col}"]` |
| `worktree_parent_dir` | unset (`~/tomo/worktrees/<repo>`)         | Where `worktree create` puts new trees. The override is flat: it gets no `<repo>` directory. It never moves a worktree that exists |
| `branch_prefix`       | empty                                     | A create that names no branch gets `<branch_prefix><worktree name>`, for example `simon/aogashima`. The daemon owns the rule and carries the prefix to a client on `Repo.branch_prefix`. The branch is always created; a name that a branch already has fails in `git worktree add` with its own message |
| `resource_warning_gb` | `2.0`                                     | Memory above which the sidebar shows a total |
| `scrollback_lines`    | `10000`                                   | xterm scrollback                        |
| `max_panes_per_tab`   | `4`                                       | Spawns without a target open a new tab once a tab holds this many panes |
| `[theme]`             | `name = "system"`, Murasaki light and dark | Base theme, `light`/`dark` for system mode, and color overrides. See [theming.md](theming.md) |
| `[terminal]`          | `font_family = "CommitMono, Menlo, monospace"`, `font_size = 13` | Terminal font. The older top-level `font_family`, `font_size`, and `theme = "dark"` still work |
| `[notifications]`     | `desktop = true`, `sounds = false`        | Desktop notifications and rare sounds   |
| `[keybindings]`       | see below                                 | Overrides merge with the defaults       |
| `[agents.<name>]`     | `command = "<name>"`, `args = []`         | Program used for `claude`, `codex`, `pi` |
| `[[hooks]]`           | none                                      | `event`, `command`, optional `tag`, `mode` (`async`/`pane`), `timeout_s` (60). See [hooks.md](hooks.md) |
| `[notifications] desktop` | `true`                                | A desktop notification for a new attention item while the Tomo window is not focused. See [ui.md](ui.md) |
| `[notifications] sounds`  | `false`                               | A short chime for a human checkpoint and a rare town unlock |

Default keybindings (`mod` is ⌘):

```text
home = "mod+h"                 palette = "mod+k"
settings = "mod+,"             next_attention = "mod+shift+a"
prev_worktree = "mod+shift+["  next_worktree = "mod+shift+]"
new_terminal = "mod+d"         split_vertical = "mod+shift+d"
new_tab = "mod+t"              close_pane = "mod+w"
reopen_tab = "mod+shift+t"
next_tab = "mod+shift+right"   prev_tab = "mod+shift+left"
focus_left/right/up/down = "mod+alt+<arrow>"
toggle_left_sidebar = "mod+b"  toggle_right_sidebar = "mod+shift+b"
zoom_pane = "mod+shift+enter"
move_tab_left/right = "mod+alt+shift+<arrow>"
move_pane_left/right/up/down = "mod+ctrl+alt+<arrow>"
equalize_panes = "mod+alt+e"
```

`tomo config check` validates the file: unknown hook events, a hook `tag`
filter on an event other than `worktree.tags_changed`, missing programs, bad keybindings, cleanup entries that are
not plain names, bad theme and terminal values, an `agents.*.args` entry
that starts with a Unicode dash (U+2010 to U+2015 or U+2212, which the
agent reads as text and not as a flag), and a file that does not parse. Tags replace the old `[[states]]` table.
If the file still has it, Tomo ignores it and the check gives a warning with
the key `states`. Malformed config never stops the daemon; it logs a warning and uses
defaults. The daemon reloads the file when it changes and sends
`config_changed`. `config_set` edits one key in place and keeps comments.

## .tomo.toml

`.tomo.toml` is not Tomo state. It belongs to the repository and holds
`[[actions]]`. A worktree reads its own file, and the file at the repository
root when it has none. The daemon reads it on discovery and on change and
keeps the result only in memory. See [actions.md](actions.md).

## hooks.log

`<data dir>/hooks.log` holds one JSON `HookRun` per line: event, command,
worktree id, start time, duration, exit code, success flag, and the last
4 KB of output. It is a log, not state; delete it freely.
