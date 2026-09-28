# Main worktree sync

Tomo keeps the main worktree of each repository on its upstream. The main
worktree is the checkout at the repository root. A sync is a `git fetch`,
then a `git merge --ff-only @{u}` when nothing can be lost. `sync.rs` in
`crates/tomod` holds the code. This is Core, because it is Git lifecycle and
it must run inside `worktree_create`.

## When a sync runs

- Every 5 minutes for each repository, while a client is subscribed. A 30 s
  tick checks the age.
- Before `worktree_create` starts a new branch from the main worktree (a new
  branch with no `start_ref`). A sync younger than 30 s counts, so two
  creates in a row fetch once. The new branch then starts from the fresh
  main.
- On `tomo repo sync <repo>` (`repo_sync`).

One sync runs for each repository at a time.

## When a sync does not fast-forward

| Case | Result | Diagnostic |
|---|---|---|
| the branch has no upstream, or HEAD is detached | skipped, with no fetch | no |
| main has commits that its upstream does not have | skipped | yes |
| a tracked file has a change (untracked files do not count) | skipped | no |
| a live agent is in the main worktree | skipped | no |
| the fetch or the merge fails | failed | yes |

A fast-forward records an info diagnostic. After each sync, the git section
of the main worktree shows the new ahead and behind counts, so a skipped
sync shows as `↓N`.

`git` runs with `GIT_TERMINAL_PROMPT=0`, so a credential prompt fails and
does not hang. The fetch turns off `gc.auto` and `maintenance.auto`.
`worktree_create` and `repo_sync` run in their own task, because a fetch can
take seconds.

## Known limits

- A process that is not an agent, such as a dev server in the main
  worktree, sees its files change after a fast-forward.
- A fetch that asks for an SSH passphrase fails when no agent holds the key.
