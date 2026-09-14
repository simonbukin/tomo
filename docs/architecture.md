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
worktree (display name, project, priority, tags).

Why: one durable unit makes recovery, resource roll-up, and attention routing
simple. The user thinks in worktrees, so Tomo does too.

## Three categories of state

Every persisted field falls into one category. The category decides who may
overwrite it.

| Category                    | Examples                                                       | Rule                                                          |
|-----------------------------|----------------------------------------------------------------|---------------------------------------------------------------|
| Authoritative Tomo metadata | known repository roots; display name, project, priority, tags  | Only the user (through GUI or CLI) changes it.                 |
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
`unsupported`, `internal`.

A client sends `hello` with `protocol: 1`. The daemon rejects other versions.
A client sends `subscribe` to receive events and gets a full snapshot back.
Pane output flows only to clients that sent `pane_attach` for that pane. The
first output after attach is the stored scrollback.

Requests on one connection run in order. Git-backed calls (`repo_add`,
`repo_clone`, `worktree_refresh`, `worktree_create`, `git_summary`,
`repo_remove`) run in a separate task so a slow `git status` cannot delay a
keystroke.

The Rust types in `crates/tomo-proto` are the contract. The TypeScript
mirror lives in `app/src/types.ts`.

## Lifetime

Closing the window does not stop the daemon. The daemon stops only on
`tomo daemon stop`, SIGTERM, or Ctrl-C. On stop it writes each pane's
scrollback to disk and sends SIGHUP to each pane shell.

A second `tomod` refuses to start when the socket already answers.
