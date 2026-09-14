# Japan Towns

Japan Towns gives a new worktree a human-friendly name and a place on a
map. It is optional identity on top of an ordinary Git worktree:

```text
ordinary worktree  +  optional town identity  +  map / collection view
```

Delete Tomo and the worktree is still a normal directory named after a
town. Nothing in Git knows about towns.

## Data

`app/src/data/japan-towns.json` holds 1681 municipalities of Japan: cities,
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
name unless you set one.

After `git worktree add` succeeds, Tomo writes one row to the `towns` table
and emits `TownUnlocked`. A town unlocks once. Archiving, restoring, or
deleting the worktree keeps the unlock. When a restore lands at a new path
and therefore a new worktree id, the unlock row moves to the new id.

## Storage

The `towns` table owns the mapping between towns and worktrees:

```text
towns
  slug            town slug (primary key)
  worktree_id     worktree that unlocked it
  repo_id         its repository
  unlocked_at_ms  when
```

Generic worktree records do not carry town data. `Worktree.town_slug` in
the protocol is derived from this table at view time. The
`worktree_meta.town_slug` column is unused and stays only because SQLite
cannot drop it cheaply.

## CLI

```bash
tomo towns list [--unlocked]
tomo towns pick
tomo worktree create --repo <repo> --branch <name> --new [--town <slug>]
```

## Map view

The map button next to `home` opens the map. Every town is a dot in its
rarity color at low opacity; unlocked towns are opaque with a ring. The
landmass outline comes from `app/src/data/japan-outline.json`. Wheel zooms,
drag pans, double-click resets. Hovering a dot shows the town, prefecture,
rarity, population, a Wikipedia link, and for unlocked towns the worktree
and unlock date. The collection list on the right shows counts per rarity
and every unlocked town in unlock order.

## Code boundary

```text
crates/tomod/src/features/towns.rs   dataset, find, weighted pick
crates/tomod/src/store.rs            towns table
app/src/Towns.tsx, app/src/towns.css map and collection view
app/src/data/                        town and outline data
```

The generic runtime touches towns in three places only: worktree creation
(pick and unlock), the `town_list` and `town_pick` calls, and the
`town_slug` view field. If Tomo later grows an extension host, Towns is the
first candidate to move out: it needs custom data, two commands, a creation
hook, and one view, which is exactly the surface an extension API must
offer.
