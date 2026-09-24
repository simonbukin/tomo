# GitHub

The GitHub addon shows the pull request of the branch in a worktree. It
reads the pull request with the GitHub CLI (`gh`). Tomo does not manage
pull requests. Log in with `gh auth login` first.

## What it shows

| Place | What |
|---|---|
| Right inspector, section `pull request` | number, title (a click opens the URL), state, draft, review decision, check counts, and the merge state when it is not `mergeable`. `refresh` asks again. |
| Right rail, `Pull request` button | `×` for failed checks, else `✓` for a merged pull request |
| NOW signals (Home, sidebar, left rail preview) | `merged`, else `checks failed`, after the core signals. A card shows three signals at most. |
| Repo avatar (sidebar, Home) | the image of the owner, for an `origin` remote on `github.com` |
| Worktree tags | one reserved tag that shows the pull request; see "Tags" below |
| Activity | one `pr_merged` event when an answer shows a merged pull request and the cached answer did not |
| Town history | the `pr` field: the cached pull request, else the newest `pr_merged` event |
| CLI | `tomo pr [worktree] [--json]` (see [cli.md](../cli.md#pr)) |

## Calls and events

```json
{ "method": "pr_status", "params": { "worktree_id": "…" } }
```

The result is `PrStatusResult { available, reason, pr }`:

- `gh` is not on `PATH`: `available: false`, reason `gh is not installed`.
- `gh` fails: `available: false`, the reason is the first line of its error output.
- The branch has no pull request: `available: true`, `pr: null`.

The daemon emits `pr_changed { worktree_id, pr }` when the new pull request
is not equal to the cached one. A new fetch of an open pull request always
differs, because `fetched_at_ms` changes. The first answer for a worktree
after a daemon start always emits the event.

## Tags

The addon owns six reserved tags: `draft`, `review`, `changes-requested`,
`approved`, `merged`, and `closed`. When a new `gh` answer has a pull
request, the addon sets one reserved tag on the worktree and removes the
other five. Other tags stay. The rules, in this order:

1. A merged pull request gets `merged`. A closed pull request gets `closed`.
2. A draft gets `draft`.
3. The review decision gives `changes-requested` or `approved`.
4. All other pull requests get `review`.

An answer without a pull request changes no tags. An answer from the cache
changes no tags. A tag change goes through the same path as
`tomo worktree metadata set`, so it fires `worktree.tags_changed` and
records `tags_changed`; see [../hooks.md](../hooks.md). If you remove a
reserved tag by hand, the next answer puts it back.

## Background work

The daemon has no poller, no timer, and no watcher for GitHub. `gh pr view`
runs only inside a `pr_status` call. The call uses the cache instead when
the cache has a pull request that is less than 60 s old. An answer without a
pull request is not cached, so the next call runs `gh` again.

| Caller | When it calls `pr_status` |
|---|---|
| The inspector section | when it mounts, when the worktree or its branch changes, every 120 s while it stays mounted, and on `refresh` |
| `tomo pr` | once, when the user runs it |

The inspector section mounts only while the right inspector is open on a
worktree whose directory exists. The rail marker, the NOW signals, and the
town history read cached data only. They start no work. So Home shows a
pull request signal only for a worktree whose pull request the session
already knows. The repo avatar loads its image from `github.com` in the
webview when a repo row renders.

Milestone 2 kept these triggers. It added no work.

## State

The cache is in memory in the per-daemon addon state: `addons::State.github`
(type `github::Cache` in `crates/tomod/src/addons/github/mod.rs`), one answer
for each worktree id. A
daemon restart empties it. The addon owns no table. The `activity` table
keeps the `pr_merged` rows.

Known limits, unchanged by the extraction:

- An archive, a move, or a restore does not clear or move the cache entry.
- After a restart, the next merged answer records `pr_merged` again.
  `scripts/torture/github.sh` reports this as a known limitation.

## Code boundary

GitHub is an addon. Core does not import it. See [../addons.md](../addons.md).

```text
crates/tomo-proto/src/addons/github.rs   PullRequest, PrStatusResult, GitHubActivity
crates/tomod/src/addons/github/mod.rs    gh pr view, the cache, pr_status, known_pr
crates/tomod/src/addons/github/model.rs  parse, answer, freshness, change and merge rules, known_pr
app/src/addons/github/index.ts           the Addon value: inspector section, signals, repo avatar, frame reducer
app/src/addons/github/                   PrSection.tsx, Avatar.tsx, model.ts, state.ts, activity.ts, github.test.tsx
```

GitHub joins Core and the other addons at these points only:

- `dispatch.rs`: the `pr_status` arm, `is_slow`, and `town_pr`, which gives
  Towns the pull request through `github::known_pr`.
- The GUI slots `inspectorSections`, `worktreeSignals`, `repoAvatar`, and
  `onFrame`.
- The `prs` key on the client `State`, which `state.ts` declares through
  module augmentation.
- Registration lines: `Call::PrStatus` and `Event::PrChanged` in
  `tomo-proto`, the `builtins` entry, the entry in
  `app/src/addons/activity.ts`, the `tomo pr` CLI block, and `github` in
  `scripts/torture/run-all.sh`.

The `.pr-*` and `.check-*` classes stay in `styles/base.css` and
`styles/layout.css`, because they share rules with the core status classes.

## Tests

- `crates/tomod/src/addons/github/model.rs`: the parse, every `gh` outcome,
  freshness, the change and merge rules, the merge event, and `known_pr`.
- `app/src/addons/github/github.test.tsx`: the section and its 120 s poll,
  the rail marker, the NOW signal, the repo avatar, and the owner parse.
- `scripts/torture/github.sh`: a fake `gh` answers from files. The script
  checks the parse, the cache, `pr_changed`, `pr_merged`, the town history,
  `tomo pr`, and the `Repo` shape. It stops if the daemon does not run the
  fake.
