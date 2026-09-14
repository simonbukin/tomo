# State and recovery

Tomo distinguishes three pane conditions. The GUI shows the word next to the
pane title, and `tomo pane list` prints it in the origin column.

| Condition    | Meaning                                                                                   |
|--------------|-------------------------------------------------------------------------------------------|
| **live**     | The process that the daemon started still runs in the same PTY.                           |
| **restored** | The daemon restarted. Tomo rebuilt the pane and started a fresh shell in the old cwd.     |
| **resumed**  | Like restored, and Tomo also relaunched the agent from its native session reference.      |

Tomo never presents a resumed pane as the original process. The agent has the
same conversation, not the same pid.

## What survives what

| Event                  | Live processes | Tabs and layout | Scrollback            | Agent conversation           |
|------------------------|----------------|-----------------|-----------------------|------------------------------|
| GUI closes or crashes  | yes            | yes             | yes, in daemon memory | yes, untouched               |
| Daemon stops or dies   | no             | yes             | last 1 MB, from disk  | resumed when a reference exists |
| Machine reboots        | no             | yes             | last 1 MB, from disk  | resumed when a reference exists |

### GUI close

The Tauri window is a client. Closing it drops one socket connection. The
daemon removes that client from its list and keeps every PTY, buffer, and
timer. When the window opens again, the bridge reconnects, the frontend sends
`subscribe`, receives a full snapshot, and each visible pane sends
`pane_attach`. The daemon answers with the stored scrollback, then streams new
output. A running agent notices nothing.

### Daemon restart

`tomod` owns the PTY master side. When it exits, the kernel hangs up every
pane shell. On a clean stop (`tomo daemon stop`, SIGTERM) the daemon first
writes each pane's scrollback to `<data dir>/scrollback/<pane id>.bin`.

On the next start, `Daemon::restore` reads tabs and panes from SQLite and for
each pane:

1. loads the saved scrollback, when present, and appends a dim separator line
   `[tomo] daemon restarted: output above is from the previous session`;
2. starts a login shell in the saved cwd, or in the home directory when the cwd
   no longer exists;
3. when the pane has an agent kind and a session reference, queues the resume
   command line and marks the pane **resumed**; otherwise marks it
   **restored**.

The queued line is typed into the shell 200 ms after the shell's first
output. This keeps the user's shell environment (PATH, rc files) and leaves a
shell behind when the agent exits.

Tabs whose panes all vanished are deleted. Layout trees that reference a
missing pane are pruned to the panes that exist.

Tomo does not relaunch arbitrary commands. Only the shell and, for the three
supported agents, the native resume command run without user action.

### Reboot

Same as a daemon restart. The GUI or the CLI starts `tomod` on first use.

## Scrollback replay

Each pane keeps the last 1 MB of raw output in daemon memory. On attach, the
daemon sends this buffer as the first `pane_output` frame. xterm.js parses it
like live output, so colors, the alternate screen, and cursor state come back.

Raw output can contain terminal queries: device attributes (`ESC[c`), cursor
position (`ESC[6n`), mode reports (`ESC[?…$p`), color queries
(`OSC 10;?`, `OSC 11;?`), and termcap requests (`DCS +q…`). A terminal answers
these by typing a reply. During replay the process that asked is gone, so the
reply would land in whatever now reads the PTY. `pty::strip_terminal_queries`
removes these sequences from the replayed buffer. Live output is never
modified.

After replay the frontend fits the terminal, which sends a resize. A
full-screen program then repaints itself.

## Agent session references

The daemon stores one `session_ref` per pane. It comes from the spawn command
or from a hook report, whichever arrives.

| Agent  | Reference                                | Set at spawn                       | Resume command                      |
|--------|------------------------------------------|------------------------------------|-------------------------------------|
| Claude | session UUID                             | yes, Tomo generates it (`--session-id`) | `claude --settings <hooks> --resume <id>` |
| Codex  | session UUID from the `SessionStart` hook | no                                 | `codex resume <id>`                 |
| Pi     | session file path, or the session id     | yes, Tomo generates the id (`--session-id`) | `pi -e <extension> --session <ref>` |

Claude and Pi are resumable from the first prompt because Tomo chooses the id
before launch. Codex becomes resumable once its `SessionStart` hook reports,
which needs the user-level hooks from `tomo integrations install`.

A reference is only a pointer. The transcript stays in the agent's own store.
If the agent cannot find the session, it says so in the pane and Tomo marks
the presence exited.

## Agent state after restart

A restored agent pane starts with state `unknown`. The first hook or
extension event sets the real state. If the agent process never appears, the
state stays `unknown` and the pane shows the shell.

## Attention items

Attention items live in SQLite and survive restarts. Focusing a pane marks its
unviewed items viewed. `tomo attention clear` removes all. The daemon prunes
viewed items beyond the newest 200 on start.

## What is not recovered

- Environment variables a user exported by hand in a pane.
- The alternate-screen state of a program that died with the daemon; only its
  last output is replayed.
- Processes that a pane started. They died with the PTY.
