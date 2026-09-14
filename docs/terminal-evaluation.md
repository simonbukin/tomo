# Terminal evaluation

Date: 2026-09-14. Build: debug `tomod` and `tomo` from the Phase 2 tree.
Machine: Apple Silicon Mac, macOS 25.6, zsh login shell in panes.

This report answers PRD §33: does xterm.js stay, or is a `libghostty` spike
justified? The harnesses run without model tokens and without the GUI.

## What was exercised

`scripts/torture/run-all.sh` (deterministic, scratch daemon, ~3 minutes):

| Suite | Checks | Result |
|-------|--------|--------|
| `terminal.sh` | 20 MB burst, 200k-char line, truecolor + Japanese + emoji + combining, `less`, `vim -u NONE`, `top -l 1`, 50-step resize storm, 10 pane create/close cycles during an 8 MB flood, 0-byte replay, replay after the 1 MiB cap with an escape and a multibyte character cut by the cap, reattach after 3 MB detached output, daemon restart with 20 concurrent clients | 17 pass |
| `agents.sh` | fake agent: SessionStart→idle, working→idle, waiting + attention, heuristic vs fresh lifecycle, stale lifecycle ignored, heuristic after the stale threshold, two same-kind agents per pane, resume after daemon restart, exit | 14 pass |
| `provenance.sh` | owned 3-level tree, grandchildren, no duplicate pids, reparented (setsid) child never owned, memory hog attribution, worktree total, observed stranger, refused kill of observed pid, dead parent disappears | 10 pass, 2 known |
| `layout.sh` | split right/down ×4, swap, equalize (leaf-count fractions), rotate, no-op resize, removals, `max_panes_per_tab` policy | 15 pass |

`cargo test -p tomod`: 41 tests, including the authority battery (PRD §23),
provenance trees (PRD §24), split-sequence replay, scrollback tail, and a
400-step randomized layout torture with JSON round trips.

`scripts/soak/busy.sh 120`: 5 repos, 25 worktrees with states and tags,
10 panes, 6 fake agents working and waiting every 10 s, 3 dev-server-like
loops, one fake Playwright tree, a 200 MB hog, 5 MB of scrollback.

| Metric | min | max | last |
|--------|-----|-----|------|
| tomod RSS | 17 MB | 18 MB | 18 MB |
| `tomo ps` latency | 29 ms | 48 ms | 31 ms |
| `tomo worktree list` latency | 26 ms | 42 ms | 28 ms |
| events on a subscribed socket | 149 in 120 s | | |

RSS at 60 s vs end: 18368 KB → 18640 KB (+1.5 %, limit 30 %).

Not automated: anything that needs the WebView. Rendering, IME, mouse
reporting, clipboard, pane switching latency, and xterm.js parser behaviour
on the replayed bytes were not driven by a machine. The daemon side of every
one of those paths was.

## Failures observed

| Observation | Cause class | Fix complexity | Status |
|-------------|-------------|----------------|--------|
| A stranger process that `cd`s into a worktree after Tomo first saw it was never classified observed; one that left stayed observed | Tomo process poll read cwd once per process to keep the 2 s poll near 10 ms | Fixed: every cwd is re-read at most every 20 s and on every `tomo ps`; `provenance.sh` now fails if this regresses | Fixed |
| Memory hog RSS decays within seconds after allocation | macOS memory management (compression, paging), not Tomo; `ps` agrees with Tomo | None; harness samples the peak | Closed |
| Split ratios differ by 1 ulp after SQLite round trip | `serde_json` default float parsing | None visible; test compares with tolerance | Closed |
| `%` mark on a fresh zsh prompt after restore | zsh `PROMPT_SP` printed before the client reports its size | Fixed earlier by clearing `PROMPT_EOL_MARK` in pane env | Closed |
| Typed command echo shows doubled characters right after a prompt redraw | zsh line editor redraw during typeahead; the executed command is intact (`echo START…END` check) | Cosmetic | Open, cosmetic |

No failure was attributable to xterm.js, to the PTY layer, or to the replay
logic. The replay boundary cases (escape and multibyte character cut by the
cap, >1 MB detached output) left the shell fully usable.

## Recommendation

Keep xterm.js. Nothing in Phase 2 testing shows a repeated, material blocker
in the terminal core. The open items are Tomo-side (cwd cache) and cosmetic
(zsh redraw). Revisit only if a human dogfooding session records one of the
§34 triggers: visible rendering lag with many panes, broken IME/CJK input,
an escape sequence Tomo needs that xterm.js cannot support, or structural
problems with state replay. A `libghostty` spike is not justified now.
