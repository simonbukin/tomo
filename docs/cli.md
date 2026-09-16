# CLI reference

`tomo` is a client of `tomod`. Every command below connects to the daemon
over its Unix socket. When the daemon is not running, most commands start it
and wait up to five seconds. `tomo daemon status`, `tomo daemon stop`, and
`tomo hook` never start it.

## Global options

| Option   | Effect                                                     |
|----------|------------------------------------------------------------|
| `--json` | Print the daemon's structured result as pretty JSON.       |

## Environment

| Variable           | Effect                                                                 |
|--------------------|------------------------------------------------------------------------|
| `TOMO_DATA_DIR`    | Data directory. Default: `~/Library/Application Support/tomo`.         |
| `TOMO_SOCKET`      | Socket path. Default: `<data dir>/tomod.sock`.                         |
| `TOMO_DAEMON_BIN`  | Path of `tomod` to start. Default: a `tomod` next to `tomo`, else `PATH`. |
| `TOMO_PANE_ID`     | Set inside every Tomo pane. Default pane for pane and agent commands.  |
| `TOMO_WORKTREE_ID` | Set inside every Tomo pane. Default worktree when none is given.       |

Inside a Tomo terminal, commands that take a worktree or pane need no
argument. Outside one, the current directory resolves the worktree.

## Arguments

A **worktree** argument is one of:

- a worktree id (`tomo worktree list` prints it);
- `.` or any path; the daemon finds the worktree that contains it;
- nothing; `TOMO_WORKTREE_ID`, else the current directory.

A **repo** argument is an id, a repository name, or a path.

A **pane** argument is a pane id, or nothing for `TOMO_PANE_ID`.

## Commands

### status

```bash
tomo status
```

Daemon version, pid, socket, data directory, counts, and integration state.

### daemon

```bash
tomo daemon status    # exit code 3 when not running
tomo daemon start
tomo daemon stop
```

`stop` writes scrollback to disk and hangs up every pane shell.

### repo

```bash
tomo repo list
tomo repo add <path>
tomo repo remove <repo>
tomo repo clone <url> <dest>
```

`add` accepts any path inside a repository; the daemon records the top
level. `remove` forgets the root; worktree metadata stays in the database.

### worktree

```bash
tomo worktree list
tomo worktree current
tomo worktree refresh
tomo worktree create --repo <repo> --branch <name> [--new] [--from <ref>] [--path <dir>] [--town <slug>]
tomo worktree archive <worktree> [--no-checkpoint] [--discard]
tomo worktree restore <worktree>
tomo worktree open <worktree>
tomo worktree metadata get [worktree]
tomo worktree metadata set [worktree] [--name N] [--project P] [--state S] [--tags a,b]
                                     [--clear-name] [--clear-project] [--clear-state] [--clear-tags]
```

`create` runs `git worktree add`. Without `--path` Tomo names the directory
after a Japanese town: `<parent>/<town slug>`, where the parent is
`worktree_parent_dir` from the config, else `~/tomo/worktrees/<repo>`. The
`<repo>` part is the directory name of the repository, not its path, so two
repositories with the same directory name share one directory. Tomo makes the
directories that the path needs. A name that is already taken there fails in
`git worktree add`, the same as any other path that exists. Only a new worktree
follows this rule: a worktree that exists keeps its path, and `restore` only
puts a worktree in the parent above when its own parent directory is gone.
`--town` picks a specific town that is not unlocked yet; otherwise Tomo
picks one by rarity weight. The town becomes the display name unless you
set one. `--new` passes `-b`; `--from` gives the start point for a new
branch. After a successful create the `worktree.created` hooks run.

`archive` marks the worktree as archiving, runs the `worktree.before_archive`
hooks (a non-zero exit aborts), commits a checkpoint when the tree is
dirty, closes the worktree's terminals, kills the processes they own,
deletes the `[archive] cleanup` directories under the worktree, and runs
`git worktree remove --force`. The branch is kept, with the checkpoint on
it. The worktree stays listed as archived.

`--no-checkpoint` refuses a dirty tree with a conflict error instead of a
commit. `--discard` skips the checkpoint and its checks; uncommitted
changes are lost. Without `--discard`, a detached HEAD or an unresolved
merge conflict is refused before any pane closes. The printed result:

```text
archived a3dc426aa592
checkpoint 1f3a9c2 tomo: archive checkpoint
removed node_modules, dist
branch kept: feat/labor-relations
```

The second line reads `checkpoint not needed (clean)` when nothing was
committed. With `--json` the result is an `ArchiveResult`:

```json
{
  "worktree_id": "a3dc426aa592",
  "branch": "feat/labor-relations",
  "checkpoint_commit": "1f3a9c2…",
  "cleanup_removed": ["node_modules", "dist"]
}
```

`restore` checks that the branch exists, runs
`git worktree add <old path> <branch>`, and clears the archived mark.
Both refuse the main worktree. See
[state-and-recovery.md](state-and-recovery.md).

`open` makes sure the worktree has a tab and a pane, then focuses that pane
in the GUI.

`metadata set --tags` replaces the whole tag list. Tags keep no leading `#`.
`--state` must name a state from `[[states]]` in the config; an unknown
state is a bad request that lists the known ones. A state change fires
`worktree.state_changed` with the previous state.

```bash
tomo worktree metadata set . --state waiting-review
```

### states

```bash
tomo states list
```

Prints the configured workflow states with order, id, and label.

### action

```bash
tomo action list [worktree]
tomo action run <action> [worktree]
tomo action stop <action> [worktree]
tomo action restart <action> [worktree]
```

Actions come from `[[actions]]` in `<worktree>/.tomo.toml`. See
[actions.md](actions.md). `list` prints one line per action with id,
label, mode, show, and command; a malformed file adds a `warning:` line
with the first problem. `run` starts the action, or focuses its pane when
the same action already runs there:

```text
Storybook started in pane 5cac1495a647
Storybook already running in pane 5cac1495a647
Zed launched
```

`stop` kills the processes in the action's pane and closes it; nothing
happens when the action does not run. `restart` is a stop followed by a
run. An unknown action id is a not-found error that lists the known ids.

### towns

```bash
tomo towns list [--unlocked]
tomo towns pick
```

`list` prints every town with slug, name, Japanese name, prefecture, and
rarity; `--unlocked` limits it to towns that name a worktree. `pick` prints
the town that the next `worktree create` would use, without unlocking it.

### tab

```bash
tomo tab list [worktree]
tomo tab create [worktree] [--title T]
tomo tab rename <tab> <title>
tomo tab close <tab> [--force]
tomo tab equalize [tab]
tomo tab rotate [tab]
```

A new tab always gets one shell pane. `close` fails with a conflict error
when a pane still runs child processes; `--force` closes anyway.
`equalize` gives every pane in the tab the same size. `rotate` flips the
split around the active pane between side-by-side and stacked. Without an
argument both use `TOMO_TAB_ID`, else the tab of `TOMO_PANE_ID`.

### pane

```bash
tomo pane list [--worktree W]
tomo pane create [--worktree W] [--cwd DIR] [--tab T] [--title T] [-- <command...>]
tomo pane split [pane] [--right] [--down] [-- <command...>]
tomo pane swap <pane-a> <pane-b>
tomo pane zoom [pane]
tomo pane focus [pane]
tomo pane send <text> [--pane P] [--no-newline]
tomo pane close [pane] [--force]
tomo pane rename <title> [--pane P]
tomo pane kill-tree [pane]
```

`create` splits the active pane of the active tab; without a tab it creates
one. A trailing `-- cmd args` runs that program instead of a login shell.
`split --right` (default) puts the new pane beside the target; `--down`
puts it below (`--vertical` still works). `swap` exchanges two panes of the
same tab. `zoom` asks the GUI to show one pane full size or to unzoom it;
the saved layout does not change. `send` writes to the PTY as if typed; a
newline is appended unless `--no-newline`. `kill-tree` sends SIGKILL to
every process under the pane shell and keeps the shell.

### agent

```bash
tomo agent list [--worktree W]
tomo agent spawn <claude|codex|pi> [--worktree W] [--cwd DIR] [--split] [--resume REF] [-- <extra args>]
```

`spawn` creates a pane in the worktree, starts a login shell, and types the
agent command with Tomo's hooks or extension. It prints the pane id, tab id,
and the session reference when known. `--split` splits the calling pane
(`TOMO_PANE_ID`). `--resume` passes a native session reference.

Example from inside a Claude pane:

```bash
tomo agent spawn codex --cwd .
```

Codex starts in a new pane of the same worktree and appears in the GUI at
once.

### browser

```bash
tomo browser open [worktree] [--url U]
```

Opens a browser pane in a new tab titled `Browser` and prints the pane id.
Without `--url` the pane shows `about:blank`. The pane has no shell:
`pane send`, `pane kill-tree`, and the terminal calls refuse it. The url
is saved, so a daemon restart restores the page. See
[browser.md](browser.md).

### ps

```bash
tomo ps [--worktree W]
```

Processes that Tomo owns (descendants of a pane shell) and processes it
observes (cwd inside a worktree), grouped by worktree with a memory total.
Owned processes are indented by depth. Observed ones are labeled.

### pr

```bash
tomo pr [worktree]
```

Shows the GitHub pull request for the worktree's branch: number, title,
state, draft flag, review decision, check counts, and URL. Needs the `gh`
CLI logged in. The daemon caches the answer for one minute per worktree
and the right panel shows the same data.

### usage

```bash
tomo usage [--refresh]
```

Shows each provider's allowance windows: label, percent used, and the time
until the reset. `--refresh` fetches now instead of using the daemon's last
poll. A provider without a reliable source prints `unavailable` and the
reason. See [usage.md](usage.md) for the sources and the mock file.

### kill

```bash
tomo kill <pid>
```

Kills the process and its descendants. Refused unless Tomo owns the pid.

### notify

```bash
tomo notify "<message>" [--level attention|info] [--worktree W]
```

Creates an attention item. Inside a pane, the pane and worktree come from
the environment. Level `attention` raises the sidebar and title bar
indicator; `info` records only.

### attention

```bash
tomo attention list
tomo attention next     # focuses the pane and marks the item viewed
tomo attention clear
```

`list` prints unresolved items only, with their kind (`waiting`,
`checkpoint`, `crash`) and URL. A resolved item is history; see
`tomo activity`.

### checkpoint

```bash
tomo checkpoint "<message>" [--url U] [--title T] [--worktree W] [--pane P]
tomo checkpoint resolve <id>
```

Asks a human for a review or a decision. The worktree and pane default
from `TOMO_WORKTREE_ID` and `TOMO_PANE_ID`, then from the current
directory, so an agent inside a pane needs no arguments. `--title` becomes
the attention message and the message becomes the activity detail. The
result is the attention item; with `--json` it is one object. `resolve`
closes a checkpoint or a crash item by id and records
`checkpoint_resolved`. Because `resolve` is a subcommand, a checkpoint
whose message is the single word `resolve` needs `--title`. See
[activity.md](activity.md).

### activity

```bash
tomo activity [--limit N] [--needs-me] [--worktree W]
```

The history of meaningful events, newest first, 100 by default:

```text
14:02  Storybook listens on 6006 · localhost:6006
14:01  Claude is waiting for you
13:58  Storybook started
```

`--needs-me` keeps only the events whose attention item is still open.
`--worktree` filters by worktree; without it every worktree is listed,
also inside a pane. See [activity.md](activity.md).

### runtime

```bash
tomo runtime [worktree]
```

Ports that processes inside Tomo panes listen on: `port protocol pid
process action pane`. Without an argument it uses `TOMO_WORKTREE_ID`, else
every worktree. A process outside every pane is never listed. See
[runtime.md](runtime.md).

### hook

```bash
tomo hook <claude|codex|pi>
```

Reads a hook payload from stdin and forwards it. Exits silently without
`TOMO_PANE_ID`. Used by the generated hook configurations, not by hand.

### integrations

```bash
tomo integrations status
tomo integrations install
```

`status` prints one line per agent with a level and a reason:

```text
Claude  ✓ full            lifecycle + resume
Codex   ⚠ partial         resume only  (hooks installed but not trusted; start Codex and press t in its hooks panel)
Pi      ✓ full            lifecycle + resume
```

Levels: `full` (hooks and resume), `partial` (resume only), `process-only`
(binary found, hooks not installed), `unavailable` (binary not on PATH).

`install` merges Tomo hooks into `~/.claude/settings.json` and
`~/.codex/hooks.json` and writes `~/.pi/agent/extensions/tomo-status.ts`.
Re-run it after moving the `tomo` binary.

### config

```bash
tomo config check
```

Validates `config.toml` and prints one line per issue with a level, a key,
and a message. Exits 2 when any issue is an error. The daemon applies
defaults for anything invalid, so the app still starts.

### hooks

```bash
tomo hooks log [-n 20]
```

Prints the most recent hook runs from `<data dir>/hooks.log`: status,
event, duration, exit code, command, and the last output lines of a failed
run. Hook scripts get these variables: `TOMO_EVENT`, `TOMO_EVENT_JSON`,
`TOMO_WORKTREE_ID`, `TOMO_WORKTREE_PATH`, `TOMO_REPO_PATH`, `TOMO_BRANCH`,
`TOMO_STATE`, `TOMO_PANE_ID`, `TOMO_AGENT_KIND`, `TOMO_AGENT_STATE`,
`TOMO_SOCKET`, `TOMO_BIN`. See [hooks.md](hooks.md).

## Exit codes

| Code | Meaning                                      |
|------|----------------------------------------------|
| 0    | Success                                      |
| 1    | Daemon error or bad arguments; message on stderr |
| 2    | `config check`: at least one error-level issue   |
| 3    | `daemon status`: the daemon is not running   |
