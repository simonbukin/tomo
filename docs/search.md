# Search

Cmd+K opens the palette. An empty query shows the palette list of
[keyboard.md](keyboard.md). A typed query searches everything and shows
the hits in groups. The store answers the names at once. The daemon
answers the content, and its hits stream in while you type.

## Sources

| Group | Source | Where it comes from | Enter does |
|-------|--------|---------------------|------------|
| Commands | tabs, panes, live agents, addon context items, every registry command | the store | runs it |
| Worktrees | worktrees by name, repo, branch, or tag; repos | the store | opens the list of worktree actions (Cmd+Enter opens the worktree) |
| Pull requests | addon items through the `searchSources` slot | the store | opens the worktree |
| Files | `git ls-files --cached --others --exclude-standard` of every live worktree | daemon | opens the file in an editor pane, at the line of `path:12` |
| Sessions | Claude and Codex sessions rooted at a live worktree: the title, then the message text | daemon | focuses the pane of a live session, else resumes the session in a new tab |
| Terminal | the scrollback of every terminal pane (1 MB each) | daemon | focuses the pane, and selects the newest match with the xterm search addon |
| Activity | the newest 2000 activity rows: title and detail | daemon | focuses the pane, else opens the worktree, else opens Activity |

A live worktree exists on disk and is not archived. A session belongs to a
worktree when the agent started in the worktree root. A session that
started in a subfolder is not found, as in the sessions section of the
inspector.

Session text is message text only: the prompts of the user and the text
replies of the agent. Tool calls, tool output, thinking, and
`<command>`-style lines are not in the index. `transcript_text` in each
provider module (`providers/claude.rs`, `providers/codex.rs`) decides what
a line holds. Codex writes each message twice; only the `event_msg` copy is
read.

## Prefixes

The first character narrows the search. The palette footer shows this
list while the query is empty.

| Prefix | Scope | Limit |
|--------|-------|-------|
| none | everything | 5 local and 8 daemon hits in each group |
| `>` | commands | 50 |
| `/` | files | 50 |
| `#` | tags; Enter lists the worktrees with the tag | all |
| `@` | sessions | 50 |
| `$` | terminal scrollback | 50 |

A group with more hits than it shows ends with a `+N more in files` row.
Enter on that row types the prefix of the group before the query.

## Keys

Up and Down move over every row of every group. Tab moves to the first row
of the next group. Shift+Tab moves to the first row of the group, or of the
group before it. The selection stays on the same hit when later hits
arrive. See [keyboard.md](keyboard.md).

## Ranking

The palette has one ranking model. `matchText` in
`app/src/paletteModel.ts` and `grade` in
`crates/tomod/src/features/search.rs` give the same grade: exact, then
prefix or word prefix, then substring, then fuzzy with fewer gaps first.
`app/src/matchCases.json` holds cases that the Rust test and the vitest
test both check.

- Local groups: `rankEntries`, as in [keyboard.md](keyboard.md). The group
  with the best match comes first.
- Files: grade, then the worktree on screen, then the shorter path.
- Sessions: title matches by grade, then content matches, newest first. A
  session shows once, with the snippet of its newest matching message.
- Terminal: panes with the newest output first, then the newest lines
  first. The same line text shows once per pane.
- Activity: grade of the title; a detail match counts as fuzzy.

Daemon groups come after the local groups, in a fixed order: Files,
Sessions, Terminal, Activity. A late answer never moves the rows above it.

Content matches (terminal and session text) are plain substrings, case
insensitive for ASCII letters only.

`nucleo-matcher` was measured against this model on 93,444 paths. It was
not faster (1.8 to 12.4 ms, the tier matcher 1.3 to 6 ms) and it would
make a second model beside the TypeScript one. Tomo does not use it.

## Protocol

```json
{"id": 9, "method": "search", "params": {"query_id": 4, "query": "login", "sources": ["file", "session"], "limit": 8, "worktree_id": "a1b2c3d4e5f6"}}
{"id": 9, "result": null}
{"seq": 0, "event": "search_results", "data": {"query_id": 4, "source": "session", "hits": [...], "total": 3, "done": false}}
```

- `search` returns at once. Each source runs in its own task and sends
  `search_results` frames only to the connection that searched.
- Each frame holds all hits of its source so far. `done` marks the last
  frame of the source. `total` counts every match, also the ones past
  `limit`.
- A hit has `key`, `label`, `snippet`, `worktree_id`, `at_ms`, and a
  `target`: `file`, `pane`, `session`, or `activity`.
- A new `search` on a connection cancels the one before it. The sources
  check at each pane and each session file, and send nothing after that.
- An empty query only cancels, and loads the caches in the background. The
  palette sends one when it opens and when it closes.
- The GUI waits 60 ms after the last key before it sends a query.
- Terminal and session text need 3 characters. A shorter terminal query
  sends an empty `done` frame. Session titles match from 1 character.

## Caches

| Cache | Key | Invalidation |
|-------|-----|--------------|
| File list | worktree id | a Git change from the watcher, or 30 s. The old list answers once while the new list loads. |
| Session list | worktree id | 30 s, the same way |
| Session text | session file path | the file length: a refresh reads only the lines after the last complete line. A shorter file is read again. |

Nothing is cached for the terminal. Each scan copies the scrollback and
removes the escape sequences again, in four threads.

The caches live in `Daemon.search`, which has its own locks. A scan never
holds the Core lock; the terminal source takes it only to copy the
scrollback.

## Performance

Measured on 2026-09-29 on an Apple Silicon Mac, release build.

In process (`cargo test --release -p tomod measure_search -- --ignored
--nocapture`):

| Work | Time |
|------|------|
| Read 22 Claude transcripts, 234 MB, into the index (page cache warm) | 101 ms, once |
| Refresh the index with no change | 0.1 ms |
| Session text scan, `pty` (3 characters, 14 sessions) | 0.2 ms |
| Session text scan, `scrollback` (10 characters, 3 sessions) | 0.4 ms |
| Rank 93,444 paths in 12 worktrees, 1 to 10 characters | 1.3 to 6 ms |
| Scan 20 panes of 1 MB | 2 to 3 ms with 20 threads; 6 to 7 ms with 4 |

End to end over a scratch daemon, 19 repositories linked to the 19 real
Claude project folders (read only), and 20 panes of 1 MB each. Times are
from the request to the first and the last frame of a source:

| Query | Activity | Files | Sessions | Terminal |
|-------|----------|-------|----------|----------|
| `pty`, first search after start | 0.3 ms | 33 ms (loads 19 file lists) | 11 ms, done at 85 ms (builds the index) | 9.5 ms |
| `pty`, warm | 0.2 ms | 0.3 ms | 0.3 to 1.0 ms | 7 ms |
| `scrollback`, warm | 0.2 ms | 0.6 ms | 0.2 to 0.9 ms | 6 ms |

The palette open sends the empty query, so the first real query usually
finds warm caches.

Memory: the session index holds 2,452 messages in 2.8 MB (the text and a
lowercase copy). 93,444 file paths hold 6.6 MB. The daemon resident size
grew by about 30 MB after the first session search and about 23 MB after
the first terminal scan; most of that is freed buffers that the allocator
keeps.

## Limits

- ASCII case folding only for content. `Über` does not find `über` in a
  transcript.
- A file created in a subfolder without a Git change shows after 30 s at
  the latest.
- A session index entry stays until the daemon stops, also for an archived
  worktree.
- Pi keeps no session store that Tomo reads, so Pi sessions are not found.
- Pull requests show only for worktrees whose inspector asked for their
  pull request (`pr_status`).
- The terminal find selects the match in a pane that is on screen. A pane
  in a tab that is not mounted mounts first; the find tries for about 1.5 s.
- A terminal hit scrolls to the newest match of the query, which can be a
  newer line than the hit when the same text repeats.
- The CLI has no `tomo search` yet. `scripts/torture/tomo_rpc.py search`
  calls the daemon directly.
