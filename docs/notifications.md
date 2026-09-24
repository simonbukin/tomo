# Notifications

Tomo uses five concepts for messages. Each concept answers a different
question. Do not use one concept for the job of another.

| Concept | Question | Where it shows | Lifetime |
|---------|----------|----------------|----------|
| Status message | "Is it done?" | the bottom strip | about 2.5 s |
| Toast | "Must I look at this now?" | the toast dock, bottom right | 4 to 12 s, or until dismissed |
| Attention | "What still needs me?" | Home, the sidebar, the rail, Activity `Needs me` | until resolved |
| Activity | "What happened?" | the Activity view | persistent |
| Diagnostics | "What did Tomo itself do?" | the daemon health area | the last 200 entries |

A toast and a desktop notification are delivery channels. They are not
state. When you dismiss a toast, the attention item and the Activity event
stay.

## Client API

The store in `app/src/store.ts` has one function for each channel:

| Function | Use it for | Examples |
|----------|-----------|----------|
| `showStatus(text)` | a small, explicit operation that succeeded | `Copied path`, `Theme changed`, `Archived aogashima`, `Sent 3 notes to Claude`, `Hooks installed` |
| `toast({ level, title, detail?, actions?, key?, sticky? })` | a failure or an exceptional event | `Split failed`, `Sampler crashed`, `Config problem` |
| `failToast(title)` | a `catch` handler for a failed explicit operation | `rpc(...).catch(failToast("Kill failed"))` |
| `recordDiagnostic(level, source, message)` | Tomo internals on the client | a menu bar install failure, a browser host call failure, a reconnect |
| `dismissToastKey(key)` | remove a keyed toast when its cause is gone | the daemon comes back; an attention item is resolved |

Rules:

- Never use a status message for a failure, a warning, a checkpoint, or a
  crash.
- Do not show a toast for a success that the UI already shows.
- Do not put Tomo internals in Activity. Put them in Diagnostics.
- A toast title is short. The detail is one muted line. A toast has at most
  two actions.

## Routing

`route(kind, context, target)` in `app/src/notifyRoute.ts` is a pure
function. It gives the channels for one event. The context holds the window
focus, the `[notifications] desktop` setting, the current view, the active
worktree, and the focused pane. The user "looks at" an event when Tomo is
focused on its pane, or on its worktree when the event has no pane.

| Event | Tomo focused, looks at it | Tomo focused, elsewhere | Tomo not focused |
|-------|---------------------------|-------------------------|------------------|
| small success (copy, theme, reopen, send) | status | status | status |
| Action started, Action completed normally | nothing | nothing | nothing |
| Action crashed | nothing | toast | toast + desktop |
| agent waiting | nothing (marked seen) | nothing | desktop |
| human checkpoint | chime | chime + toast | chime + toast + desktop |
| config warning, failure | toast | toast | toast |
| daemon reconnected quickly | nothing | nothing | nothing |
| daemon disconnected for longer than the grace period | toast | toast | toast |

"Nothing" means that only state changes. The sidebar, the rail, the tab
dots, Home, and Activity always render attention from state. Desktop
notifications need `[notifications] desktop` (on by default). The chime
plays only when `[notifications] sounds` is on.

`attentionDelivery` applies the table to an `attention_added` item and
builds the toast:

- A crash toast is an error: `Sampler crashed`, `exit code 1 · aogashima`,
  with `Logs` (focus the pane) and `Restart` (restart the Action).
- A checkpoint toast is a warning: `Review requested`, the message and the
  worktree, with `Open` and `Resolve`.
- The toast key is `attention:<id>`. When the item is resolved or all
  attention is cleared, the toast goes away.

## Status message

`StatusSlot` in `app/src/shell/StatusSlot.tsx` shows the newest message
with a leading `✓` for 2.5 s. A new message replaces the old one. There is
no stack. The message fades in and out in 100 to 140 ms, and not at all
when the system asks for reduced motion. The slot is one polite live region
that stays mounted, so a screen reader reads each message once.

## Toast dock

`ToastDock` in `app/src/shell/ToastDock.tsx` sits 12 px from the right and
12 px above the bottom strip. It shows at most three toasts. The newest toast
is nearest the bottom. When a fourth toast arrives, the oldest one goes.

| Level | Glyph | Lifetime |
|-------|-------|----------|
| info | `○` | 4 s |
| warning | `◉` | 7 s |
| error | `×` | 12 s |

- The timer stops while the pointer is on the toast or the focus is in it.
- A `sticky` toast stays until the user or its owner dismisses it.
- A toast with the same `key` replaces the older one.
- The actions and the dismiss button are normal buttons, so Tab reaches
  them. Escape dismisses the toast that has the focus. An action also
  dismisses its toast.
- The dock is a polite live region named `Notifications`.
- Styles are in `app/src/styles/toast.css`: dense, small radius, a colored
  left edge for warning and error, a 6 px rise and fade on entry, no springs.

## Daemon health

`stepHealth` in `app/src/shell/daemonHealth.ts` is a pure state machine.
`useDaemonHealth` runs it from the connection state and writes
`daemonHealth`.

| From | Event | To | Effects |
|------|-------|----|---------|
| healthy | connection lost | reconnecting | none |
| reconnecting | connection back | healthy | diagnostic `reconnected after 1.2 s` |
| reconnecting | grace period (4 s) ends | disconnected | diagnostic `daemon disconnected`, sticky error toast `Daemon disconnected` |
| disconnected | connection back | healthy | diagnostic `reconnected after …`, dismiss the toast |

At start, the state is `reconnecting`. If the daemon is not there after the
grace period, the diagnostic is `daemon not reachable`.

## Daemon diagnostics

`Daemon::diagnostic(inner, level, source, message)` keeps the last 200
entries and pushes the `diagnostic` event. `diagnostics_list { limit? }`
returns them, newest first. `Daemon::diagnostic_on_change(inner, source,
subject, problem)` records an entry only when a problem appears, changes,
or clears (`<subject>: ok again`). Polls use it, so a problem that stays the
same records once.

| Source | Entry | Level | Also a toast |
|--------|-------|-------|--------------|
| `config` | `config reloaded` when config.toml changes | info | no |
| `config` | `config: <first issue> (+N more)` when the issues change | warning | a `notice` when the new issues include an error |
| `config` | `<path>/.tomo.toml: <error>` | warning | a `notice` |
| `usage` | `<provider> usage: <reason>` when a provider becomes unavailable | warning | no |
| `hooks` | `<event> hook failed: <command>` | warning | no; Activity keeps `hook failed` |
| `runtime` | `port scan: lsof failed: <error>` | warning | no |
| `runtime` | `port scan: lsof did not answer in 2 s`, when the call passes its deadline | warning | no |
| `integrations` | `<agent>: <reason>` for a partial integration | warning | no |
| `daemon` | `pane <id>: the terminal did not go quiet, so Tomo did not type <line>` | warning | no |
| `daemon` | reconnect and disconnect, from the client | info, error | see Daemon health |
| `browser` | a failed browser host call, from the client | error | only when the user started the call |
| `app` | a menu bar install failure, from the client | error | no |

The daemon keeps the `notice` event for events that deserve a toast: a new
config error, a malformed `.tomo.toml`, an editor fallback, and a usage
threshold crossing. Archive success is not a notice: the client shows
`Archived <name>` as a status message, and Activity records it.

## Tests

- `app/src/notifyRoute.test.ts`: every row of the routing table, and
  scenarios D, E, and F.
- `app/src/shell/daemonHealth.test.ts`: scenario G.
- `app/src/notify.test.ts`: scenario C (copy shows a status and no toast)
  and scenario D (a dismissed crash toast leaves the attention item).
- `problem_change` in `crates/tomod/src/daemon.rs` and `issues_summary` in
  `crates/tomod/src/settings.rs`.
- `scripts/torture/diagnostics.sh`: a broken config.toml records one
  warning, a fixed file records `config reloaded`, a new config error
  pushes a notice, and none of it goes to Activity.
