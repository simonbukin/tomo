# Diagnostics

Diagnostics show what Tomo itself does: daemon reconnects, config reloads,
usage adapter failures, hook runtime issues, integration health changes,
and runtime scanner errors. The scanner records `port scan: lsof failed:
<error>` when the call does not start, and `port scan: lsof did not answer
in 2 s` when Tomo kills a call that passes its deadline. A pane that keeps
its queued command line because the terminal stays busy records a `daemon`
warning; see [runtime.md](runtime.md) and the table in
[notifications.md](notifications.md). Work events (an agent waits, an Action crashes,
a worktree is archived) go to Activity, never to Diagnostics.

## Where to find them

- Rest the pointer on the health dot at the bottom right. The preview shows
  the daemon state, PID, uptime, protocol, and the pane and agent counts.
- Click the health dot. The popover shows:
  - the daemon connection
  - one line per agent integration (`integrations_status`)
  - the six newest system events
  - config issues (`config_check`), when there are some
  - failed hook runs (`hook_log`), when there are some
  - usage providers that have no data, with the reason
- Click `Open diagnostics` in the popover, or run `Diagnostics…` in the
  palette, for the dialog. It shows the same sections with up to 200 events.

The health dot uses a color and a text label: `Daemon healthy` (green),
`Daemon reconnecting` (amber), `Daemon disconnected` (red). The text is the
accessible name of the control.

## Data flow

- The daemon keeps the last 200 diagnostics in memory.
  `Daemon::diagnostic(inner, level, source, message)` records one and pushes
  the `diagnostic` event. `diagnostics_list { limit? }` returns them, newest
  first. The history does not survive a daemon restart.
- The client adds each `diagnostic` event and each client-side
  `recordDiagnostic` call to `store.diagnostics`.
- When the popover or the dialog opens, it calls `diagnostics_list`,
  `integrations_status`, `config_check`, and `hook_log`. It merges the daemon
  history with `store.diagnostics` (`mergeDiagnostics` in
  `app/src/shell/bottomModel.ts`): duplicates go, newest first.
- A failed call shows `unavailable` for its section. It never shows an empty
  section as if there were no issues.

A `source` is one word: `daemon`, `config`, `usage`, `hooks`, `runtime`,
`browser`, or `integrations`.

Known limit: there is no separate browser host health section. Browser host
events show in the system events when that subsystem records them.
