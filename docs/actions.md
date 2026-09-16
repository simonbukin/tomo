# Actions

An Action is a named command that belongs to a repository. Tomo runs it in
the context of the current worktree. Actions live in `.tomo.toml`, so they
are versioned with the repository. The file at the repository root serves
every worktree of that repository. A worktree can hold its own file, which
lets the Actions differ per branch.

Tomo never runs an Action by itself. Every run comes from a button, the
palette, or `tomo action run`.

## The file

`.tomo.toml` holds repeated `[[actions]]` tables:

```toml
[[actions]]
id = "zed"
label = "Zed"
command = "zed ."
mode = "external"
show = "topbar"

[[actions]]
id = "storybook"
label = "Storybook"
command = "pnpm storybook"
show = "topbar"

[[actions]]
id = "e2e"
label = "Playwright"
command = "pnpm playwright test --ui"
```

| Key        | Required | Meaning                                                              |
|------------|----------|----------------------------------------------------------------------|
| `id`       | yes      | One word, unique in the file. `tomo action run <id>` uses it.        |
| `label`    | no       | Text on the button and in the palette. Default: the id.              |
| `command`  | yes      | Shell string.                                                        |
| `mode`     | no       | `pane` (default) or `external`.                                      |
| `show`     | no       | `topbar` or `menu` (default).                                        |
| `shortcut` | no       | Keybinding in the `[keybindings]` syntax, such as `mod+shift+s`. Active while the worktree is open. |

## Where the file lives

Tomo reads two places, in this order:

1. `<worktree>/.tomo.toml`.
2. `<repository root>/.tomo.toml`, when the worktree has no file of its own.

The repository root is the main worktree of the repository. The worktree
file wins whole: Tomo does not merge the two files, because a merge needs a
conflict rule for each id. A worktree file that holds no `[[actions]]` gives
no actions, and the repository file stays unread. No file at either place
means no actions and no error.

## Pane mode

Tomo opens a pane in the worktree with the label as its title. The pane
process is the configured shell (`shell` in `config.toml`, default `$SHELL`)
started as `<shell> -lc "<command>"`. The pane exits when the command exits.
Exit code 0 removes the pane. A non-zero exit keeps the pane and shows the
exit code, so you can read the output.

The pane carries a source, `{ "kind": "action", "id": <id>, "label": <label> }`
in `Pane.source`. The older field `Pane.action_id` repeats the id for
clients that read it. A second run of the same action, while its pane is
still live, starts nothing. Tomo focuses the live pane and reports
`reused`. This makes a topbar button a "show me the dev server" button on
the second click.

**Stop** kills every process in the pane and closes the pane. **Restart**
is a stop followed by a run. A stop of an action that does not run is not
an error.

A non-zero exit that Tomo did not cause is a crash. The pane stays open,
Tomo adds an attention item of kind `crash`, and the toast offers Logs and
Restart. See [activity.md](activity.md#crash-or-stop).

`pane close`, `tab close`, and an archive also end an Action pane. They
record no `action_stopped` and run no `action.exited` hook, because the pane
is gone before its process exits. This is the intended behavior. Use
`tomo action stop` when the stop must show in Activity and hooks.

The source is in memory only. After a daemon restart the pane comes back
as a plain shell without a source, and the command does not run again. A
reopened tab does the same.

## External mode

Tomo starts `sh -c "<command>"` with the worktree as the working directory,
detached, with stdin, stdout, and stderr closed. The process gets
`TOMO_WORKTREE_ID`, `TOMO_WORKTREE_PATH`, `TOMO_SOCKET`, and `TOMO_BIN`.
Tomo does not track it: there is no reuse, no stop, and no exit event.

## Where actions appear

- **GUI**. Actions with `show = "topbar"` are buttons in the top bar of the
  worktree; a live one shows a dot, and a right click on it offers focus,
  restart, and stop. The tooltip of a button ends with `from the repository`
  when the set comes from the repository file. Every action is in the `•••` overflow menu, where a
  running one opens the same submenu. The `⌘K` palette lists each action
  as `run <label>`. A `shortcut` works while that worktree is open; when
  it collides with a `[keybindings]` entry, the config entry wins.
- **CLI**. `tomo action list|run|stop|restart`. See [cli.md](cli.md).
- **Hooks**. `action.started` fires on every run. `action.exited` fires
  when a pane-mode action exits or is stopped. Both carry the `action`
  envelope field `{ "id": …, "label": … }`, and pane mode also carries
  `pane`. See [hooks.md](hooks.md).

## Reload

The daemon reads `.tomo.toml` on every discovery and watches the root of
each worktree (not recursive) for a change to that file. It watches each
repository root in the same way, because that root is not always an open
worktree. A change reloads the set of each worktree that reads the file, and
clients get an `actions_changed` event. A save takes about half a second to
show up.

## Malformed files

A bad entry is dropped; the rest of the file stays usable. The first
problem is reported once as a warning notice in the GUI and as a
`warning:` line in `tomo action list`. Each problem names the full path of
the file that holds it, because a repository file serves more than one
worktree, and a bad repository file must warn one time and not once per
worktree. A file that is not valid TOML yields no actions and the parse
error. A bad file never blocks the worktree.

## Where the code lives

Actions are an addon. See [addons.md](addons.md).

- `crates/tomo-proto/src/addons/actions.rs`: `ActionDef`, `ActionSet`, `ActionRunResult`, `ActionActivity`
- `crates/tomod/src/addons/actions/`: the `.tomo.toml` parser (`model.rs`), the four calls, the reload, and the exit outcomes
- `app/src/addons/actions/`: the topbar buttons, the menu items, the palette entries, the shortcuts, the crash restart, and the Activity rows
- `tomo action` in `crates/tomo-cli/src/main.rs`

The addon joins Core at two seams. `worktree_files` reloads `.tomo.toml`
after each discovery and when the watcher sees the file change.
`pane_exited` records the outcome of an Action pane under the same lock as
the exit.

## Trust

An action runs an arbitrary shell command with your permissions. The
command comes from the repository's own file, so a cloned repository can
define anything. Tomo never runs an action without an explicit request.
Treat a cloned repository's `.tomo.toml` as you treat its `Makefile`:
read it before you click.

The file at the repository root gives these commands to every worktree of
that repository at once. One file that you did not read is thus one button
in each worktree. A worktree file limits a command to that worktree, because
it hides the repository file.
