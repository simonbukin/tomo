# GitHub

The GitHub addon shows the pull requests of a worktree: the one of the branch
that the worktree has now, and the ones of the branches that it had in the
last 30 days. It reads them with the GitHub CLI (`gh`). Tomo does not manage
pull requests. Log in with `gh auth login` first.

The earlier branches come from the reflog of the worktree's HEAD
(`crates/tomod/src/trail.rs`). Each worktree has its own reflog, so one
worktree that worked on three tickets shows three pull requests, and its
neighbor shows none of them. A branch counts as touched when the worktree
checked it out, left it, or made a commit on it.

## What it shows

| Place | What |
|---|---|
| Right inspector, section `pull request` | number, title (a click opens the URL), state, draft, review decision, check counts, and the merge state when it is not `mergeable`. `refresh` asks again. |
| Right rail, `Pull request` button | `×` for failed checks, else `✓` for a merged pull request |
| Name line link (sidebar row, Home) | the pull request icon and `#412`. The icon is green when open, gray as a draft, purple when merged, red when closed or when a check fails. The hover card adds the title, the state, the checks, and the review. |
| Repo avatar (sidebar, Home) | the image of the owner, for an `origin` remote on `github.com` |
| Hook | `github.pr_merged`, with the same rule as the activity event; see [../hooks.md](../hooks.md) |
| Activity | one `pr_merged` event when an answer shows a merged pull request and the cached answer did not |
| Town history | the `pr` field: the cached pull request, else the newest `pr_merged` event |
| CLI | `tomo pr [worktree] [--json]` (see [cli.md](../cli.md#pr)) |

## Calls and events

```json
{ "method": "pr_status", "params": { "worktree_id": "…" } }
```

The result is `PrStatusResult { available, reason, pr, prs }`:

- `gh` is not on `PATH`: `available: false`, reason `gh is not installed`.
- `gh` fails: `available: false`, the reason is the first line of its error output.
- The branch has no pull request: `available: true`, `pr: null`.
- `prs` holds every pull request that the call found, `pr` among them, each
  with its `head`, `updated_at_ms`, and `touched_ms` (the last time that this
  worktree touched the head). The newest by `touched_ms` or `updated_at_ms`
  comes first.

The call runs `gh pr view` for the branch now, read from the HEAD file of the
worktree, and then `gh pr list --head <branch> --state all --limit 5` for
each earlier branch, at most five, in parallel. The trail leaves out the base
branch (the one that `origin/HEAD` names, else `main` and `master`), because
every work branch leaves it, and a pull request whose head is the base is a
release, not work of this worktree. `--head` matches the branch name in every
fork, so a pull request from a fork counts only when the fork belongs to the
owner of the repository's `origin`. When `gh pr view` fails, the call asks
about no earlier branch.

A hook that waits for one of the old tags never runs now. The first
`pr_status` call shows a diagnostic for each one, with the event to use.

The daemon emits `pr_changed { worktree_id, pr, prs }` when a new pull request
is not equal to the cached one. A new fetch of an open pull request always
differs, because `fetched_at_ms` changes. The first answer for a worktree
after a daemon start always emits the event.

## Tags

The addon writes no tags. Older versions wrote one of `draft`, `review`,
`changes-requested`, `approved`, `merged`, and `closed`. The first start of
this version removes those six tags from every worktree, one time. A tag that
you set after that stays.

## Background work

The daemon has no poller, no timer, and no watcher for GitHub. `gh` runs only
inside a `pr_status` call. The call uses the cache instead when
the cache has a pull request that is less than 60 s old. An answer without a
pull request is not cached, so the next call runs `gh` again.

| Caller | When it calls `pr_status` |
|---|---|
| The inspector section | when it mounts, when the worktree or its branch changes, every 120 s while it stays mounted, and on `refresh` |
| `tomo pr` | once, when the user runs it |

The inspector section mounts only while the right inspector is open on a
worktree whose directory exists. The rail marker, the row link, and the
town history read cached data only. They start no work. So a row shows a
pull request link only for a worktree whose pull request the session
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
crates/tomod/src/addons/github/mod.rs    gh pr view and list, the cache, pr_status, known_pr
crates/tomod/src/addons/github/model.rs  parse, answer, freshness, change and merge rules, known_pr
app/src/addons/github/index.ts           the Addon value: inspector section, row link, repo avatar, frame reducer
app/src/addons/github/                   PrSection.tsx, Avatar.tsx, model.ts, state.ts, activity.ts, github.test.tsx
```

GitHub joins Core and the other addons at these points only:

- `dispatch.rs`: the `pr_status` arm, `is_slow`, and `town_pr`, which gives
  Towns the pull request through `github::known_pr`.
- The GUI slots `inspectorSections`, `worktreeLinks`, `repoAvatar`, and
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
  the rail marker, the row link and its hover card facts, the repo avatar,
  and the owner parse.
- `scripts/torture/github.sh`: a fake `gh` answers from files. The script
  checks the parse, the cache, `pr_changed`, `pr_merged`, the town history,
  `tomo pr`, and the `Repo` shape. It stops if the daemon does not run the
  fake.
