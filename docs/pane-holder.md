# Pane holder

Each terminal pane runs under a small holder process. The holder owns the
PTY, so a pane outlives a restart or a crash of `tomod`. An agent keeps its
turn, its subagents, and its background shells when the daemon restarts for
an upgrade.

The code is in `crates/tomod/src/holder.rs` (the holder and its protocol)
and `crates/tomod/src/pty.rs` (`PtySession`, the daemon side).

## Why

When `tomod` held the PTY master itself, its exit closed the master, and the
kernel hung up every pane. A restart then started a fresh shell and resumed
the agent from its session reference. That keeps the conversation, but it
loses the turn in progress, running subagents, and background shells. No
agent can resume a model stream or a subagent that was cut off. The only way
to keep them is not to end the process.

## Shape

- `tomod pty-holder` reads a JSON spec on stdin, forks, and the first process
  exits when the holder listens. So `tomod` gets a clear result and never
  keeps a child. The holder calls `setsid`, so it is not in the daemon's
  session.
- The holder opens the PTY, starts the pane's command, keeps the master open,
  keeps the last 2 MB of output in a ring, and serves one socket at
  `<data dir>/pty/<pane id>.sock`. It has no terminal emulator and no Tomo
  logic.
- The holder is the child's parent, so it reports the real exit code.
- A holder is the `tomod` binary of the day it started. An install replaces
  the file, but a running holder keeps its code.

## Protocol

Frames are a kind byte, a little-endian `u32` length, and the payload.

| Frame | Direction | Meaning |
|---|---|---|
| `hello {version}` | daemon to holder | First frame |
| `welcome {version, pid, alive}` | holder to daemon | `alive` is false when the child already exited |
| `attach` | daemon to holder | Start the stream |
| `replay {bytes}` | holder to daemon | The ring, once, before any output |
| `output {bytes}` | holder to daemon | New output |
| `input {bytes}` / `resize {cols, rows}` / `signal {n}` | daemon to holder | Terminal input |
| `close` | daemon to holder | End the pane: close the master and send SIGHUP |
| `exit {code}` | holder to daemon | The child exited |
| `exit_seen` | daemon to holder | The daemon has the exit code |

The version is in the handshake, never in the socket path, so a new daemon
finds an old holder. A holder with another version is refused, and the pane
is restored instead.

## Lifecycle

| Event | What happens |
|---|---|
| Pane created | `tomod` starts a holder and attaches. |
| `tomo daemon stop`, SIGTERM, an upgrade | `tomod` writes the scrollback to disk and detaches. The panes keep running. |
| `tomod` crashes | Nothing happens to the panes. |
| `tomod` starts | For each pane row, it attaches to the holder when the socket exists and the child is alive: the pane stays **live**, with the same pid. Otherwise it restores the pane as before. |
| Holder with no pane row | Ended at start, so no process lives on unseen. |
| Pane closed, archive, `tomo daemon stop --kill-panes` | `close`: the holder hangs up the child and exits when the child has exited. `--kill-panes` waits up to 2 s for the children. |
| Child exits while no daemon runs | The holder waits 60 s for a daemon to take the exit code, then exits. The next daemon restores the pane. |
| Reboot | Holders are gone. The panes are restored and resumed. |

Output that arrives while no daemon runs goes into the ring, so the next
daemon replays it. A `tomo hook` call while no daemon runs returns at once
and the event is lost; the agent's next event sets its state.

## Tests

- `pty.rs` unit tests run the same holder server in a thread: spawn, reattach
  with the same pid, input after a reattach, hangup, a closed holder ends at
  once, and an exit while nobody is attached.
- `scripts/torture/holders.sh` uses the real binaries: stop, restart, and
  `kill -9` of the daemon keep the same pid and a background child; closing a
  pane, an orphan, and `--kill-panes` leave no process.
- In the torture scripts, `daemon_restart` keeps the panes, and
  `daemon_restart_cold` ends them first, to test the restore path.
