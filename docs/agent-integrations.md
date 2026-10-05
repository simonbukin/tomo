# Agent integrations

Tomo supports Claude Code, Codex, Pi, and OpenCode. Each integration does three things:

1. identifies the pane an agent runs in;
2. reports lifecycle state (working, waiting, done, idle, dead, exited), what the agent asks when it waits,
   and its subagents;
3. captures a native session reference for resume.

Tomo adds no UI inside any agent. Every integration is a thin reporter that
talks to `tomod` through the public path: the `tomo hook` command or the
daemon socket.

## Where the provider code lives

```text
crates/tomod/src/providers/
  mod.rs       the Provider table, fn provider(kind), and the loops over the table
  claude.rs    claude.rs, codex.rs, pi.rs, and opencode.rs each hold one Provider value
  codex.rs
  pi.rs
  opencode.rs
```

A `Provider` value gives the command flags, the resume fallback, the hook
table, process detection, the environment markers, the file Tomo writes for
its own starts, the install, the health gap, and the session reader. Core
keeps `AgentKind`, presence, state, session identity, attention, and
`agents::merge`. To add a provider, write one module, add one arm to
`provider`, and add the variant to `AgentKind`. A missing capability does not
compile.

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
before it starts the shell: every `TOMO_*`, every `ORCA_*`, and the marker of
each provider (`CLAUDECODE`, every `CLAUDE_CODE_*`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`,
every `CODEX_SANDBOX*`, `PI_CODING_AGENT`, `OPENCODE`, `OPENCODE_SESSION_ID`, and
`OPENCODE_TERMINAL`). Each provider module names its own
markers in `nested_env`. Without this, a daemon that
was started from inside another agent would make every pane look like a
nested child session; Claude, for example, then turns transcript saving off.

## The `tomo hook` command

```bash
tomo hook claude   # reads the hook JSON from stdin
tomo hook codex
tomo hook pi
tomo hook opencode
```

The command sends `agent_hook { kind, pane_id, payload, at_ms }` to the
daemon. The daemon maps the payload to a state with `providers::hook_outcome`
and applies it with authority `lifecycle`. Errors are swallowed: a hook must
never break the agent.

## Claude Code

Spawn command (`providers::launch`, with the flags of `providers/claude.rs`):

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
| `Stop`                                       | done      |
| `StopFailure`                                | dead      |
| `SessionEnd`                                 | exited    |

Every event also carries `session_id`, which updates the session reference.

The question of a wait: the first question of an `AskUserQuestion`, the command of a
shell tool (`Bash: rm -rf build`), the file of an edit, or the tool name, from the
`PermissionRequest` payload. `ask_text` in `providers/mod.rs` builds it for every provider.

### Subagents

`AgentPresence.subagents` lists the helper agents that an agent started. A
provider maps its own payloads to a `SubagentEvent` in its `hook_outcome`,
and `crates/tomod/src/subagents.rs` folds the events into the list. A new
provider with subagents only fills `HookOutcome.subagent`. Core has no code
for one provider.

| Claude Code payload                                   | Subagent event |
|-------------------------------------------------------|----------------|
| `PreToolUse` of `Agent` or `Task`, with no `agent_id` | launch: `subagent_type` and `description` |
| `SubagentStart` with `agent_id`, `agent_type`         | start: takes the oldest launch with the same type |
| `SubagentStop` with `agent_id`                        | stop: the subagent is done |
| any other event with `agent_id`                       | the subagent is working or waiting, from the same table |

When the parent goes idle, the list keeps only the subagents that still run.
When the parent exits, the list is empty. The list holds at most 16 items.

`tomo integrations install` adds the same hooks to `~/.claude/settings.json`
so a `claude` that a user starts by hand inside a Tomo pane also reports.

## Codex

Spawn (`providers/codex.rs`):

```bash
codex --no-daemon -c 'hooks.state={"<hooks.json>:stop:0:0"={trusted_hash="sha256:…"},…}'
codex --no-daemon -c 'hooks.state={…}' resume <id>      # after a restart, a wake, or a reopen
```

`--no-daemon` keeps the session in the pane's own Codex process. Without it,
Codex 0.159 runs the session in a shared background server and starts the
hooks with that server's environment. That environment has no `TOMO_PANE_ID`,
so no event reaches Tomo.

Codex reads hooks from `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`).
`tomo integrations install` merges Tomo's entries for `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`,
`SubagentStart`, `SubagentStop`, `Interrupt`, and `SessionEnd` into it.
Existing entries stay. Entries that contain `tomo hook codex` are replaced.

Codex runs a hook only when its trust hash is the one the user trusted: the
sha256 of the hook group as compact JSON with sorted keys
(`codex::trust_hash`). A Codex that Tomo starts gets the trust of Tomo's own
entries for that launch in `-c hooks.state={...}`, so it reports with no trust
step. A Codex that you start by hand reports only when you start it with
`--no-daemon` and after you trust the hooks once in its hooks panel (press
`t`). The health check compares the hash in `~/.codex/config.toml` with the
hash of each Tomo entry; a stale hash is not trust.

| Codex hook | State |
|---|---|
| `SessionStart` | idle (it fires at the first prompt, not at launch) |
| `UserPromptSubmit`, `PreToolUse`, `PreCompact`, `PostCompact` | working |
| `PostToolUse` | working, only while the agent works or waits: a background tool that ends after the turn does not start it again |
| `PermissionRequest` | waiting, with the command as the question |
| `PreToolUse` of `…request_user_input` | waiting, with the first question |
| `Stop` | done |
| `Interrupt` | idle, only while the agent works or waits |
| `SessionEnd` | exited |

Codex puts a tool's namespace in front of its name in a hook: multi-agent v2
reports `spawn_agent` as `collaborationspawn_agent`. So Tomo matches a tool by
the end of its name.

| Codex payload | Subagent event |
|---|---|
| `PreToolUse` of `…spawn_agent`, with no `agent_id` | launch: `agent_type` (or `default`), and `task_name` as the description |
| `SubagentStart` with `agent_id`, `agent_type` | start |
| `SubagentStop` with `agent_id` | stop |
| any other event with `agent_id` | the subagent works or waits |

The session reference is `session_id` from the first hook. Codex chooses it,
so a pane has no reference before its first prompt. Such a pane resumes with
`codex resume --last`. Sessions are rollouts in
`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`: the session list
skips a rollout with a `parent_thread_id` (a subagent), and it reads the user
and agent text in both the old `user_message` lines and the paginated
`item_completed` lines.

A Codex hook counts only while the pane runs a `codex` process
(`hooks_need_process`). A shared Codex server that was started from a Tomo pane
keeps that pane in its environment, and it must not report other sessions there.

Codex sends no hook when a turn ends in an error, so a failed turn shows
`done`, not `dead`. Codex starts `codex-code-mode-host` as a helper; a sleep
may end it.

## Pi

Spawn:

```bash
pi -e <data dir>/integrations/tomo-status.ts --session-id <uuid>
pi -e <data dir>/integrations/tomo-status.ts --session-id <id>     # after a restart: opens or creates the session
pi -e <data dir>/integrations/tomo-status.ts --session <file>      # when the reference is a session file
```

The extension source is `integrations/pi/tomo-status.ts`, embedded in the
daemon and written to the data directory on every start. It connects to
`TOMO_SOCKET` and sends one `agent_hook` request for each event, one at a
time, in order. Pi waits for the send, so the event of a quit reaches Tomo
before the process exits. When the daemon does not answer, the extension
appends the event to `<data dir>/hook-spool.jsonl` in the same line format as
`tomo hook`.

| Pi event | Extension sends | State |
|---|---|---|
| `session_start` | `session_start` | idle |
| `agent_start` | `agent_start` | working |
| `agent_end` | nothing; it keeps the outcome of the last assistant message | |
| `agent_settled` | `agent_settled` with `outcome` | done (`completed`), idle (`aborted`, an Esc), dead (`error`) |
| `ui_prompt_start` | `ui_prompt_start` with `kind`, `title` | waiting, with the title as the question |
| `ui_prompt_end` | `ui_prompt_end` with `running` | working while a run continues, else idle |
| `tool_execution_start` of `subagent` | `subagent_start` for each task, with `agent`, `task` | subagent start |
| `tool_execution_end` of `subagent` | `subagent_stop` for each task | subagent stop |
| `session_shutdown` with reason `quit` | `session_shutdown` | exited |

A subagent tool starts child `pi` processes that inherit the pane's
environment. Only the first Pi of a pane reports (`TOMO_PI_PID`), so a child
cannot end or finish the parent's turn. The extension also registers only
once in a process, so the copy in `~/.pi/agent/extensions/` and the `-e` copy
do not report each event twice.

The session reference is the session file path when the file exists,
otherwise the session id. Pi writes the file on the first message. The session
list reads `~/.pi/agent/sessions/--<cwd>--/*.jsonl`: the id is in the header
line, and the title is the latest `session_info` name or the first prompt.

`tomo integrations install` also copies the extension to
`~/.pi/agent/extensions/tomo-status.ts` for a `pi` started by hand.

## OpenCode

Spawn:

```bash
opencode --session ses_<id>      # a new session: Tomo chooses the id in OpenCode's own shape
opencode --session ses_<id>      # a resume: the same command opens the session
```

`--session` opens the session, or creates it with that id at the first prompt.
So a new pane is resumable at once, as with Claude and Pi.

OpenCode 2 runs one shared background server for every terminal. A plugin in
that server cannot tell which pane an event belongs to, so Tomo's integration
is a TUI plugin, which runs in the pane's own `opencode` process:
`integrations/opencode/tomo-status/tui.js`. `tomo integrations install` writes
it to `~/.config/opencode/plugins/tomo-status/tui.js`. Outside a Tomo pane it
does nothing.

The server sends the events of every TUI to every TUI, so the plugin reports
only the sessions that its TUI shows: the `--session` of the launch, the
current route, and the open tabs. It sends each event through
`tomo hook opencode`, one at a time, so the spool works as for Claude.

| OpenCode event | Plugin sends | State |
|---|---|---|
| plugin start, with `--session` | `ready` | idle |
| `session.execution.started` | `started` | working |
| `session.execution.succeeded` | `succeeded` | done |
| `session.execution.interrupted` with reason `user` or `inactivity` | `interrupted` | idle, only while the agent works or waits |
| `session.execution.failed` | `failed` | dead |
| `permission.asked` | `permission` with `action`, `resource` | waiting, with `action: resource` as the question |
| `form.created` (the question tool) | `question` | waiting, with the question |
| `permission.replied`, `form.replied`, `form.cancelled` | `answered` | working |
| the process exit | `exit` | exited |

A subagent of OpenCode is a child session. `session.created` with a
`parentID` sends `subagent` with the agent and the title, and the child's
end events stop it. An event of a child session carries `agent_id` and
changes only the subagent and a wait.

Sessions live in SQLite: `~/.local/share/opencode/opencode.db` (or
`$OPENCODE_DB`). Tomo opens it read-only. The session list reads the root
sessions of the cwd from `session_v2`, and search reads the text of
`session_message` through the provider's `transcript_messages`, because there
is no file to read line by line.

## Provider parity

| Capability | Claude | Codex | Pi | OpenCode |
|---|---|---|---|---|
| Integration | hooks (`--settings`, and user-level) | user-level hooks, trusted for each launch | extension (`-e`, and user-level) | TUI plugin (user-level) |
| Working, done | yes | yes | yes | yes |
| Waiting, with the question | yes | yes | yes (the dialog title) | yes |
| Idle after Esc | yes (`idle_prompt`, about a minute later) | yes (`Interrupt`) | yes (`aborted` outcome) | yes (`interrupted`) |
| Dead on an error | process end without `SessionEnd` | no hook for a failed turn | yes (`error` outcome) | yes (`failed`) |
| Exited | `SessionEnd` | `SessionEnd`, and the process monitor | `session_shutdown` quit | the process exit |
| Subagents | yes | yes (`spawn_agent`) | the `subagent` tool | child sessions |
| Session at spawn | yes (`--session-id`) | after the first prompt | yes (`--session-id`) | yes (`--session`) |
| Resume, sleep, reopen | yes | yes | yes | yes |
| Session list and search | yes | yes | yes | yes |
| Spool while the daemon is down | yes | yes | yes | yes |

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

Every poll, the daemon looks for a descendant of the pane shell that a
provider recognizes (`providers::detect`, the `detects` function of each
module):

| Provider | Program name or `argv[0]` |
|---|---|
| Claude | `claude` |
| Codex | `codex`, or `codex-<arch>-...` for the native binary |
| Pi | `pi`, or a `node` or `bun` process whose first argument is a script in the `pi-coding-agent` package |
| OpenCode | `opencode` |

A program that only mentions a provider, such as `codexbar` or an editor with
a file of the Pi package, is not an agent. When found, the daemon reports
authority `heuristic`: `working` after two busy samples (more than 3% CPU), and
`idle` after 10 s below the threshold. The tooltip of such a state says that it
is estimated. See rule 2 in [agent-states.md](agent-states.md).

When a presence had a pid and the process is gone, the daemon reports
`exited` with authority `lifecycle`.

The heuristic never reports `waiting`. The first hook event of a process ends the
heuristic for the life of that process.

## Attention

A transition into `waiting` creates an attention item for the pane and
worktree. Its message is what the agent asks, when the provider gives it, or
`<Agent> is waiting for you`. Leaving `waiting` resolves it. `tomo notify "text"` creates an
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

`scripts/fixtures/fake-provider` is one Node script with four flavors. It
drives the same daemon code paths as the real binaries, and it calls no
model.

```bash
node scripts/fixtures/fake-provider claude|codex|pi|opencode [provider flags]
# stdin: work N | wait | quit
```

| Flavor | Reads                                   | Sends                                  | Session file                                   |
|--------|-----------------------------------------|----------------------------------------|------------------------------------------------|
| claude | `--settings` hook file                  | hook JSON through each hook command    | `$HOME/.claude/projects/<cwd>/<id>.jsonl`      |
| codex  | `$HOME/.codex/hooks.json`, trust from `config.toml` or from `-c hooks.state=` | hook JSON, only for trusted entries | `$HOME/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| pi     | the `-e` extension, loaded as TypeScript | whatever `tomo-status.ts` sends        | `$HOME/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl` |
| opencode | the TUI plugin in `$HOME/.config/opencode/plugins/tomo-status/` | whatever the plugin sends | `$HOME/.local/share/opencode/opencode.db` (SQLite) |

The fixture sets `process.title` to the flavor, as Pi does, so the process
monitor sees `claude`, `codex`, `pi`, or `opencode`. A resume fails as it does in
the installed binaries: Claude `--resume` needs a session file, which exists only
after the first message. Pi `--session-id` and OpenCode `--session` create the
session when it does not exist.

`scripts/torture/providers.sh` points `[agents.*]` at the fixture and sets
`HOME` to a scratch directory. For each provider it checks spawn, state,
attention, session identity, process detection, restart resume, reopen, and
exit. A product limitation shows as `KNOWN` with its reason.
