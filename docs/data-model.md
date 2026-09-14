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
| `project`        | A        | Optional grouping label                                 |
| `priority`       | A        | 1–4 or NULL; values outside 1–4 clamp on read           |
| `tags`           | A        | JSON array of strings; unparsable text reads as `[]`    |
| `last_active_ms` | R        | Set when a worktree is opened or a pane is focused      |
| `first_seen_ms`  | C        | When discovery first saw the worktree                   |
| `archived_at_ms` | C        | Set by `worktree archive`; NULL once the path exists again |
| `archived_branch`| C        | Branch at archive time; used by `worktree restore`      |
| `town_slug`      | A        | The Japanese town that named the worktree               |

Discovery inserts a row for every worktree it sees, so metadata can attach
to it later. Deleting a row loses organization only; the worktree stays
usable.

## towns

| Column           | Category | Meaning                                  |
|------------------|----------|------------------------------------------|
| `slug`           | A        | Town slug from `app/src/data/japan-towns.json` |
| `worktree_id`    | A        | Worktree that unlocked the town          |
| `repo_id`        | A        | Repository of that worktree              |
| `unlocked_at_ms` | A        | When the worktree was created            |

A town unlocks once. Archiving or deleting the worktree keeps the unlock.
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

Nothing here records the running command. On restart a pane gets a shell,
and only a known agent kind with a session reference gets a resume line.

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

The daemon keeps the newest 200 viewed items.

## kv

| Key        | Category | Meaning                                      |
|------------|----------|----------------------------------------------|
| `ui_state` | R        | JSON: view, active worktree, sidebar widths, Home filters |

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
| `editor_command`      | `["zed", "{path}"]`                       | `{path}` is replaced; appended if absent; falls back to `open` when the program is missing |
| `worktree_parent_dir` | unset (sibling of the repository)         | Where `worktree create` puts new trees  |
| `resource_warning_gb` | `2.0`                                     | Memory above which the sidebar shows a total |
| `scrollback_lines`    | `10000`                                   | xterm scrollback                        |
| `font_family`         | `Geist Mono Variable, Menlo, monospace`   | UI terminal font                        |
| `font_size`           | `13`                                      | Terminal font size                      |
| `theme`               | `system`                                  | `system`, `dark`, or `light`            |
| `[keybindings]`       | see below                                 | Overrides merge with the defaults       |
| `[agents.<name>]`     | `command = "<name>"`, `args = []`         | Program used for `claude`, `codex`, `pi` |
| `archive_cleanup`     | `["node_modules","target","dist",".next",".turbo",".venv","build"]` | Direct children deleted by `worktree archive` |
| `[hooks]`             | none                                      | `worktree_create` and `worktree_archive`: shell strings run with `sh -c` in the worktree; env `TOMO_WORKTREE_ID`, `TOMO_WORKTREE_PATH`, `TOMO_REPO_PATH`, `TOMO_BRANCH`; 60 s timeout; failures only warn |

Default keybindings (`mod` is ⌘):

```text
home = "mod+h"                 palette = "mod+k"
next_attention = "mod+shift+a"
prev_worktree = "mod+shift+["  next_worktree = "mod+shift+]"
new_terminal = "mod+d"         split_vertical = "mod+shift+d"
new_tab = "mod+t"              close_pane = "mod+w"
next_tab = "mod+shift+right"   prev_tab = "mod+shift+left"
focus_left/right/up/down = "mod+alt+<arrow>"
toggle_left_sidebar = "mod+b"  toggle_right_sidebar = "mod+shift+b"
```
