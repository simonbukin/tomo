# Hooks and events

Tomo turns meaningful workflow transitions into events. A hook is an
ordinary command that runs when an event fires. A hook that wants to act on
Tomo calls the `tomo` CLI. There is no workflow language and no visual
builder.

```text
Tomo event → configured hook → ordinary process → tomo CLI (optional)
```

## Configuration

Hooks live in `config.toml` as repeated `[[hooks]]` tables:

```toml
[[hooks]]
event = "worktree.created"
command = "pnpm install"
mode = "pane"

[[hooks]]
event = "worktree.state_changed"
state = "merged"
command = "~/.config/tomo/hooks/merged"
timeout_s = 120
```

| Key         | Required | Meaning                                                             |
|-------------|----------|---------------------------------------------------------------------|
| `event`     | yes      | One event name from the table below                                 |
| `command`   | yes      | Shell string. Tomo runs it with `sh -c` in the worktree directory   |
| `state`     | no       | Only for `worktree.state_changed`: run only when the new state matches |
| `mode`      | no       | `async` (default) or `pane`                                         |
| `timeout_s` | no       | Seconds before Tomo kills the hook. Default 60                      |

`tomo config check` reports unknown events, missing programs, and a `state`
filter on an event other than `worktree.state_changed`.

## Events

| Event                     | Fires when                                                       | Payload fields present            |
|---------------------------|------------------------------------------------------------------|-----------------------------------|
| `worktree.discovered`     | Discovery sees a worktree it did not know. Not on daemon start.  | `worktree`                        |
| `worktree.created`        | `tomo worktree create` or the GUI created a worktree             | `worktree`                        |
| `worktree.before_archive` | Before an archive changes anything. Synchronous gate.            | `worktree`                        |
| `worktree.archived`       | Git removed the worktree and Tomo marked it archived             | `worktree`                        |
| `worktree.restored`       | `tomo worktree restore` recreated the worktree                   | `worktree`                        |
| `worktree.state_changed`  | The metadata state changed                                       | `worktree`, `previous_state`      |
| `pane.created`            | A pane got its PTY                                               | `worktree`, `pane`                |
| `pane.closed`             | A pane was removed                                               | `worktree`, `pane`                |
| `agent.started`           | An agent presence appeared in a pane                             | `worktree`, `pane`, `agent`       |
| `agent.working`           | Agent state became `working`                                     | `worktree`, `pane`, `agent`       |
| `agent.waiting`           | Agent state became `waiting`                                     | `worktree`, `pane`, `agent`       |
| `agent.idle`              | Agent state became `idle`                                        | `worktree`, `pane`, `agent`       |
| `agent.exited`            | Agent state became `exited`                                      | `worktree`, `pane`, `agent`       |
| `attention.created`       | An attention item was added (`tomo notify` or a waiting agent)   | `worktree`, `attention`, `pane`?  |
| `action.started`          | `tomo action run`, restart, or a GUI button started an action    | `worktree`, `action`, `pane`?     |
| `action.exited`           | A pane-mode action exited or was stopped                         | `worktree`, `action`, `pane`      |
| `action.crashed`          | A pane-mode action exited non-zero and Tomo did not stop it; after `action.exited` | `worktree`, `action`, `pane`, `attention` |
| `runtime.endpoint_discovered` | An owned process started to listen on a TCP port             | `worktree`, `pane`, `action`?     |
| `runtime.endpoint_removed`| A listening port went away and did not return within 5 s        | `worktree`, `pane`, `action`?     |
| `checkpoint.created`      | `tomo checkpoint` asked for a review or a decision               | `worktree`, `attention`, `pane`?, `agent`? |
| `checkpoint.resolved`     | `tomo checkpoint resolve` closed a checkpoint or crash item      | `worktree`, `attention`, `pane`?  |

`action.started` carries `pane` only for a pane-mode action. An external
action is not tracked, so it never fires `action.exited`. See
[actions.md](actions.md). The `attention` field on `action.crashed` and
`checkpoint.*` is the full `AttentionItem` with its `kind` (`waiting`,
`checkpoint`, `crash`), `url`, `agent_kind`, and `resolved_at_ms`. The
runtime events carry `action` when an Action started the pane; a restart
that brings the same port back within 5 seconds fires nothing. See
[runtime.md](runtime.md) and [activity.md](activity.md).

Process start and exit are not events. They would fire on every poll and
make Tomo slower. Read `tomo ps` from a hook when you need process state.

## Envelope

Every hook receives one JSON document on stdin. The same document is in
`TOMO_EVENT_JSON`. Fields that do not apply are `null`.

```json
{
  "event": "agent.waiting",
  "at_ms": 1789400000000,
  "worktree": {
    "id": "a3dc426aa592",
    "path": "/Users/me/work/aogashima",
    "repo_id": "a57cf5ebdc18",
    "repo_path": "/Users/me/Projects/holly",
    "branch": "feat/labor-relations",
    "name": "Aogashima",
    "state": "active",
    "project": "Holly",
    "tags": ["labor-relations"]
  },
  "previous_state": null,
  "pane": { "id": "5cac1495a647", "tab_id": "ab30d81bed9a", "cwd": "/Users/me/work/aogashima" },
  "agent": { "kind": "claude", "state": "waiting", "session_ref": "4c424b05-..." },
  "attention": null,
  "action": null
}
```

`action` is `{ "id": "storybook", "label": "Storybook" }` on the two
`action.*` events.

The Rust type is `HookEvent` in `crates/tomo-proto`; the TypeScript type is
generated in `app/src/generated/HookEvent.ts`.

## Environment

| Variable            | Present when            | Value                                  |
|---------------------|-------------------------|----------------------------------------|
| `TOMO_EVENT`        | always                  | Event name                             |
| `TOMO_EVENT_JSON`   | always                  | The envelope                           |
| `TOMO_WORKTREE_ID`  | `worktree` present      | Worktree id                            |
| `TOMO_WORKTREE_PATH`| `worktree` present      | Worktree directory                     |
| `TOMO_REPO_PATH`    | `worktree` present      | Repository directory                   |
| `TOMO_BRANCH`       | `worktree` present      | Branch name, empty when detached       |
| `TOMO_STATE`        | `worktree` present      | Workflow state, empty when unset       |
| `TOMO_PANE_ID`      | `pane` present          | Pane id                                |
| `TOMO_AGENT_KIND`   | `agent` present         | `claude`, `codex`, or `pi`             |
| `TOMO_AGENT_STATE`  | `agent` present         | Agent state name                       |
| `TOMO_SOCKET`       | always                  | Daemon socket path                     |
| `TOMO_BIN`          | always                  | Path of the `tomo` binary              |

Because `TOMO_WORKTREE_ID` and `TOMO_PANE_ID` are set, `tomo` commands in a
hook resolve the worktree without arguments, as they do inside a Tomo pane.

## Modes

**async** (default). Tomo starts the process, feeds the envelope, and
continues. The process runs detached from any request. Its exit code and
output land in the log.

**pane**. Tomo opens a terminal pane in the worktree with the title
`hook: <event>`, exports the environment, and types the command. You watch
the output in the GUI. Use it for setup that you want to see, such as
`pnpm install`. Pane hooks receive no stdin; they read `TOMO_EVENT_JSON`.

## The gate

`worktree.before_archive` is the only synchronous hook. Tomo waits for
every async hook on that event before it changes anything. A non-zero exit
or a timeout aborts the archive with error code `aborted`, and the worktree
returns to its previous state. Pane-mode hooks cannot gate.

No other event waits for hooks. Pane focus, terminal output, and agent state
updates never block on user scripts.

### Archive order

An archive runs these steps in this order:

1. `worktree.before_archive` gate; a failure stops here.
2. Checkpoint commit when the tree is dirty (see
   [state-and-recovery.md](state-and-recovery.md)).
3. Close the worktree's panes and kill the processes they own.
4. Delete the `[archive] cleanup` directories.
5. `git worktree remove --force`.
6. `worktree.archived`.

The gate runs before the checkpoint, so a gate script that inspects
`git status` sees the tree as the user left it.

## Timeouts and logging

A hook runs in its own process group. After `timeout_s` seconds Tomo sends
SIGKILL to the whole group, so children and grandchildren die with it, and
the run's output ends with `timed out after <n> s; process group killed`.
Every run appends one JSON line to `<data dir>/hooks.log` with the event,
command, worktree id, duration, exit code, and `output_tail`: the last 4 KB
of combined output, cut on a UTF-8 character boundary. Read it with:

```bash
tomo hooks log -n 20
```

A failed hook also raises a warning notice in the GUI. A missing program, a
non-zero exit, a timeout, or huge output never stop the daemon.

## Recipes

Each recipe is a script. Point a `[[hooks]]` entry at it and make it
executable.

### Review workflow

An agent finishes its work and asks for review:

```bash
tomo worktree metadata set . --state waiting-review
tomo notify "Implementation finished; review requested"
```

A hook tells you when that happens:

```toml
[[hooks]]
event = "worktree.state_changed"
state = "waiting-review"
command = "~/.config/tomo/hooks/review-requested"
```

```sh
#!/bin/sh
# ~/.config/tomo/hooks/review-requested
name=$(printf '%s' "$TOMO_EVENT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["worktree"]["name"])')
osascript -e "display notification \"$name is waiting for review\" with title \"Tomo\""
```

### Merge cleanup

When you set the state to `merged`, the hook checks that the branch is gone
from the default branch and archives the worktree. The branch stays in Git.

```toml
[[hooks]]
event = "worktree.state_changed"
state = "merged"
command = "~/.config/tomo/hooks/merged"
```

```sh
#!/bin/sh
# ~/.config/tomo/hooks/merged
cd "$TOMO_REPO_PATH" || exit 0
git fetch -q origin
if git branch -r --merged origin/HEAD | grep -q "origin/$TOMO_BRANCH\$"; then
  tomo worktree archive "$TOMO_WORKTREE_ID"
else
  tomo notify --worktree "$TOMO_WORKTREE_ID" "marked merged, but $TOMO_BRANCH is not merged on origin"
fi
```

### New worktree setup

Run dependency installation in a visible pane:

```toml
[[hooks]]
event = "worktree.created"
command = "cp ../.env.local .env.local 2>/dev/null; pnpm install"
mode = "pane"
```

### Agent completion

Get a notification when an agent stops working:

```toml
[[hooks]]
event = "agent.idle"
command = "~/.config/tomo/hooks/agent-idle"
```

```sh
#!/bin/sh
# ~/.config/tomo/hooks/agent-idle
tomo notify --level info "$TOMO_AGENT_KIND finished a turn"
```

### Guard an archive

Refuse to archive a worktree with uncommitted changes:

```toml
[[hooks]]
event = "worktree.before_archive"
command = "~/.config/tomo/hooks/before-archive"
```

```sh
#!/bin/sh
# ~/.config/tomo/hooks/before-archive
cd "$TOMO_WORKTREE_PATH" || exit 0
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: uncommitted changes in $TOMO_WORKTREE_PATH"
  exit 1
fi
```
