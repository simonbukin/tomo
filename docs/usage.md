# Provider usage

Tomo shows how much of each provider's allowance is used. The data is per
provider, never per worktree. `tomo usage` prints it, the `snapshot` carries
it in `usage`, and the daemon sends `usage_changed` when it changes.

## The honesty rule

Tomo shows only data that a provider reports. It never reads the rendered
terminal text of an agent, and it never guesses a number. When a reliable
source is not available, the snapshot has `available: false` and a short
`reason`. The generic code renders buckets; it does not know a provider's
window names. Each adapter in `crates/tomod/src/usage.rs` maps its own
source to `UsageBucket { label, fraction_used, resets_at_ms, detail }`.

## Sources

### Claude

Claude Code stores an OAuth token in the macOS keychain (service
`Claude Code-credentials`) or in `~/.claude/.credentials.json`. The adapter
reads the token, then calls `GET https://api.anthropic.com/api/oauth/usage`
with `curl --max-time 8`. The token goes to `curl` on stdin (`-H @-`), so it
does not appear in the process list, and the daemon never logs it.

The response has a `limits` array. Each entry becomes one bucket:

| `kind`          | Label                              |
|-----------------|------------------------------------|
| `session`       | `5-hour`                           |
| `weekly_all`    | `weekly`                           |
| `weekly_scoped` | `weekly (<model display name>)`    |
| other           | the kind, with spaces              |

`fraction_used` is `percent / 100`, `resets_at_ms` comes from the RFC 3339
`resets_at`, and `detail` carries the `severity` when it is not `normal`.
When the response has no `limits` array, the adapter reads the top-level
windows `five_hour`, `seven_day`, and `seven_day_<scope>` instead, with the
same labels.

Reasons: `no Claude login` when no token is found; `usage request failed
(<status>)` for a non-200 answer; `usage request failed (no response)` when
`curl` times out.

### Codex

Codex CLI exposes its rate limits through the app-server JSON-RPC method
`account/rateLimits/read`. The adapter starts `codex app-server` on stdio,
sends `initialize`, `initialized`, and the read request, waits at most eight
seconds for the answer, then stops the process. There is no other local
source: `~/.codex/auth.json` holds only tokens, `codex doctor --json` reports
health but not limits, and the ChatGPT backend endpoint is not documented.

Each rate limit snapshot has a `primary` and a `secondary` window. The label
comes from `windowDurationMins`: 300 is `5-hour`, 10080 is `weekly`, other
values become `<n>-day`, `<n>-hour`, or `<n>-minute`. When the answer lists
more than one `limitId`, the label gets the limit name as a suffix.
`resets_at_ms` is `resetsAt` (seconds) times 1000.

Reasons: `no Codex login` when `~/.codex/auth.json` is absent; `codex is
not installed` when the binary is not on `PATH`; `codex app-server did not
answer` after the timeout; `codex app-server: <message>` for a JSON-RPC
error.

### Pi

Pi has no allowance. The snapshot is always `available: false` with reason
`Pi has no usage limits`.

## Mock source

Set `TOMO_USAGE_MOCK=<path>` on the daemon to read a JSON array of
`UsageSnapshot` from that file instead of any network or process. Use it for
UI work and tests:

```json
[
  { "provider": "claude", "available": true, "reason": null, "fetched_at_ms": 0,
    "buckets": [ { "label": "5-hour", "fraction_used": 0.48, "resets_at_ms": 1789429800000, "detail": null } ] },
  { "provider": "codex", "available": false, "reason": "no Codex login", "buckets": [], "fetched_at_ms": 0 }
]
```

A file that does not parse gives an empty list and a warning in the daemon
log.

## Polling cadence

A task in the daemon checks every 20 seconds. When at least one client is
subscribed and the newest snapshot is older than five minutes, it fetches
all providers again. Fetches run on a blocking thread, outside the daemon
lock. Without a subscriber, nothing polls.

`usage_get { refresh: true }` fetches at once. `usage_get { refresh: false }`
returns the last result, and fetches only when the daemon has no result yet.

The daemon sends `usage_changed` only when a provider's availability,
reason, or buckets differ from the last result. A new `fetched_at_ms` alone
does not count as a change.

## Threshold notices

When a bucket's `fraction_used` moves up across 80 % or 95 % between two
fetches, the daemon sends one `notice` with level `warning`:

```text
Claude weekly allowance 83%
```

The notice fires once per crossing. It does not repeat while the value stays
above the threshold. The first fetch after a daemon start compares against
zero, so a bucket that is already above a threshold gives one notice then.
