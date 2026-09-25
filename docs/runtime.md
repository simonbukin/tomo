# Runtime endpoints

A runtime endpoint is a TCP port that a process inside a Tomo pane listens
on. Tomo finds the port, names the pane and the source that own it, and
tells clients when it appears and when it goes away. Tomo never opens the
port itself.

Runtime is an addon: `crates/tomod/src/addons/runtime/` in the daemon and
`app/src/addons/runtime/` in the GUI. Core owns the processes, their
ownership, and the pane provenance; the addon interprets the ports. Without
the addon, processes and panes work as before, and nothing reports a port.
See [addons.md](addons.md).

## Discovery

The process monitor polls the process table every 2 seconds while a GUI is
subscribed and every 15 seconds otherwise. After each poll Core calls the
`process_polled` seam with no lock held, and the addon runs one `lsof` call
for the owned processes:

```text
lsof -nP -iTCP -sTCP:LISTEN -a -p <pid,pid,...> -F pn
```

The pid list holds every owned process except an idle pane shell, which
cannot listen. When the list is empty, `lsof` does not run. The call runs
with the daemon lock released, so a slow `lsof` never delays a keystroke.
The call also has a deadline of 2 seconds. `lsof` can hang, for example on
a stale network mount, and the monitor tick waits for the answer, so a hung
call would stop the process poll, the agent state, and the resources of
every worktree. At the deadline Tomo kills the call, records the `runtime`
diagnostic `port scan: lsof did not answer in 2 s`, and keeps the endpoints
of the last scan. The next tick asks again.
`tomo runtime` triggers one extra poll when the last one is older than
1.5 seconds, the same rule as `tomo ps`.

Nothing polls faster than the monitor. There is no socket watcher.

## Attribution

Attribution goes from the pid to the pane whose PTY root is its ancestor,
then to the pane source (`Pane.source`). Runtime reads only the Core
source, not the Actions addon. The endpoint carries:

| Field            | Source                                                  |
|------------------|---------------------------------------------------------|
| `id`             | `<pid>:<port>`                                          |
| `worktree_id`    | The pane's worktree                                     |
| `pane_id`        | The pane that owns the process                          |
| `source`         | The pane source (`kind`, `id`, `label`), when it has one |
| `action_id`      | The source id, when an Action started the pane          |
| `label`          | The source label, when the pane has a source            |
| `pid`, `process` | The listening process and its name                      |
| `host`, `port`   | From `lsof`; `*`, `0.0.0.0`, `::`, `[::]` become `localhost` |
| `protocol`       | `http` or `tcp`; see below                              |
| `status`         | The status of `HEAD /` when the port speaks HTTP        |
| `probing`        | True while the port is not HTTP yet and the probe tries again |

A port number is never evidence. A process outside every pane tree is
never reported, even when it listens on a port that an Action usually
uses. The rule is the same as for `tomo ps`: owned means descended from a
pane shell.

## Protocol probe

Each new endpoint is probed off the lock: a 400 ms TCP connect,
`HEAD / HTTP/1.0`, and up to 1 s for the status line. A reply that starts with
`HTTP/` makes the endpoint `http` and keeps its status; any other reply, or
no reply, keeps it `tcp`. `https` is reserved and not produced.

A dev server listens before its first page compiles, so a cold Next or Vite
server answers too late for the first probe. A `tcp` endpoint is probed again
after 1, 2, 3, 5, 10, 20, and 30 seconds, and `probing` stays true until then.
The first HTTP answer stops the probe, and so does the end of the endpoint.
The rule is `model::next_probe`.

A status below 400 means the port serves a page. The GUI puts pages first, so
a worktree links to its app and not to a devtools server that answers 404.

## Lifecycle

- A new listener adds an endpoint, emits `endpoints_changed`, fires the
  `runtime.endpoint_discovered` hook, and records `EndpointDiscovered` in
  the activity stream (at most once per worktree and port per minute).
- A listener that disappears stays listed for 15 seconds. When a new pid
  listens on the same port in the same worktree inside that window, the
  entry is replaced and no hook fires. This makes a dev-server restart
  silent. The window is long because a dev server that builds again before
  it listens again can need more than a few seconds.
- After the 15 seconds the endpoint is removed, `endpoints_changed` is
  emitted, and `runtime.endpoint_removed` fires.

Endpoints live in memory only. A daemon restart rediscovers them on the
first poll.

## tomo runtime

```bash
tomo runtime [worktree] [--json]
```

Prints one line per endpoint: `port`, what it serves (`page 200`, `http 404`,
`checking`, or `tcp`), `pid`, `process`, `action`, and `pane`.
Without an argument it uses `TOMO_WORKTREE_ID`, else every worktree.
`--json` prints the `RuntimeEndpoint` list. The snapshot that `subscribe`
returns carries the same list in `endpoints`.

## In the GUI

The addon draws the runtime button of the worktree top bar, the endpoint
menu, the palette entries, the NOW signal of the first HTTP endpoint, and
the endpoints that no pane source owns in the overflow menu. It gives the
checkpoint banner and the Activity rows their "Open App" link through the
`appUrl` slot.

Runtime and Actions do not know each other. Both meet at the Core
`PaneSource`: Runtime draws the arrow inside an Action button through the
`sourceMark` slot, gives that button its open and copy items through
`sourceMenu`, and asks the owner of a source for restart and stop through
`paneSource`.
