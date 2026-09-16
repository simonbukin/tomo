# Japan Towns

Japan Towns gives a new worktree a human-friendly name and a place on a
map. It is optional identity on top of an ordinary Git worktree:

```text
ordinary worktree  +  optional town identity  +  map / collection view
```

Delete Tomo and the worktree is still a normal directory named after a
town. Nothing in Git knows about towns.

## Data

`app/src/addons/towns/data/japan-towns.json` holds 1681 municipalities of Japan: cities,
towns, and villages. The source is Wikidata (instances of city, town, and
village of Japan with coordinates and an English Wikipedia article). Each
entry has a slug, English and Japanese names, prefecture, kind, population,
coordinates, the Wikipedia URL, and a rarity tier from population:

| Rarity    | Population      |
|-----------|-----------------|
| common    | 100 000 or more |
| uncommon  | 30 000 – 99 999 |
| rare      | 8 000 – 29 999  |
| epic      | 2 000 – 7 999   |
| legendary | below 2 000     |

The daemon embeds the same file (`include_str!`) so the CLI and the GUI
agree on every town.

## Naming and unlocks

`tomo worktree create` without `--path` asks the towns module for a town
that no worktree has unlocked yet. The pick draws a rarity tier by weight
(common 55, uncommon 25, rare 13, epic 5, legendary 2), then a random town
in that tier. `--town <slug>` picks a specific locked town. The worktree
directory becomes `<parent>/<slug>` and the town name becomes the display
name unless you set one. The parent is `worktree_parent_dir`, else
`~/tomo/worktrees/<repo>`. See [cli.md](../cli.md).

After `git worktree add` succeeds, Tomo writes one row to the `towns` table
and emits `TownUnlocked`. A town unlocks once. Archiving, restoring, or
deleting the worktree keeps the unlock. A worktree that gets a new id keeps
its unlock: the row moves to the new id after a move on disk and after a
restore into a new parent directory.

## Storage

The `towns` table owns the mapping between towns and worktrees:

```text
towns
  slug            town slug (primary key)
  worktree_id     worktree that unlocked it
  repo_id         its repository
  unlocked_at_ms  when
```

Generic worktree records do not carry town data. A client finds the town
of a worktree in the `town_list` unlocks. Old databases keep the unused
`worktree_meta.town_slug` column; a new database does not get it.

## CLI

```bash
tomo towns list [--unlocked]
tomo towns pick
tomo worktree create --repo <repo> --branch <name> --new [--town <slug>]
```

## Map view

The map button next to `home` opens the map. Every town is a dot in its
rarity color at low opacity; unlocked towns are opaque with a ring. The
landmass outline comes from `app/src/addons/towns/data/japan-outline.json`. Wheel zooms,
drag pans, double-click resets. Hovering a dot shows the town, prefecture,
rarity, population, a Wikipedia link, and for unlocked towns the worktree
and unlock date. The collection list on the right shows counts per rarity
and every unlocked town in unlock order. With no unlocks, the list shows
`0 / 1681 municipalities unlocked.` and a `New worktree` button.

## Unlock ceremony

The `town_unlocked` event starts a short reveal (`app/src/addons/towns/TownReveal.tsx`).
The reveal never takes focus. `ceremonyTier` in `app/src/addons/towns/model.ts`
maps the rarity to a tier:

| Rarity | Tier | Reveal | Sound |
|--------|------|--------|-------|
| common, uncommon | small | one line in the bottom-right corner, about 2.6 s | none |
| rare, epic | strong | a card with the Japanese name, the rarity, and `unlocked 38 / 1681`, about 3.8 s | `rare` chime |
| legendary | special | the same card with a double ring, about 5.2 s | `legendary` chime |

The chime plays only when `[notifications] sounds` is on (off by default).
Under `prefers-reduced-motion` the reveal shows with no animation. Escape
or `dismiss` closes it. `view on map` opens the map with the town selected.
There is no reroll.

## History

Select an unlocked town on the map or in the list to see its history. The
detail comes from the `town_history` call:

```json
{ "method": "town_history", "params": { "slug": "aogashima" } }
```

It returns the unlock row, the repo name, the worktree name, the branch,
the status (`active`, `archived`, `missing`, or `gone`), the final commit,
the archive date, and the pull request. Every value is a fact from Tomo's
own records:

- An active or missing worktree shows its head commit as `head`.
- An archived worktree shows the archive checkpoint commit. A clean archive
  has no checkpoint, so it shows the head at archive time. The `archived`
  activity event records both in its payload.
- The pull request comes from the GitHub addon: the cached one, or the last
  `pr_merged` event. Without the GitHub addon, it is `null`.
- A locked or unknown slug returns `not_found`.

The detail keeps the last result on screen while it refreshes, and shows
an inline error when the call fails. `scripts/torture/towns.sh` checks the
history before archive, after archive, and after a daemon restart.

## Code boundary

Towns is an addon. Core does not import it. See [../addons.md](../addons.md).

```text
crates/tomo-proto/src/addons/towns.rs   Town, TownUnlock, TownHistory, TownPr, TownWorktreeStatus
crates/tomod/src/addons/towns/mod.rs    towns table, town_list / town_pick / town_history, the three seams
crates/tomod/src/addons/towns/model.rs  dataset, weighted pick, history facts
app/src/addons/towns/index.ts           the Addon value: view, command, create field, ceremony, hooks
app/src/addons/towns/                   Towns.tsx, TownReveal.tsx, TownSuggest.tsx, state.ts, model.ts, towns.css, data/
```

Towns joins Core at these points only:

- `worktree_namer` seam: picks the directory name before `git worktree add`.
  `WorktreeCreate.name_hint` asks for one town (`--town`, or the dialog
  suggestion). Clients from before the split send it as `town_slug`.
- `worktree_created` seam: writes the unlock, sets the display name, and
  emits `TownUnlocked`. It runs under the state lock inside the create call.
- `worktree_rebound` seam: moves the unlock when a worktree gets a new id.
- `dispatch.rs`: the `town_list`, `town_pick`, and `town_history` calls, and
  `town_pr`, the pull request lookup that `town_history` gets.
- registration lines: the `Call` and `Event` variants in `tomo-proto`, the
  `builtins` entry, the CSS import in `app/src/styles/index.css`, the
  `tomo towns` CLI block, and `towns` in `scripts/torture/run-all.sh`.

`town_history` reads Core data: activity rows, repos, and worktrees. It
gets the pull request from a plain function, `fn(&Inner, &str,
&[ActivityEvent]) -> Option<TownPr>`, that `dispatch.rs` supplies. Towns
calls it while it holds the Core lock. Towns does not import GitHub.
Without GitHub, `dispatch.rs` passes `|_, _, _| None`.
