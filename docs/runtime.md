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

A port number is never evidence. A process outside every pane tree is
never reported, even when it listens on a port that an Action usually
uses. The rule is the same as for `tomo ps`: owned means descended from a
pane shell.

## Protocol probe

Each new endpoint gets one probe, off the lock: a 400 ms TCP connect and
`HEAD / HTTP/1.0`. A reply that starts with `HTTP/` makes the endpoint
`http`; any other reply, or no reply, keeps it `tcp`. Until the probe
answers, the endpoint reports `tcp`. `https` is reserved and not produced.

## Lifecycle

- A new listener adds an endpoint, emits `endpoints_changed`, fires the
  `runtime.endpoint_discovered` hook, and records `EndpointDiscovered` in
  the activity stream (at most once per worktree and port per minute).
- A listener that disappears stays listed for 5 seconds. When a new pid
  listens on the same port in the same worktree inside that window, the
  entry is replaced and no hook fires. This makes a dev-server restart
  silent.
- After the 5 seconds the endpoint is removed, `endpoints_changed` is
  emitted, and `runtime.endpoint_removed` fires.

Endpoints live in memory only. A daemon restart rediscovers them on the
first poll.

## tomo runtime

```bash
tomo runtime [worktree] [--json]
```

Prints one line per endpoint: `port protocol pid process action pane`.
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
