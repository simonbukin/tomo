# Activity and checkpoints

Activity is history. Attention is urgency.

The activity stream is one chronological list of the events that matter to
a person: an agent started or asked for you, an Action started, stopped,
finished, or crashed, a port appeared, a worktree changed state, an archive,
a restore, a failed hook, a merged pull request, a checkpoint. Attention is
the short list of items that still need a person now. An activity event
may point at the attention item it opened or closed; that link is what
`--needs-me` uses.

## What is recorded

| Kind                  | When                                                        | Points at attention |
|-----------------------|-------------------------------------------------------------|---------------------|
| `agent_started`       | An agent is spawned, or an agent presence appears in a pane |                     |
| `agent_waiting`       | An agent waits for you; at most once per pane per 30 s      | the waiting item    |
| `agent_exited`        | An agent exited                                             |                     |
| `action_started`      | `tomo action run`, restart, or a GUI button                 |                     |
| `action_stopped`      | `tomo action stop`, restart, pane close, kill-tree, archive |                     |
| `action_completed`    | A pane-mode Action exited with code 0                       |                     |
| `action_crashed`      | A pane-mode Action exited with another code, unrequested    | the crash item      |
| `endpoint_discovered` | An owned process listens on a port; once per worktree and port per 60 s | |
| `state_changed`       | The worktree state changed; title `state → <x>`             |                     |
| `archived`            | A worktree was archived                                     |                     |
| `restored`            | A worktree was restored                                     |                     |
| `hook_failed`         | A hook exited non-zero, timed out, or did not start         |                     |
| `pr_merged`           | `tomo pr` saw the pull request state become merged          |                     |
| `checkpoint_created`  | `tomo checkpoint`                                           | the checkpoint item |
| `checkpoint_resolved` | `tomo checkpoint resolve`                                   | the same item       |

Every event has `id`, `kind`, `occurred_at_ms`, `worktree_id`, `pane_id`,
`agent_kind`, `title`, `detail`, `payload`, and `attention_id`. `payload`
is JSON; `action_crashed` carries `action_id`, `exit_code`, and `pane_id`
so a client can offer Logs and Restart.

## What is not recorded

Pane output, pane resize, pane focus, resource ticks, Git watcher ticks,
discovery, and process start or exit. These fire many times a minute and
would bury the events that matter. Read `tomo ps` and `tomo runtime` for
live state.

## Crash or stop

An Action pane that exits with a non-zero code is a crash unless Tomo
itself ended it. `tomo action stop`, `restart`, `pane close`, `tab close`,
`pane kill-tree`, and archive mark the pane with a stop intent first, so
their exit records `action_stopped` and raises nothing. A crash keeps the
pane open with its output, records `action_crashed`, fires the
`action.crashed` hook, and adds an attention item of kind `crash` with the
message `<label> exited with code <n>`.

## Needs me

```bash
tomo activity --needs-me
```

Lists only the events whose attention item is still open: `resolved_at_ms`
is null, and for a `waiting` item `viewed_at_ms` is also null. A checkpoint
or crash stays in the list until someone resolves it. A waiting agent
leaves the list when its pane is focused or the agent moves on.

## Retention

The daemon keeps the newest 10 000 events in the `activity` table and
deletes older ones on every insert. `Event::ActivityAdded` is emitted for
each new event, so a subscribed client never has to poll.

## Checkpoints

A checkpoint is an explicit request from an agent, a script, or a person
for human review or a decision.

```bash
tomo checkpoint "<message>" [--url U] [--title T] [--worktree W] [--pane P]
tomo checkpoint resolve <id>
```

The worktree and pane default from `TOMO_WORKTREE_ID` and `TOMO_PANE_ID`,
then from the current directory, so an agent inside a pane needs no
arguments. `--title` gives the attention item a short message and moves
the long message into the activity `detail`. `--url` is a link for the
client to open. The agent kind comes from the pane's agent presence.

`tomo checkpoint` adds an attention item of kind `checkpoint`, records
`checkpoint_created`, and fires `attention.created` and
`checkpoint.created`. `tomo checkpoint resolve` sets `resolved_at_ms`, emits
`attention_resolved`, records `checkpoint_resolved`, and fires
`checkpoint.resolved`. A crash item resolves the same way. A resolved item
leaves `tomo attention list`; its history stays in the activity stream.

## tomo activity

```bash
tomo activity [--limit N] [--needs-me] [--worktree W] [--json]
```

Newest first, 100 events by default. The text form prints
`HH:MM  title · detail` in local time. `--json` prints the `ActivityEvent`
list; `before_ms` in `ActivityQuery` pages further back.
