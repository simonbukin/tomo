# Linear

Tomo shows the state of the Linear issues that a worktree names. The branch
`you/eng-2611-fix-login` names `ENG-2611`. A worktree that had more than one
branch, or a commit subject such as `ENG-2612 fix the redirect too`, names
more than one issue. `tomo linear issue`
prints it, the `subscribe` snapshot carries it in `linear`, and the daemon
sends `linear_changed` when it changes.

The addon is read-only. It sends only GraphQL queries. It never changes an
issue, a comment, or a state in Linear.

Linear is an addon (see [addons.md](addons.md)). If you remove it, the issue
link, the issue rows in the git section, the palette entry, `tomo linear`,
`linear_get`, `linear_login`, `linear_logout`, and `linear_changed` go away.

## Where the code lives

| Part | Path |
|---|---|
| `LinearIssue`, `LinearState`, `LinearLink`, `LinearStatus`, `LinearViewer` | `crates/tomo-proto/src/addons/linear.rs` |
| `Call::LinearGet`, `Call::LinearLogin`, `Call::LinearLogout`, `Event::LinearChanged`, `Snapshot.linear` | `crates/tomo-proto/src/lib.rs` (composition root) |
| branch parse, query, answer parse, poll rule | `crates/tomod/src/addons/linear/model.rs` |
| Keychain, `curl`, the last answer, the poll | `crates/tomod/src/addons/linear/mod.rs` |
| CLI | `Cmd::Linear` in `crates/tomo-cli/src/main.rs`, `print::linear_*` |
| GUI | `app/src/addons/linear/`: `state.ts`, `model.ts` (the row link, tint, palette), `Glyph.tsx` (the mark), `Views.tsx` (icon, git rows), `index.ts` |

## The key

Make a personal API key in Linear: Settings, Account, Security & access,
Personal API keys. Give it the Read permission only. Then give it to Tomo:

```sh
pbpaste | tomo linear login
```

The daemon asks Linear who owns the key (`viewer { name }`). It keeps the key
only when Linear accepts it. The key goes to the login Keychain as the
generic password `tomo.linear` / `linear`. `security -i` reads that command
on stdin, so the key is never in the argv of a process. `curl` gets the key
on stdin as a header. `tomo linear logout` deletes the key.

A 401 does not delete the key. The status shows the reason until the key
works again or you log in with a new one.

## The link

The link is a name in git. The daemon does not store a link.

1. The trail of the worktree (`crates/tomod/src/trail.rs`) gives the branches
   that the worktree checked out, left, or committed on in the last 30 days,
   at most six, with the subjects of the commits that it made on each.
   `model::wanted` takes the issue of each branch and of each subject, one
   time for each worktree: with the newest touch, as current when the branch
   now names it, and with why, such as `branch you/eng-31-retry` or
   `named in a commit on you/eng-31-retry`.
2. `model::identifier` finds the first `<key>-<number>` in a branch or a
   subject, where `<key>` starts with a letter. It makes the key upper case,
   because Linear team keys are case-sensitive.
3. One query asks for all issues, each one time. Each branch of the `or` filter is an
   explicit `and` of `team.key` and `number`. Linear matches almost every
   issue for an `or` of `{ team, number }` objects without the `and`.
4. A branch such as `release-2` asks for `RELEASE-2`. No team has that key,
   so no issue comes back, and the worktree shows nothing.

The daemon reads the reflogs outside its lock: a check copies the list of
live worktrees under the lock, then reads the files without it.

## Background work

A poll runs every 20 s. It fetches only while a client is subscribed, and
only when the last answer is 60 s old or when a worktree names another issue.
A new touch of an issue that the last answer has waits for the next poll.
`linear_get` uses the same rule without a subscriber, so `tomo linear issue`
is current when no GUI runs.
It reads the Keychain on each fetch, but it does no network work when no
branch names an issue. At one request each
minute, it uses about 60 of the 2,500 requests that Linear allows each hour.

## Status

`LinearStatus.available` is false with a `reason` when there is no key, when
Linear rejects the key, when the rate limit is reached, or when Linear does
not answer. A `curl` that fails, and a 200 without `data`, count as no
answer. The links are then empty: Tomo does not show an old state as the
current one. Every reason except "no key" is a diagnostic. Most people do not
use Linear, so a missing key is not a problem.

## Display

- The addon gives one link for each issue through the `worktreeLinks` slot.
  The name line of a sidebar row and a Home card stacks them with the other
  links: the Linear mark in the color of the issue state, then the newest
  identifier (`ENG-12`) and `+N`. See "Worktree rows" in [ui.md](ui.md).
- The links section of the worktree hover card and of the inspector shows
  each issue with the identifier, the title, the state name, and the
  assignee, and a pull request whose branch or title names the issue under
  it. The inspector adds why the worktree has the issue.
- The mark has the team's colour for the state, mixed 70% with `--fg`. A pale
  colour such as `#e2e2e2` then still reads on a light theme.
- The git section of the inspector shows the issue of the branch now, else
  the one that the worktree touched last: the identifier and the title,
  which open the issue, and the state, priority, and assignee.
- The palette has "open ENG-2611 in Linear" for each issue of the worktree.

## Known limits

- One query returns at most 250 issues.
