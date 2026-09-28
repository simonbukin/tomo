# Agent states

What the live mark of an agent, a subagent, and a worktree means, which
events change it, and how the marks of the parts of a worktree combine. One
vocabulary is used on every surface: the sidebar row, the Home card and row,
the rail, tabs, and the hover card.

## The marks

The mark is always a square. Motion and fill tell the states apart, then
color, so a state reads at a glance and without color.

| State | Mark | Meaning |
|---|---|---|
| working | green square that turns 90° and rests at 45° (a rhombus), again and again | A turn is in progress, or a subagent of this agent runs |
| done | green square, head on, still | The turn finished and nobody has looked at the pane since |
| needs you | amber square, still | The agent waits for an answer or a permission |
| idle | hollow gray square | The agent is alive, has no turn, and was seen |
| dead | red square | The agent process ended by itself with a failure: a crash, a non-zero exit, a signal that nobody in Tomo sent, or a `StopFailure` |
| no signal | dotted gray square | Tomo sees the agent process but has no hook events from it |

When `working` ends in `done`, the rhombus turns 45° back to a square as it
turns green: the motion itself shows that the work finished.
`prefers-reduced-motion` keeps the rhombus still.

## One agent

The state comes from the agent's lifecycle hooks. A provider maps its hook
events onto these events in `hook_outcome` (see `crates/tomod/src/providers`).

```
starting ──SessionStart──▶ idle
idle / done / needs ──prompt, tool use, subagent start──▶ working
working ──permission or question──▶ needs you ──answer, tool use──▶ working
working ──Stop──▶ done ──the pane is seen──▶ idle
working ──Stop with a subagent that still runs──▶ working (until the last subagent stops)
any ──StopFailure──▶ dead
any ──SessionEnd, or exit 0──▶ gone (no mark)
any ──exit ≠ 0 or a signal, with no stop intent──▶ dead
any ──exit after a Tomo stop (close, kill tree, archive)──▶ gone
```

Rules:

1. **Hooks decide.** An event from a hook always wins. No other source may
   change a state that a hook set, however old it is: an idle agent is quiet
   for hours, correctly.
2. **The CPU fallback.** Only an agent that has sent no hook event in this
   process gets a state from its CPU use: working after two busy samples in a
   row, idle after 10 s below the threshold. The first hook event ends the
   fallback for the life of the process. The mark shows `no signal` until
   the fallback has a state, and its tooltip says that the state is estimated.
3. **Seen.** `done` becomes `idle` when the pane has focus in a focused,
   visible window. A turn that ends while you look shows `done` for 1.5 s,
   then `idle`, so the change is still visible. `dead` stays until the pane closes or starts again; once seen, it
   ranks below `working` and `done` in the worktree mark.
4. **A daemon restart keeps the state.** The daemon saves the state and the
   subagents of each agent pane when they change. A pane that its holder kept
   alive comes back with the saved state. A pane that was restored and
   resumed starts again at `starting`.
5. **Order.** Each hook carries the time it fired (`at_ms`). A hook event older
   than the state it would replace is ignored, so two hook processes that land
   in reverse order cannot undo a `Stop`.
6. **No hook is lost.** When `tomo hook` cannot reach the daemon, it appends
   the event to `<data dir>/hook-spool.jsonl` (1 MB at most). The daemon
   replays the spool in time order when it starts, through rule 5, and skips
   entries older than 24 hours. So a `Stop` that fires during a restart still
   ends the turn.
7. **An interrupt ends a turn.** Claude sends no `Stop` when you interrupt a
   turn or deny a permission. Its `idle_prompt` notification, about a minute
   later, turns `working` or `needs you` into `idle`. A provider without such
   an event can stay `working` until its next event; see its row in the
   provider table.
8. **Exit codes.** Exit 0, exit 130, SIGINT, SIGHUP and SIGTERM are an end you
   asked for: the agent is gone. Another non-zero exit or another signal, with
   no stop intent, is `dead`.

## Subagents

A subagent is `working` from its start to its stop. Its own marks use the
same squares at a smaller size: working, done (green, still), needs you, and
dead.

- `SubagentStart` adds it, `SubagentStop` marks it done.
- A finished turn of the parent keeps a subagent that still runs (a
  background subagent) and drops the finished ones.
- A parent that exits or dies drops all its subagents.
- A subagent with no event for 30 minutes while its parent is idle is
  dropped: a lost stop event must not keep a worktree working for ever.
- Above the cap of 16, a finished subagent drops before a running one.

## A worktree

The worktree mark comes from its **agents only**. Shells, Actions (a dev
server, a storybook), editor and browser panes do not change it.

Priority, first match wins:

1. needs you: an agent needs you.
2. dead, not seen: an agent died and nobody looked.
3. working: an agent works, or a subagent runs.
4. done: an agent finished a turn that nobody looked at.
5. dead, seen.
6. idle.
7. no signal: every agent has no signal.
8. no mark: no agent.

A crash of a non-agent pane, for example an Action, is a signal on the row
("storybook exited 1") and a mark on its own Action button, never the worktree
mark. A process that Tomo stopped on purpose is never a crash.
