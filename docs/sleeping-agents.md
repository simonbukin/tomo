# Sleeping agents

An agent that sits idle for a long time sleeps: Tomo ends its process and
the pane shows a snapshot of the terminal as it was. You can scroll the
snapshot, select, copy, and search it. A key press or a click wakes the
agent: Tomo resumes the same session in the same pane.

## Why

On 2026-09-29 this machine ran 8 idle Claude Code agents in Tomo panes at
300 to 375 MB each, with no child processes: about 2.6 GB for panes that
nobody used. A pane holder with its shell costs about 4 MB.

## What you see

| | Awake | Asleep |
|---|---|---|
| Pane | the live terminal | the snapshot: the same terminal, frozen, scrollable, read only |
| Mark | the agent's state | the sleep icon: gray after idle, green after done; tooltip "sleeping · idle 2h · a key wakes it" |
| Memory | about 330 MB | about 4 MB |
| A key press or click | goes to the agent | wakes the agent; the key itself is not sent |

The snapshot is the terminal output itself, replayed into a read-only
terminal: the colors, the layout, and the scrollback are exactly what you
last saw. It holds the last 2 MB of output (the holder ring). For older
history, the pane offers "open transcript", which reads the session file of
the agent (the Cmd-K search builds this reader).

While a pane wakes, a thin bar says "waking…" over the snapshot, and the live
terminal replaces the snapshot when the agent has drawn its first screen or
sent its first hook event.

## When an agent sleeps

All of these must be true for the whole idle period (default 60 minutes,
`sleep_after_minutes` in config, 0 turns sleeping off):

1. The agent's state is `idle`, or `done` (a done agent sleeps and keeps its
   done mark: you still see that it finished).
2. No subagent runs, and no attention item of the pane is open.
3. The agent process has no child process. A child is work that sleeping
   would kill: a background shell, a dev server, an MCP server. A provider
   can name child commands that are safe to end (`sleep_safe_children`).
4. Its process tree used no CPU above the fallback threshold.
5. Nobody typed into the pane, and the last input ended with Enter: a prompt
   that you typed and did not send must never be lost.
6. No client shows the pane on screen.
7. The session has a reference and its provider can resume.
8. The pane is not marked "keep awake" (a pane menu item, like a pin).

The idle period starts again at any change of these.

Why 60 minutes: an agent's prompt cache lives 5 minutes, or 1 hour when
extended. After an hour idle the cache is cold anyway, so a sleep and a
resume cost no extra tokens and no extra latency for the model.

## How an agent sleeps (daemon)

1. Check the rules again under the lock.
2. Save the snapshot: the pane's scrollback bytes and the terminal size, to
   `<data dir>/scrollback/<pane id>.snapshot`. Mark the pane `sleeping` in
   its row (with the session reference and the provider).
3. End the agent process only, not the pane's shell: SIGTERM to the agent
   pid, as an asked-for end (it is never `dead`, and no "exited" activity).
   The session file is complete: providers append each message as it
   happens.
4. If the process has not ended after 5 seconds, cancel the sleep: the pane
   stays awake and a diagnostic says why. Tomo never sends SIGKILL to sleep.

The pane's shell and its holder stay: the pane keeps its place, its tab, and
its cwd.

## How an agent wakes

1. A key or a click in the pane, "wake" in its menu, a Cmd-K result, or
   `tomo pane wake`.
2. The daemon types `clear` and the provider's resume line into the pane's
   shell (the same line a restore uses, with `resume_env`), and clears
   `sleeping`.
3. The GUI shows "waking…" until the first output or hook, then the live
   terminal.
4. Text that something sends to a sleeping pane (`tomo pane send`, a queued
   prompt) wakes it first and is delivered after the agent's first hook
   event.

## What sleeping loses, and what it keeps

Kept: the conversation (the provider's session file), the pane, its layout,
its cwd, the snapshot, and the done mark. The agent resumes with its
configured model.

Lost, and restored on wake only as far as the provider restores it:
permissions that you allowed "for this session", MCP server connections
(they reconnect on wake), and any other in-memory setting of the running
agent. The rules above make sure that no work is running when it sleeps.

## Restarts

A sleeping pane survives a daemon restart and a reboot as a sleeping pane:
the restore shows its snapshot and does not type a resume line, unlike an
awake agent pane that lost its process.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | You typed half a prompt and walked away | Rule 5: it never sleeps |
| 2 | The agent started a dev server or background shell | Rule 3: it never sleeps while that child lives |
| 3 | A background subagent runs after the turn ended | Rule 2 |
| 4 | The pane is on screen, but you are away | Rule 6: an on-screen pane stays awake. Off-screen panes of the same worktree may sleep |
| 5 | The agent ignores SIGTERM | The sleep is cancelled after 5 s; no SIGKILL |
| 6 | The session file is missing or unreadable on wake | The resume fails in the pane like a failed restore; the snapshot stays readable; the pane menu offers "start a new session" |
| 7 | The daemon restarts during a sleep or a wake | The `sleeping` flag and the snapshot are saved first, so the next daemon shows the snapshot; a wake that did not finish is typed again on the next wake |
| 8 | Two wake triggers at once | The first wins; the pane is `waking` until the first output |
| 9 | A key that woke the pane | It is not sent: it could land in the shell before the agent starts |
| 10 | The snapshot is larger than the ring | The snapshot holds the ring (2 MB); "open transcript" reads older history |
| 11 | Codex, Pi, other providers | The same flow through the provider table: its resume line and its safe children. A provider that cannot resume never sleeps |
| 12 | An agent with no hooks (the CPU fallback) | It never sleeps: its idle state is only estimated |
| 13 | The agent is `dead` or exited | Nothing to sleep; the pane shows its last output as today |
| 14 | Low memory pressure | Out of scope for now: sleep is by idle time only |

## Build order

1. Daemon: the eligibility rules as a pure function with tests, the idle
   clock, sleep and wake, the saved snapshot and flag, restore of a sleeping
   pane, `tomo pane sleep|wake`, and the config key.
2. GUI: the snapshot view (a read-only terminal fed with the saved bytes),
   the waking bar, the mark, the keep-awake menu item, wake on key or click.
3. The transcript view, after the Cmd-K search provides the session reader.

## Worktree mark

A worktree whose agents all sleep shows the sleep icon in its card, its
sidebar row, and its hover. The icon is green when one of the agents slept
after `done`, and gray in all other cases. An awake agent wins: when one agent
of the worktree is awake, the worktree shows the mark of that agent, as today.

## Decisions

1. The default is 60 minutes.
2. A pane on screen stays awake, also when the window has no focus.
3. A sleeping pane and a sleeping worktree show the sleep icon.

## As built

The code is in `crates/tomod/src/sleep.rs` (the rules, the idle clock,
sleep, and wake), `app/src/SleepView.tsx` (the snapshot view), and
`agentMark` in `app/src/glyphs.ts` (the icon). `scripts/torture/sleep.sh`
tests it with a 3 s period. The build differs from the design above in
these points:

- **The snapshot holds 1 MB, not 2 MB.** It is the daemon's scrollback of
  the pane (1 MB), which is what the pane showed. The holder ring stays
  2 MB.
- **On screen means attached.** A client shows a pane when it sent
  `pane_attach` and no `pane_detach`. The GUI attaches only the panes of
  the tab on screen, so no new call was necessary.
- **One more rule.** The agent process must run under the pane's shell.
  An agent that is the pane's own process never sleeps, because its end
  would end the pane.
- **Waking ends at the first hook event.** The shell echoes the typed
  line, so the first output cannot tell that the agent started. Hook
  events that fired before the old process ended do not count. A wake with
  no hook event in 30 s shows the live terminal and drops the queued input,
  which would land in the shell.
- **A wake names no model.** A Claude session file saves the model id
  without `[1m]`, so a `--model` flag from it would change a 1M-context
  session to the smaller context. Each agent resumes with its configured
  model. A `/model` change in the session is lost at a sleep.
- **`tomo pane sleep` skips three rules.** A sleep on request ignores the
  CPU, on-screen, and keep-awake rules, and the idle period. The rules that
  protect work stay.
- **The sleep bar shows while asleep too.** It says `asleep · a key or a
  click wakes the agent`, so a frozen pane does not look broken.
- **A sleep mark heals.** When a pane is marked asleep but an agent runs in
  it (a daemon crash between the mark and the signal), the next tick
  clears the mark.
- **Test period.** `TOMO_SLEEP_AFTER_MS` in the daemon environment
  overrides `sleep_after_minutes`. Only the torture scripts use it.

Not built yet: "open transcript" (build order step 3; the Cmd-K session
index keeps message text for search only and has no view), and the
"start a new session" menu item of edge case 6.
