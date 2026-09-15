# Agent integrations

Tomo supports Claude Code, Codex, and Pi. Each integration does three things:

1. identifies the pane an agent runs in;
2. reports lifecycle state (working, waiting, idle, exited);
3. captures a native session reference for resume.

Tomo adds no UI inside any agent. Every integration is a thin reporter that
talks to `tomod` through the public path: the `tomo hook` command or the
daemon socket.

Provider allowance windows (the 5-hour and weekly limits) are a separate
concern. See [usage.md](usage.md).

## How a pane identifies itself

Every shell Tomo starts carries these variables:

```text
TOMO_PANE_ID
TOMO_TAB_ID
TOMO_WORKTREE_ID
TOMO_WORKTREE_PATH
TOMO_SESSION_ID      daemon instance id
TOMO_SOCKET          daemon socket path
TOMO_DATA_DIR
TERM=xterm-256color  COLORTERM=truecolor  TERM_PROGRAM=tomo
```

A hook reads `TOMO_PANE_ID`. When it is absent, the hook exits without doing
anything. This makes the user-level hooks safe outside Tomo.

The daemon removes these variables from a pane's inherited environment
before it starts the shell: `CLAUDECODE`, every `CLAUDE_CODE_*`, every
`TOMO_*`, every `ORCA_*`, and `CODEX_THREAD_ID`. Without this, a daemon that
was started from inside another agent would make every pane look like a
nested child session; Claude, for example, then turns transcript saving off.

## The `tomo hook` command

```bash
tomo hook claude   # reads the hook JSON from stdin
tomo hook codex
tomo hook pi
```

The command sends `agent_hook { kind, pane_id, payload, at_ms }` to the
daemon. The daemon maps the payload to a state with `agents::hook_outcome`
and applies it with authority `lifecycle`. Errors are swallowed: a hook must
never break the agent.

## Claude Code

Spawn command (`agents::spawn_plan`):

```bash
claude --settings <data dir>/integrations/claude-hooks.json --session-id <uuid>
claude --settings <data dir>/integrations/claude-hooks.json --resume <uuid>   # after restart
```

`--settings` merges with the user's own settings; hook lists are combined,
so existing hooks keep working. The daemon rewrites the hooks file on every
start with the absolute path of the `tomo` binary.

Hook event to state:

| Hook event                                   | State     |
|----------------------------------------------|-----------|
| `SessionStart`                               | idle      |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact` | working |
| `PermissionRequest`                          | waiting   |
| `Notification` with `notification_type` in `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | waiting |
| `Notification` with any other type           | no change |
| `Stop`, `StopFailure`                        | idle      |
| `SessionEnd`                                 | exited    |

Every event also carries `session_id`, which updates the session reference.

`tomo integrations install` adds the same hooks to `~/.claude/settings.json`
so a `claude` that a user starts by hand inside a Tomo pane also reports.

## Codex

Codex reads hooks only from `~/.codex/hooks.json` (and project-level
`.codex/hooks.json`). There is no per-launch flag. Run:

```bash
tomo integrations install
```

This merges entries for `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, and `Stop` into `~/.codex/hooks.json`.
Existing entries stay. Entries that contain `tomo hook codex` are replaced,
so a moved binary needs only a re-run.

Codex does not run a new hook until you trust it. The first time Codex starts
after the install, it shows a "hooks need review" panel. Press `t` to trust
all hooks. Until you do that, Tomo sees Codex only through the process
heuristic: the state is `working` or `unknown`, and there is no session
reference. Tomo does not write the trust entries itself, because the hash
format in `~/.codex/config.toml` is not documented.

Codex payloads use the same event names and fields as Claude, so the mapping
table above applies. The session reference comes from `session_id` in the
first hook payload.

Spawn: `codex`, or `codex resume <id>` after a restart. A Codex pane that
has no session reference (hooks not trusted yet) resumes with
`codex resume --last`, which picks the most recent Codex session in that
directory. When two Codex panes share a worktree, both would resume the same
session, so trust the hooks to get exact resume.

## Pi

Spawn:

```bash
pi -e <data dir>/integrations/tomo-status.ts --session-id <uuid>
pi -e <data dir>/integrations/tomo-status.ts --session <ref>   # after restart
```

The extension source is `integrations/pi/tomo-status.ts`, embedded in the
daemon and written to the data directory on every start. It connects to
`TOMO_SOCKET` with Node's `net` module and sends one `agent_hook` request per
event.

| Pi event                          | State     |
|-----------------------------------|-----------|
| `session_start`                   | idle      |
| `agent_start`, `ui_prompt_end`    | working   |
| `ui_prompt_start`                 | waiting   |
| `agent_settled`                   | idle      |
| `session_shutdown` with reason `quit` | exited |
| `agent_end`, `turn_end`, other    | no change |

The session reference is the session file path when the file exists,
otherwise the session id. Pi creates the file on the first message.

`tomo integrations install` also copies the extension to
`~/.pi/agent/extensions/tomo-status.ts` for a `pi` started by hand.

## Authority and merging

```text
1 lifecycle   hooks, extension events, process exit
2 report      explicit `agent_report` over the socket
3 screen      reserved
4 heuristic   process monitor
5 unknown     initial state of a spawned or restored pane
```

`agents::merge` applies an incoming report when one of these holds:

- the report's authority is stronger (lower number);
- the authority is equal and the report is not older than the current state;
- the current state is older than `STALE_MS` (15 minutes).

A report without a state never changes the state; it may still update the
session reference and pid. Kind changes only with equal or stronger
authority.

Timestamps come from the sender (`at_ms`). A hook that arrives late cannot
rewind a newer state.

## The process heuristic

Every poll, the daemon looks for a descendant of the pane shell whose name or
command matches an agent (`claude`, `codex*`, `pi`, or a command that contains
`pi-coding-agent`). When found, it reports authority `heuristic` with:

- state `working` when the agent subtree uses more than 3% CPU;
- no state otherwise.

When a presence had a pid and the process is gone, the daemon reports
`exited` with authority `lifecycle`.

The heuristic never reports `idle` or `waiting`. It can only fill in
`working` when no hook has spoken for 15 minutes, or when the agent was
started without hooks.

## Attention

A transition into `waiting` creates an attention item for the pane and
worktree. Leaving `waiting` resolves it. `tomo notify "text"` creates an
item by hand; it infers the pane from `TOMO_PANE_ID` and the worktree from
the pane.

## Spawning helpers from an agent

```bash
tomo agent spawn codex --cwd .
```

The daemon resolves the worktree from the path, creates a pane in the active
tab (split from the active pane), starts a login shell with the Tomo
environment, and types the spawn command. The GUI shows the pane at once
through the `tabs_changed` and `agent_changed` events. Add `--split` inside a
Tomo pane to split from the calling pane instead.

## Test fixtures

`scripts/fixtures/fake-provider` is one Node script with three flavors. It
drives the same daemon code paths as the real binaries, and it calls no
model.

```bash
node scripts/fixtures/fake-provider claude|codex|pi [provider flags]
# stdin: work N | wait | quit
```

| Flavor | Reads                                   | Sends                                  | Session file                                   |
|--------|-----------------------------------------|----------------------------------------|------------------------------------------------|
| claude | `--settings` hook file                  | hook JSON through each hook command    | `$HOME/.claude/projects/<cwd>/<id>.jsonl`      |
| codex  | `$HOME/.codex/hooks.json`, trust entries in `config.toml` | hook JSON, only for trusted entries | `$HOME/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| pi     | the `-e` extension, loaded as TypeScript | whatever `tomo-status.ts` sends        | `$HOME/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl` |

The fixture sets `process.title` to the flavor, as Pi does, so the process
monitor sees `claude`, `codex`, or `pi`. A resume fails as it does in the
installed binaries: Claude `--resume` and Pi `--session <id>` need a session
file, and the file exists only after the first message.

`scripts/torture/providers.sh` points `[agents.*]` at the fixture and sets
`HOME` to a scratch directory. For each provider it checks spawn, state,
attention, session identity, process detection, restart resume, reopen, and
exit. A product limitation shows as `KNOWN` with its reason.
