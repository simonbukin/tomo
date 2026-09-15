# Architecture

## Parts

```text
Tomo.app (Tauri)  ──┐
                    ├── Unix socket, newline-delimited JSON ──► tomod
tomo (CLI)        ──┘                                            │
                                                                 ├── PTYs (shells, agents, anything)
                                                                 ├── SQLite
                                                                 ├── git (child processes)
                                                                 └── process table (sysinfo)
```

`tomod` is the only part that holds live state. The GUI and the CLI are
clients. They use the same daemon operations. Nothing important is
implemented only in the GUI.

The Tauri process does not talk to the daemon in JavaScript. A small Rust
bridge (`app/src-tauri/src/lib.rs`) holds one socket connection, forwards
`invoke("rpc", …)` calls, and re-emits daemon frames as the `daemon-event`
window event. When the daemon is not reachable, the bridge starts it and
retries. The webview never opens a network port.

## Invariant: reality lives outside Tomo

Git owns repositories and worktrees. The filesystem owns files. Processes are
normal OS processes. Claude, Codex, and Pi own their conversations.

Tomo never creates a hidden working directory and never stores a repository in
a private format. If you delete Tomo and its data directory, every worktree,
branch, file, and agent transcript still exists and works.

Why: the value of Tomo is visibility and recovery, not ownership. Ownership
would make Tomo a single point of failure.

## Invariant: the worktree is the context boundary

Every pane belongs to exactly one worktree. Every tab belongs to one worktree.
Every agent presence, attention item, and process classification carries a
`worktree_id`. The daemon refuses to create a pane without a worktree: a
`pane_create` call must give a `worktree_id` or a `cwd` that lies inside a
known worktree.

Tomo has no Task, Job, Run, or Project object. Organization is metadata on the
worktree (display name, project, state, tags).

Why: one durable unit makes recovery, resource roll-up, and attention routing
simple. The user thinks in worktrees, so Tomo does too.

## Three categories of state

Every persisted field falls into one category. The category decides who may
overwrite it.

| Category                    | Examples                                                       | Rule                                                          |
|-----------------------------|----------------------------------------------------------------|---------------------------------------------------------------|
| Authoritative Tomo metadata | known repository roots; display name, project, state, tags, town unlocks | Only the user (through GUI, CLI, or a hook script) changes it. |
| Cached external observation | worktree path, gitdir name, branch, dirty state, diff counts   | Rediscovered from Git on every refresh. Never trusted forever. |
| Recoverable runtime state   | tabs, layout tree, panes, cwd, agent kind, session reference, attention, UI state | Written so a restart can rebuild the shape of the work. |

In memory the daemon keeps the same split. `WorktreeState.branch`,
`head`, `detached`, `exists`, and `git` come from `git worktree list
--porcelain` and `git status --porcelain=v2`. `WorktreeState.metadata` comes
from SQLite. The `Worktree` struct sent to clients merges both, but the
`metadata` field is the only part a client may set.

Why: if Tomo cached a branch name and a user renamed the branch in a plain
terminal, a stale cache would lie. Rediscovery keeps Tomo honest. Metadata is
the one thing Git cannot know, so Tomo must own it.

## Discovery

The daemon keeps a list of repository roots in SQLite. On start, on
`worktree_refresh`, when a client adds a repository, when the Git watcher sees
a change under `<repo>/.git`, and every 30 seconds, the daemon runs:

```text
git worktree list --porcelain     (per repository)
git rev-parse --git-common-dir    (per repository)
git status --porcelain=v2 --branch
git diff HEAD --numstat           (per worktree, concurrently)
```

The result replaces the in-memory worktree map. A worktree that Git no longer
lists stays visible only when it still has tabs; it is then marked
`exists: false`.

The watcher ignores `objects/`, `logs/`, and `*.lock` paths and debounces for
400 ms.

## Worktree identity

`worktree_id` is the first 12 hex characters of a UUID v5 of the canonical
worktree path. This is deterministic, so two daemons and two machines agree
without a registry.

A moved worktree gets a new id. To keep metadata and tabs, discovery also
records the Git `gitdir` name (`<common>/worktrees/<name>`). When a discovered
worktree has no metadata row but a row with the same repository and gitdir
name points at a path that no longer exists, the daemon rebinds that row and
its tabs, panes, and attention items to the new id.

Why: a path is the identity the user sees, and it works for the main
worktree, which has no gitdir file. The gitdir name is the only stable token
Git gives a linked worktree, so it serves as the reconciliation key.

## Processes

The daemon polls the process table every 2 seconds while a GUI is subscribed
and every 15 seconds otherwise. For each live pane it walks the descendants of
the pane shell.

- **owned**: descends from a pane shell. Carries `pane_id` and depth.
- **observed**: not owned, but its cwd lies inside a known worktree.
- **unknown**: everything else. Not reported.

Only owned processes are candidates for `process_kill_tree`. The daemon never
kills an observed process. Resource roll-up sums CPU and resident memory over
owned and observed processes per worktree; each pid counts once.

Why: cwd is evidence, not proof. Killing on evidence would eventually kill the
wrong thing.

## Agent state authority

Each agent presence records the authority of its current state:

```text
1 lifecycle   hook or extension event, or process exit
2 report      explicit tomo CLI report
3 screen      reserved, not implemented
4 heuristic   process tree and CPU activity
5 unknown
```

A report replaces the current state only when it is stronger, or equal and
not older, or when the current state is older than 15 minutes. A session
reference always updates. See `agents::merge` and
[agent-integrations.md](agent-integrations.md).

Why: a hook says "waiting". A CPU sample a second later says "working" because
the terminal repainted. The weaker signal must not win.

## States and tags

A worktree has at most one **state** and any number of **tags**. State
answers "where is this in my workflow?"; tags answer "what is this about?".
The state values are personal configuration (`[[states]]` in
`config.toml`), not protocol enums. The daemon rejects a state that the
config does not list, so every client sees the same taxonomy.

Why two dimensions: grouping, filtering, and hooks want one ordered axis
(state) and one free-form axis (tags). A state disguised as a tag has no
order and no single value.

## Events and hooks

Meaningful transitions become typed events (`HookEvent` in `tomo-proto`):
worktree discovered, created, before_archive, archived, restored,
state_changed; pane created and closed; agent started, working, waiting,
idle, exited; attention created; action started, exited, and crashed;
runtime endpoint discovered and removed; checkpoint created and resolved.
Each event runs the matching `[[hooks]]`
entries from `config.toml` as ordinary processes with the event JSON on
stdin. A hook that wants to change Tomo calls the `tomo` CLI, so the GUI,
the CLI, hooks, and agents share one behavioral API.

Only `worktree.before_archive` is synchronous: the archive waits for it and
a non-zero exit aborts. Every other hook runs detached with a timeout, and
its result goes to `<data dir>/hooks.log` and to a `HookRan` event. Handlers
queue events while they hold the state lock and dispatch them after the
request finishes, so a slow script can never stall a keystroke.

Why: hooks exist to react to reality after it changed. The one exception is
a destructive operation, where a script may still say no. See
[hooks.md](hooks.md).

A PTY exit callback runs on the PTY reader thread, outside tokio. The
callback enters the daemon's runtime handle before it calls
`Daemon::on_exit`, so the hooks that this path fires (`pane.closed`,
`action.exited`) can spawn their processes. Before this fix those hooks
never ran.

## Feature boundary: Actions

Repo-defined Actions live in `crates/tomod/src/features/actions.rs` (the
`.tomo.toml` parser), `Daemon::reload_actions`, `Daemon::run_action`, and
`Daemon::stop_action`. The watcher treats a change to `.tomo.toml` at a
worktree root as an actions change, not a Git change. A pane started by an
action carries `Pane.action_id`, which is how a second run finds the live
pane. See [actions.md](actions.md).

## Feature boundary: Browser panes

A pane has a `kind`: `terminal` or `browser`. A browser pane is a row in
`panes` with `kind = browser` and a `url`, and no PTY. The daemon owns the
pane and the url; the Tauri process owns the page in a child webview
labelled `browser-<pane id>`. `annotations_send` turns an `EvidenceBundle`
into plain text, types it into an agent pane inside a bracketed paste,
records an `annotations_sent` activity event, and runs the
`annotation.sent` hooks. See [browser.md](browser.md).

Why the daemon owns the pane but not the page: the layout, the restore
path, and the CLI must see one kind of thing. The page itself is display
state; a restart reloads the url and loses nothing that Tomo promised to
keep.

## Layout operations

The tab layout is a binary split tree (`LayoutNode`). Pure functions in
`layout.rs` implement split, remove, resize, equalize, swap, rotate, and
`split_of`; `is_valid` checks unique pane ids and ratios in range after
every mutation. `insert`, `beside`, `move_within`, `move_to_edge`, and
`reorder` back the `pane_move` and `tab_move` calls; `moves.rs` applies them
to daemon state and refuses to store a tree that is not valid. A pane moves
next to a target pane (a new 50/50 split on the drop side), swaps with it
(`center`, also across tabs), or goes to an edge of a tab. A cross-tab move
out of the last pane of a tab deletes that empty tab. A move never crosses
worktrees, and a cross-tab move into a tab that holds `max_panes_per_tab`
panes is a conflict. Zoom is transient GUI state: the daemon only forwards a
`ZoomRequest` event and never changes the persisted tree. Agent-driven
spawns go to a new tab once a tab holds `max_panes_per_tab` panes.

## Integration health

`tomo integrations status` reports each agent as `full` (lifecycle hooks
and resume), `partial` (resume only; for Codex, hooks installed but not
trusted), `process_only` (binary found, no hooks installed), or
`unavailable` (binary not on PATH), with a reason. The GUI shows the same
list from the palette.

## Login PATH

A daemon that the installed app starts gets the bare launchd `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`). Then `codex`, `gh`, `pnpm`, and other
tools are not found. At start, before the runtime makes any thread,
`login_env::apply` examines `PATH`. If `PATH` has neither
`/opt/homebrew/bin` nor `/usr/local/bin`, or does not have
`$HOME/.local/bin`, the daemon runs `$SHELL -l -i -c` once to print the
login `PATH` between two markers. The shell gets two seconds, then the
daemon kills its process group. The new `PATH` is the login entries first,
then the old entries, without empty or duplicate entries. A daemon that
starts from a terminal with a full `PATH` does not run the shell. Panes,
Actions, hooks, and adapters inherit the new `PATH`.

## Addons

An addon is an optional opinion in its own source folder. Core never
imports it. Towns is the first addon:

- `crates/tomo-proto/src/addons/towns.rs`: wire types
- `crates/tomod/src/addons/towns/`: calls, the `towns` table, the seams
- `app/src/addons/towns/`: the map view, the ceremony, the create field

Composition roots name the addons: `crates/tomod/src/main.rs`,
`crates/tomod/src/addons/mod.rs`, `crates/tomod/src/dispatch.rs`, `lib.rs`
in `tomo-proto`, and `app/src/addons/index.ts`. Core calls an addon only
through `Seams`, a struct of plain function lists that `main.rs` builds one
time. The server sends every call to `dispatch::handle`, which answers the
addon calls and gives the other calls to `Daemon::handle`. See
[addons.md](addons.md) and [features/towns.md](features/towns.md).

## Generated bindings

`crates/tomo-proto` is the only source of truth for the protocol. `ts-rs`
exports every wire type to `app/src/generated/*.ts`. `cargo test -p
tomo-proto` fails when those files are stale; `TOMO_WRITE_TYPES=1 cargo
test -p tomo-proto` rewrites them. The frontend re-exports them from
`app/src/types.ts` and keeps only view-only types by hand.

Protocol version 3 adds:

- calls `action_list`, `action_run`, `action_stop`, `action_restart`, and
  a `checkpoint` field (`checkpoint`, `require_clean`, `discard`) on
  `worktree_archive`, which now returns an `ArchiveResult`;
- the `actions_changed` event with one `ActionSet` per worktree;
- `Pane.action_id`, `Snapshot.actions`, and `GitSummary.conflicts`;
- the `action` field on `HookEvent`.

Phase 3 adds, at the same protocol version:

- calls `runtime_list`, `activity_list`, `checkpoint_create`, and
  `checkpoint_resolve`;
- events `endpoints_changed`, `activity_added`, and `attention_resolved`;
- `Snapshot.endpoints`, and `kind`, `url`, `agent_kind`, `resolved_at_ms`
  on `AttentionItem`;
- hook events `action.crashed`, `runtime.endpoint_discovered`,
  `runtime.endpoint_removed`, `checkpoint.created`, `checkpoint.resolved`.

## Feature boundary: runtime endpoints and activity

`crates/tomod/src/runtime.rs` finds listening TCP ports with one `lsof`
call per monitor tick, attributes each pid to the pane whose PTY root is
its ancestor, and debounces a restart. `crates/tomod/src/activity.rs`
holds `Daemon::record`, the one way an event enters the `activity` table.
`PaneState.stop_intent` is how `Daemon::on_exit` tells a crash from a
stop. See [runtime.md](runtime.md) and [activity.md](activity.md).

Phase 3 adds `Pane.kind` and `Pane.url`, the calls `browser_open`,
`browser_navigate`, and `annotations_send`, the `activity_added` event, and
the `annotation.sent` hook event.

## IPC

Transport: Unix domain socket at `<data dir>/tomod.sock`. Frames are one JSON
object per line.

Request:

```json
{"id": 7, "method": "pane_resize", "params": {"pane_id": "p", "cols": 80, "rows": 24}}
```

Responses and events:

```json
{"id": 7, "result": null}
{"id": 7, "error": {"code": "not_found", "message": "pane not found"}}
{"seq": 12, "event": "agent_changed", "data": {...}}
```

Error codes: `bad_request`, `not_found`, `conflict`, `git`, `io`,
`unsupported`, `internal`, `aborted`.

A client sends `hello` with `protocol: 3`. The daemon rejects other versions.
A client sends `subscribe` to receive events and gets a full snapshot back.
Pane output flows only to clients that sent `pane_attach` for that pane. The
first output after attach is the stored scrollback.

Requests on one connection run in order. Git-backed calls (`repo_add`,
`repo_clone`, `worktree_refresh`, `worktree_create`, `git_summary`,
`repo_remove`) run in a separate task so a slow `git status` cannot delay a
keystroke.

The Rust types in `crates/tomo-proto` are the contract. The TypeScript
types are generated into `app/src/generated/` (see "Generated bindings").

## Lifetime

Closing the window does not stop the daemon. The daemon stops only on
`tomo daemon stop`, SIGTERM, or Ctrl-C. On stop it writes each pane's
scrollback to disk and sends SIGHUP to each pane shell.

A second `tomod` refuses to start when the socket already answers.

## Performance

Measured with `scripts/perf.sh` on an Apple Silicon Mac, release build,
2 repositories and 27 worktrees, 3 restored panes:

| Step                                   | Time     |
|----------------------------------------|----------|
| tomod start to socket accepting        | ~90 ms   |
| first request answered                 | ~5 ms    |
| worktrees visible (names, branches)    | ~150 ms after launch |
| git summaries for all 27 worktrees     | ~600 ms after launch |
| `worktree_refresh` on a quiet daemon   | ~450 ms  |
| process poll (`ps`, fresh)             | ~10 ms   |
| daemon idle CPU with a GUI attached    | ~0.3 %   |
| daemon resident memory                 | ~13 MB   |
| app: window created (Tauri setup)      | ~240 ms after process start |
| app: first request to the daemon       | ~430 ms after process start (warm) |
| app main bundle                        | ~295 KB JS; terminal and map chunks load on demand |

Run the app binary with `TOMO_TIMING=1` to print these marks on stderr.

Design choices behind these numbers:

- The socket is served before discovery runs. Discovery has two phases:
  a fast pass that lists worktrees from `git worktree list` and keeps the
  cached summaries, then a full pass that runs `git status` for every
  worktree concurrently. Clients see names first and diff counts later.
- Git watcher events trigger only the fast pass. Explicit refresh, repo
  changes, and startup run the full pass.
- `git diff --numstat` runs only for worktrees that `git status` reports
  dirty.
- The process poll fetches command lines and working directories once per
  process. Only pane shells get their cwd re-read on every poll, which
  keeps the 2-second poll near 10 ms.
- The GUI loads the town dataset and the map view lazily, so the main
  bundle stays under 800 KB.
