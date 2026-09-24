# Edge Cases: Tomo v1

## Feature Overview
Tomo keeps Git worktrees, terminal panes, and coding agents visible and
recoverable through a local daemon. This catalog covers the daemon, the CLI,
and the GUI as one surface, because most failures cross all three.

## Edge Case Categories

### Input Validation
| # | Scenario | Input | Expected Behavior | Likelihood | Impact | Priority |
|---|----------|-------|-------------------|------------|--------|----------|
| 1 | Add a path that is not a Git repository | `tomo repo add /tmp` | Git error returned as `git` error code; GUI toast; nothing stored | Med | Low | Med |
| 2 | Create a worktree with an invalid branch name | branch `bad name` | Git rejects; error surfaces verbatim; no directory created | Med | Low | Med |
| 3 | Create a worktree at an existing path | path exists | Git rejects; no metadata written | Med | Low | Med |
| 4 | Metadata with whitespace, `#`, or a duplicate tag | name `"  "`, tags `"#lr ,lr"` | Name trimmed to unset; tags trimmed, `#` stripped, and duplicates removed | High | Low | Med |
| 5 | Old `[[states]]` table in config.toml | `[[states]]` present | Ignored; `tomo config check` gives a warning with the key `states` | Med | Low | Low |
| 6 | Empty notify message | `tomo notify ""` | Rejected as bad request | Low | Low | Low |
| 7 | Invalid base64 in `pane_send` | garbage | Bad request; nothing written to the PTY | Low | Low | Low |
| 8 | Pane resize to 0×0 | cols 0 | PTY resized to at least 2×2; stored size clamped | Low | Low | Low |
| 9 | File tree path with `..` | `rel_path=../..` | Rejected; symlinks inside the worktree are still followed (single-user machine) | Low | Low | Low |
| 10 | Malformed hook payload on stdin | not JSON | Ignored; exit 0 so the agent is not blocked | Med | Low | Low |
| 10c | Archive of a worktree on a detached HEAD or with merge conflicts | `tomo worktree archive` | Conflict error before any pane closes; `--discard` skips the check | Low | High | High |
| 10d | Archive with `--no-checkpoint` on a dirty tree | uncommitted changes | Conflict error; nothing changed | Med | Med | Med |

### Boundary Conditions
| # | Scenario | Boundary | Expected Behavior | Likelihood | Impact | Priority |
|---|----------|----------|-------------------|------------|--------|----------|
| 11 | Huge terminal output | 20 MB burst | Daemon keeps the last 1 MB; GUI stays responsive | High | Med | High |
| 12 | Zero repositories | empty store | Home and sidebar show an empty state with an add action | High | Low | Med |
| 13 | Last pane in the last tab closes | tabs = 0 | GUI reopens the worktree with a fresh shell instead of showing "Opening…" forever | High | Med | High |
| 14 | Many worktrees | 25+ | Discovery runs `git status` concurrently; sidebar scrolls | Med | Low | Low |
| 15 | Deep split nesting | 6+ splits | Panes shrink; agent spawns without a target go to a new tab once a tab holds 2 panes | Med | Low | Low |
| 16 | Scrollback replay after restart | 1 MB | Query sequences stripped so the client does not answer into the new shell | High | Med | High |
| 17 | Tab title emptied | rename to `""` | Rename ignored; old title kept | Low | Low | Low |

### Error States (network / system / permission)
| # | Scenario | Trigger | Expected Behavior | Likelihood | Impact | Priority |
|---|----------|---------|-------------------|------------|--------|----------|
| 18 | Stale socket after a daemon crash | SIGKILL | Next start removes the stale file and binds | Med | High | High |
| 19 | Two daemons start at once | GUI and CLI race | A lock file makes the loser exit; the winner keeps the socket | Med | High | High |
| 20 | Repository directory deleted | rm -rf repo | Repo marked missing; worktrees with open tabs stay listed as missing | Med | Med | Med |
| 21 | Editor not installed | `zed` missing | Falls back to macOS `open`; user sees a notice | High | Med | High |
| 22 | Config file has a TOML error | typo | Daemon starts with defaults and logs a warning instead of refusing to start | Med | High | High |
| 23 | Shell in config does not exist | `shell = "/nope"` | Pane creation fails with an error; no orphan pane row remains | Med | Med | Med |
| 24 | Agent resume target gone | transcript deleted | Agent exits non-zero; pane shows `exited`; shell stays usable | Med | Med | Med |
| 25 | Hook fires while daemon is down | daemon stopped | `tomo hook` exits 0 silently; state recovers from the next event | High | Low | Med |
| 26 | `tomo` binary moved | reinstall | Hooks fail silently until `tomo integrations install` runs again | Low | Med | Low |
| 27 | SQLite file unreadable | corrupt db | Daemon refuses to start; error names the file | Low | High | Med |

### Concurrency / Race Conditions
| # | Scenario | Trigger | Expected Behavior | Likelihood | Impact | Priority |
|---|----------|---------|-------------------|------------|--------|----------|
| 28 | Two GUI clients attached to one pane | second window | Both receive output; input interleaves; no corruption | Low | Low | Low |
| 29 | Watcher refresh and manual refresh overlap | `tomo worktree refresh` during a Git event | Last discovery wins; upserts are idempotent | Med | Low | Low |
| 30 | Pane closed while output arrives | close during `yes` | Output for a missing pane is dropped | High | Low | Low |
| 31 | Stale lifecycle event after a newer one | hook delay | Older `at_ms` cannot rewind the state | Med | Med | Med |
| 32 | Heuristic report while a hook source is fresh | CPU spike | Heuristic ignored until the hook source is silent for 15 min | High | Med | High |
| 33 | User types while a queued agent command is pending | fast typing | Both land in the shell; the queued line waits for 300 ms of quiet | Low | Low | Low |
| 34 | Daemon stops while the GUI sends | `tomo daemon stop` | Requests fail with `io`; GUI shows offline and reconnects when the daemon returns | Med | Med | Med |

## Error Messages
| Scenario | User-facing message | Tone/placement |
|----------|---------------------|----------------|
| Git failure | Git's own stderr, prefixed with the command | Toast, bottom right |
| Editor missing | "editor not found; opened with Finder" | Toast |
| Pane has processes | "Processes are still running in this pane…" | Confirm dialog |
| Daemon offline | "daemon offline" | Title bar, red |
| Config error | "config.toml: <parse error>; using defaults" | Daemon log and startup notice |

## Recovery Paths
| Scenario | How the user recovers | Data preserved? |
|----------|-----------------------|-----------------|
| Daemon crash | Reopen the GUI or run any `tomo` command; layout restores, shells are fresh, agents resume | Layout, metadata, scrollback on disk (if the crash left it) |
| Config error | Fix the file; run `tomo daemon stop` and reopen | Yes |
| Editor missing | Set `editor_command` in config or install Zed | Yes |
| Worktree deleted externally | Close its tabs; it disappears on the next discovery | Metadata stays until the row is unused |
| Agent cannot resume | Start the agent again in the pane | Native transcript stays with the agent |

## Test Scenarios
- [ ] Start two daemons within 50 ms; exactly one keeps the socket
- [ ] Put a syntax error in config.toml; daemon starts and logs the error
- [ ] Set `editor_command = ["nope"]`; "open in editor" falls back to Finder
- [ ] Close every pane of a worktree; a fresh shell appears
- [ ] Set `shell = "/nope"`; pane creation fails and `tomo pane list` shows no orphan
- [ ] Put `[[states]]` in config.toml; the daemon starts and `tomo config check` warns on `states`
- [ ] Archive a dirty worktree; the branch has a `tomo: archive checkpoint` commit with the untracked files
- [ ] Archive a worktree with a merge conflict; the archive is refused and every pane stays open
