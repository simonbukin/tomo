# Activity and checkpoints

Activity is history. Attention is urgency.

The activity stream is one chronological list of the events that matter to
a person: an agent started or asked for you, an Action started, stopped,
finished, or crashed, a port appeared, a worktree changed state, an archive,
a restore, a failed hook, a merged pull request, notes sent to an agent, a
checkpoint. Attention is the short list of items that still need a person
now. An activity event may point at the attention item it opened or closed;
that link is what `--needs-me` uses.

## What is recorded

| Kind                  | Owner      | When                                                        | Points at attention |
|-----------------------|------------|-------------------------------------------------------------|---------------------|
| `agent_started`       | core       | An agent is spawned, or an agent presence appears in a pane |                     |
| `agent_waiting`       | core       | An agent waits for you; at most once per pane per 30 s      | the waiting item    |
| `agent_exited`        | core       | An agent exited                                             |                     |
| `checkpoint_created`  | core       | `tomo checkpoint`                                           | the checkpoint item |
| `checkpoint_resolved` | core       | `tomo checkpoint resolve`                                   | the same item       |
| `state_changed`       | core       | The worktree state changed; title `state → <x>`             |                     |
| `archived`            | core       | A worktree was archived                                     |                     |
| `restored`            | core       | A worktree was restored                                     |                     |
| `hook_failed`         | core       | A hook exited non-zero, timed out, or did not start         |                     |
| `action_started`      | actions    | `tomo action run`, restart, or a GUI button                 |                     |
| `action_stopped`      | actions    | `tomo action stop`, restart, or `pane kill-tree`            |                     |
| `action_completed`    | actions    | A pane-mode Action exited with code 0                       |                     |
| `action_crashed`      | actions    | A pane-mode Action exited with another code, unrequested    | the crash item      |
| `endpoint_discovered` | runtime    | An owned process listens on a port; once per worktree and port per 60 s | |
| `pr_merged`           | github     | `tomo pr` saw the pull request state become merged          |                     |
| `annotations_sent`    | agentation | `annotations_send` pasted browser notes into a live agent pane |                  |

Every event has `id`, `kind`, `occurred_at_ms`, `worktree_id`, `pane_id`,
`agent_kind`, `title`, `detail`, `payload`, and `attention_id`. `payload`
is JSON. `action_crashed` carries `action_id`, `exit_code`, and `pane_id`,
so a client can offer Logs and Restart. `annotations_sent` carries the
`EvidenceBundle`, and its `detail` is the page URL.

## Kinds and owners

A kind is a string on the wire and in the `activity.kind` column
(`ActivityKind` in `crates/tomo-proto/src/activity.rs`).

- **Core kinds** are the enum `CoreActivity` in the same file.
- **Addon kinds** are one enum for each addon in
  `crates/tomo-proto/src/addons/<name>.rs`: `ActionActivity`,
  `RuntimeActivity`, `GitHubActivity`, `AgentationActivity`. Each enum
  implements `ActivityKinds`, so the daemon writes
  `activity::event(ActionActivity::Crashed, ...)` and the kind string comes
  from the serde name.
- A new addon kind uses the string `<addon>.<name>`. The seven addon kinds in
  the table above keep their older snake_case strings, because stored rows
  and installed CLIs decode them.
- The daemon keeps a kind string that it does not know. It reads back
  unchanged, for example a row of an addon that a build omits.

The GUI renders each row from a registry of kind views:

- `app/src/activityKinds.ts` has the views of the core kinds as a
  `Record<CoreActivity, ActivityKindView>`.
- `app/src/addons/<name>/activity.ts` has the views of one addon as a
  `Record` of its generated kind union. `app/src/addons/activity.ts` lists them.
- A view can give a status glyph, the actor when the event has no agent, a
  fallback "Open App" link, and row buttons.
- A kind without a view renders as a plain row: time, agent, worktree,
  title, detail, "Open App" when the payload has a `url`, and "Resolve" when
  the attention item needs me.

## What is not recorded

Pane output, pane resize, pane focus, resource ticks, Git watcher ticks,
discovery, and process start or exit. These fire many times a minute and
would bury the events that matter. Read `tomo ps` and `tomo runtime` for
live state.

## Crash or stop

An Action pane that exits with a non-zero code is a crash unless Tomo
itself ended it. `tomo action stop`, `restart`, and `pane kill-tree` mark
the pane with a stop intent first. The pane stays open, so its exit records
`action_stopped` and raises nothing. A crash keeps the pane open with its
output, records `action_crashed`, fires the `action.crashed` hook, and adds
an attention item of kind `crash` with the message
`<label> exited with code <n>`.

`pane close`, `tab close`, and archive also mark the stop intent, but they
remove the pane before its process exits. That exit records no activity and
runs no `action.exited` hook.

## Needs me

```bash
tomo activity --needs-me
```

Lists only the events whose attention item needs me. An attention item
needs me when both of these are true:

1. `resolved_at_ms` is null.
2. The item is not a `waiting` item, or it is a `waiting` item with
   `viewed_at_ms` null and an agent in its pane that is still `waiting`.

A checkpoint or crash stays in the list until someone resolves it, also
after a view. A waiting agent leaves the list when its pane is focused or
the agent moves on.

This is the one definition. The daemon applies it in `Store::activity_list`
(SQL; `ActivityList` passes the panes where an agent waits). The GUI applies
it in `needsMeItem` (`app/src/activityModel.ts`) for the "Needs me" filter,
the "Resolve" button, the rail count, the NOW signals, the checkpoint banner,
and `next_attention`. The Rust store test and the TypeScript test use the
same case table.

A `tomo notify` item is a `waiting` item without an agent, so it never needs
me. It has no activity event.

## Waiting items resolve themselves

A `waiting` item stays open only while its agent waits. When the agent
leaves `waiting` for any other state, the daemon resolves every open
`waiting` item of that pane. This applies to a hook, a report, the process
monitor, a process exit, and a pane close. The daemon sets `resolved_at_ms`,
sets `viewed_at_ms` if it is null, and emits `attention_resolved` for each
item. A daemon restart also resolves the `waiting` items of the agent panes
that it restores, because the old prompt is gone. Checkpoint and crash items
never resolve automatically.

Focusing a pane marks its unviewed items viewed and emits `attention_viewed`
for each one. `attention_view` emits `attention_viewed` only when the item
was not viewed before.

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
