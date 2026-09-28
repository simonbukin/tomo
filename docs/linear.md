# Linear

Tomo shows the state of the Linear issue that a worktree's branch names. The
branch `simon/eng-2611-fix-login` names `ENG-2611`. `tomo linear issue`
prints it, the `subscribe` snapshot carries it in `linear`, and the daemon
sends `linear_changed` when it changes.

The addon is read-only. It sends only GraphQL queries. It never changes an
issue, a comment, or a state in Linear.

Linear is an addon (see [addons.md](addons.md)). If you remove it, the issue
signal, the issue rows in the git section, the palette entry, `tomo linear`,
`linear_get`, `linear_login`, `linear_logout`, and `linear_changed` go away.

## Where the code lives

| Part | Path |
|---|---|
| `LinearIssue`, `LinearState`, `LinearLink`, `LinearStatus`, `LinearViewer` | `crates/tomo-proto/src/addons/linear.rs` |
| `Call::LinearGet`, `Call::LinearLogin`, `Call::LinearLogout`, `Event::LinearChanged`, `Snapshot.linear` | `crates/tomo-proto/src/lib.rs` (composition root) |
| branch parse, query, answer parse, poll rule | `crates/tomod/src/addons/linear/model.rs` |
| Keychain, `curl`, the last answer, the poll | `crates/tomod/src/addons/linear/mod.rs` |
| CLI | `Cmd::Linear` in `crates/tomo-cli/src/main.rs`, `print::linear_*` |
| GUI | `app/src/addons/linear/`: `state.ts`, `model.ts` (signal, tint, palette), `Views.tsx` (icon, signal line, hover card lines, git rows), `index.ts` |

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

The link is the branch name. The daemon does not store a link.

1. `model::identifier` finds the first `<key>-<number>` in the branch, where
   `<key>` starts with a letter. It makes the key upper case, because Linear
   team keys are case-sensitive.
2. One query asks for all issues. Each branch of the `or` filter is an
   explicit `and` of `team.key` and `number`. Linear matches almost every
   issue for an `or` of `{ team, number }` objects without the `and`.
3. A branch such as `release-2` asks for `RELEASE-2`. No team has that key,
   so no issue comes back, and the worktree shows nothing.

A card shows one issue: the first one that the branch names.

## Background work

A poll runs every 20 s. It fetches only while a client is subscribed, and
only when the last answer is 60 s old or when a branch names another issue.
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

- The signal line on a card and a sidebar row shows the Linear mark, the
  identifier, and the state name. The line has no hover card of its own.
- The worktree hover card of a sidebar row or a rail square shows the
  identifier, the state name with its tinted mark, the title, the priority,
  and the assignee. The addon fills `signalLine.Detail` for this.
- The mark has the team's colour for the state, mixed 70% with `--fg`. A pale
  colour such as `#e2e2e2` then still reads on a light theme.
- The git section of the inspector shows the identifier and the title, which
  open the issue, and the state, priority, and assignee.
- The palette has "open ENG-2611 in Linear" for the worktree.

## Known limits

- A card shows at most three signals. The issue is the last addon signal,
  so an urgent signal such as "checks failed" or a memory warning keeps its
  place. The omit of agent signals happens after the cut, so a worktree with
  live agents and other signals can show no issue on its card or row. The
  inspector still shows it.
- One query returns at most 250 issues.
