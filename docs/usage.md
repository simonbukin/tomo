# Provider usage

Tomo shows how much of each provider's allowance is used. The data is for
each provider, never for each worktree. `tomo usage` prints it, the
`subscribe` snapshot carries it in `usage`, and the daemon sends
`usage_changed` when it changes.

Usage is an addon (see [addons.md](addons.md)). If you remove it, the
bottom-strip meters, the Usage section of diagnostics, `tomo usage`,
`usage_get`, and `usage_changed` go away. Agents keep working.

## Where the code lives

| Part | Path |
|---|---|
| `UsageBucket`, `UsageSnapshot` | `crates/tomo-proto/src/addons/usage.rs` |
| `Call::UsageGet`, `Event::UsageChanged`, `Snapshot.usage` | `crates/tomo-proto/src/lib.rs` (composition root) |
| adapters, the last result, refresh, the poll, notices, diagnostics | `crates/tomod/src/addons/usage/mod.rs` |
| registration in the daemon | `addons::start` starts the poll; `dispatch.rs` answers `usage_get` and fills `Snapshot.usage` |
| CLI | `Cmd::Usage` in `crates/tomo-cli/src/main.rs`, `print::usage` |
| GUI | `app/src/addons/usage/`: `model.ts` (rows, tones, micro-bar), `state.ts` (the snapshots), `UsageStrip.tsx` (meters, popover, refresh, diagnostics section), `index.ts` (the slots) |
| harness | `scripts/torture/usage.sh`, with `TOMO_USAGE_MOCK` |

Core does not know windows, scopes, or allowances. The only shared key is
`AgentKind`: `UsageSnapshot.provider` is an `AgentKind`.

## The honesty rule

Tomo shows only data that a provider reports. It never reads the rendered
terminal text of an agent, and it never guesses a number. When a reliable
source is not available, the snapshot has `available: false` and a short
`reason`. The generic code renders buckets; it does not know a provider's
window names. Each adapter maps its own source to
`UsageBucket { label, fraction_used, resets_at_ms, detail, scope }`.

`scope` names the model that a bucket limits, for example `fable` or `sol`.
A bucket without `scope` counts for the whole plan. The JSON leaves out
`scope` when it is empty.

## Sources

The daemon reads Claude and Codex. Pi has no snapshot: Pi runs on Claude's
allowance, so the Claude snapshot shows its use. The GUI also drops a `pi`
snapshot if a mock file has one.

### Claude

Claude Code stores an OAuth token in the macOS keychain (service
`Claude Code-credentials`) or in `~/.claude/.credentials.json`. The adapter
reads the token, then calls `GET https://api.anthropic.com/api/oauth/usage`
with `curl --max-time 8`. The token goes to `curl` on stdin (`-H @-`), so it
does not appear in the process list, and the daemon never logs it.

The response has a `limits` array. Each entry becomes one bucket:

| `kind`          | Label                   | Scope                                                  |
|-----------------|-------------------------|--------------------------------------------------------|
| `session`       | `5-hour`                | none                                                   |
| `weekly_all`    | `weekly`                | none                                                   |
| `weekly_scoped` | `weekly`                | `scope.model.display_name` in lowercase, else `scoped` |
| other           | the kind, with spaces   | none                                                   |

`fraction_used` is `percent / 100`, `resets_at_ms` comes from the RFC 3339
`resets_at`, and `detail` carries the `severity` when it is not `normal`.

When the response has no `limits` array, the adapter reads the top-level
windows instead: `five_hour` is `5-hour`, `seven_day` is `weekly`, and
`seven_day_<scope>` is `weekly` with the scope `<scope>` (underscores become
spaces). `fraction_used` is `utilization / 100`. Other keys are ignored.

Reasons: `no Claude login` when no token is found; `usage request failed
(<status>)` for a non-200 answer; `usage request failed (no response)` when
`curl` times out; `usage response is not JSON`; `no usage windows in the
response`.

### Codex

Codex CLI exposes its rate limits through the app-server JSON-RPC method
`account/rateLimits/read`. The adapter starts `codex app-server` on stdio,
sends `initialize`, `initialized`, and the read request, waits at most eight
seconds for the answer, then stops the process. There is no other local
source: `~/.codex/auth.json` holds only tokens, `codex doctor --json` reports
health but not limits, and the ChatGPT backend endpoint is not documented.

Each rate limit snapshot has a `primary` and a `secondary` window. The label
comes from `windowDurationMins`: 300 is `5-hour`, 10080 is `weekly`, other
values become `<n>-day`, `<n>-hour`, or `<n>-minute`. When
`rateLimitsByLimitId` lists more than one limit, each limit other than
`codex` gets its `limitName` (or its id) in lowercase as the `scope`. The
label does not change. `resets_at_ms` is `resetsAt` (seconds) times 1000.

Reasons: `no Codex login` when `~/.codex/auth.json` is absent; `codex is
not installed` when the binary is not on `PATH`; `codex app-server did not
answer` after the timeout; `codex app-server: <message>` for a JSON-RPC
error.

## Mock source

Set `TOMO_USAGE_MOCK=<path>` on the daemon to read a JSON array of
`UsageSnapshot` from that file instead of any network or process. Use it for
UI work and tests. `scripts/torture/usage.sh` uses it.

```json
[
  { "provider": "claude", "available": true, "reason": null, "fetched_at_ms": 0,
    "buckets": [
      { "label": "5-hour", "fraction_used": 0.48, "resets_at_ms": 1789429800000, "detail": null },
      { "label": "weekly", "fraction_used": 0.66, "resets_at_ms": null, "detail": "warning", "scope": "fable" } ] },
  { "provider": "codex", "available": false, "reason": "no Codex login", "buckets": [], "fetched_at_ms": 0 }
]
```

A file that does not parse gives an empty list and a warning in the daemon
log. The daemon uses `fetched_at_ms` from the file, so a small value makes
the poll below fetch again after each tick.

## Polling cadence

The addon keeps the last result in memory, in its own module and not in the
Core state. The result is empty after a daemon start.

A task in the daemon checks every 20 seconds. When at least one client is
subscribed and the newest snapshot is older than five minutes, it fetches
all providers again. Fetches run on a blocking thread, outside the daemon
lock. Without a subscriber, nothing polls.

The reason for this background task: the bottom strip must show a current
allowance while a person can see it. A tick without a subscriber reads one
flag and does nothing else. A fetch starts `security`, `curl`, and
`codex app-server`, so it runs at most once in five minutes.

`usage_get { refresh: true }` fetches at once. `usage_get { refresh: false }`
returns the last result, and fetches only when the daemon has no result yet.
The GUI `refresh` link in the usage popover sends `refresh: true`.

The daemon sends `usage_changed` only when a provider's availability,
reason, or buckets differ from the last result. A new `fetched_at_ms` alone
does not count as a change.

## Threshold notices

When a bucket's `fraction_used` moves up across 80 % or 95 % between two
fetches, the daemon sends one `notice` with level `warning`. A scoped bucket
puts the model name before the label:

```text
Claude weekly allowance 83%
Claude fable weekly allowance 96%
```

The notice fires once per crossing. It does not repeat while the value stays
above the threshold. The first fetch after a daemon start compares against
zero, so a bucket that is already above a threshold gives one notice then.

The thresholds exist two times: `THRESHOLDS` in the daemon addon and
`USAGE_WARN` and `USAGE_DANGER` in `app/src/addons/usage/model.ts`, which
color the meters. Keep them equal.

## Diagnostics

When a provider becomes unavailable, the daemon records one diagnostic with
source `usage` and level `warning`: `<provider> usage: <reason>`, for example
`codex usage: no Codex login`. The same problem does not record again. When
the provider returns, the daemon records `<provider> usage: ok again` with
level `info`. The GUI diagnostics report lists each unavailable provider in
its Usage section, which the addon adds through the `diagnosticsSection` slot.

## Output

- The GUI shows one bottom-strip item for each plan and one for each scope.
  See [ui.md](ui.md), "Bottom strip".
- `tomo usage` prints one line for each bucket. The text form does not show
  `scope`; `tomo usage --json` prints the full list.
