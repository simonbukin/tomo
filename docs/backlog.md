# Backlog

The source is `TOFIX.md` in the repository root, which stays the inbox. This
file categorizes those notes, records the root cause where one is known, and
gives an order. Effort is **S** (under an hour), **M** (a few hours), **L** (a
day or more). Layer is core, client, addon, host (Tauri), or config.

## 0. Decisions

Settled with the user on 2026-09-16:

- **Browser panes stay alive and sleep.** Do not cap the count. Tomo does not
  try to be a full browser, but a pane must feel stable and real. A sleeping
  pane keeps its page and its session, like a sleeping tab in Chromium. Open
  question: show the live browser panes of a worktree the way runtime ports are
  shown.
- **`.tomo.toml` belongs to the repository.** A worktree file may still
  override it. There is no reason for the file to be worktree-specific by
  default.
- **No artifact shelf.** Instead, sort the Files inspector by recency and give
  it the same context menu (open, reveal in Finder, open in the editor).
- **Mascots are their own addon** and can wait.
- **CSS needs its own discussion.** Tomo must stay editable by an agent, so the
  styling must be generic, simple, and open. CSS modules look right for that,
  and the decision comes before item 2.3.

## 1. Bugs with a known root cause

### 1.1 An agent reads a flag as its first message — S, config
`agents.claude.args` in the user config holds `—dangerously-skip-permissions`
with an em dash (U+2014), not `--`. `providers::launch` passes it as `argv[1]`,
`shell_quote` quotes it because of the non-ASCII character, and the agent takes
a value that does not start with `-` as a positional operand, which Claude Code
sends as the first message. This happens on every start, not only on a reopen.

- Fix the config line.
- Add a check in `config::issues` (`crates/tomod/src/config.rs`): warn when an
  `agents.*.args` entry starts with U+2010 to U+2015 or U+2212. A warning, not
  a rejection.
- Latent, separate: `type_pending_when_quiet` (`daemon.rs`) writes the pending
  command line after a 5 s timeout whatever reads the tty. Guard it while
  output still flows.

**Done.** The user config is corrected. `config::issues` warns when an
`agents.*.args` entry starts with a Unicode dash. The pending line now follows
`pending_action`: it goes when the tty is quiet, it goes at 5 s when the pane
wrote nothing, it waits while output flows, and after 30 s it is dropped with a
diagnostic.

### 1.2 A browser pane loses its page and its login — M, client (+M host)
`BrowserPane` closes the child webview in its unmount cleanup, and only the
active tab renders, so a tab switch destroys the page, its heap, and its session
cookies. `docs/browser.md` records this as intended. The behavior looks random
because `browser_close` is fire-and-forget: a fast return sometimes finds the
webview alive.

- Keep the webview alive and hide it. Move the lifetime from the React
  component to the pane: unmount hides, and an always-mounted host (the unused
  `mount` slot) closes the ids that leave the store.
- Push the bounds before `show()`, because a hidden webview keeps a stale rect
  after a resize or a zoom change.
- Do not cap the set (decision 0). Make a hidden pane sleep instead: keep the
  page and its session, and give back what a hidden page does not need. Measure
  the cost of a sleeping webview first, because each one is a full process.
- Second, for popup logins: `on_new_window` denies the popup and navigates the
  same webview, so the opener that must receive the code is destroyed. Open a
  real child webview instead.

### 1.3 The right rail puts the status glyph beside the icon — S, client
The `.rail-marker` rule no longer exists. It was deleted when the left rail
changed to status dots, and only the left rail got a replacement, so the badge
now flows inline. Restore a positioned badge rule scoped to the rail button.

**Done.** `.rail-btn .rail-marker` in `sidebar.css` puts the badge in the
corner of the button, so the icon column stays straight.

### 1.4 A browser tab shows the terminal icon — S, client
`Tabs.tsx` renders `ProcessIcon` from `agent` and `process_cmd`. A browser pane
has neither, so the icon falls through to the terminal glyph. Render the globe
when the lead pane kind is `browser`, as the pane legend already does. Keep
`ProcessIcon` about processes.

**Done.** `Tabs.tsx` draws the globe for a browser lead pane; `ProcessIcon`
did not change.

### 1.5 Runtime endpoints are unreliable — S to M, addon (+client)
Several weaknesses, in order of value:

- `lsof` runs with no deadline. A hung call blocks the monitor tick, so process
  polling, agent state, and resources stop. Give it about 2 s and a diagnostic.
- An endpoint id is `pid:port`, so a dev server that restarts slower than the
  5 s grace produces a remove and an add, with duplicate hooks and activity.
  Key it by worktree and port, and keep the pid as a field.
- The removal grace of 5 s is short for a restart; about 15 s is calmer.
- After a daemon restart, servers started from the old panes are reparented and
  become `observed`, so they never appear again. There is no honest fix through
  the process tree; a marked, dimmed entry is a policy choice, not a fix.
- The GUI hides an endpoint until its probe answers. Add a `probed` flag rather
  than widening the filter, which would surface databases.

**Partly done.** `lsof` now has a 2 s deadline with its own diagnostic, and the
removal grace is 15 s. Still open: the endpoint identity (worktree and port
instead of pid and port), the orphaned servers after a daemon restart, and the
`probed` flag in the GUI.

### 1.6 Two small gaps found while fixing the above — S each, client and docs
- `previews.css` has no `.glyph-dirty` rule, so the git marker in the right rail
  takes the button color instead of a tone from the glyph table.
- `docs/addons-map.md` still says an endpoint goes "after the 5 s grace". That
  table records the layout before the addon split, so correct it or mark it as
  history.
- `tomo action list --json` prints only `set.actions`, so `from_repo` and the
  set error never reach the CLI. A second client cannot tell a repository
  Action from a worktree one.

## 2. Behavior and ergonomics

### 2.1 Repo-level `.tomo.toml` — M, addon
Actions read `<worktree>/.tomo.toml` only, so every worktree needs a copy. Add a
fallback to the repository file when the worktree has none (the worktree wins;
no merge, which would need a conflict rule per id). Also watch the repo root
file, put the source path in the error, and show in the GUI when a set came from
the repository. An Action is arbitrary shell, so a repo-level file gives that to
every worktree at once.

**Done.** `model::load(worktree, repo)` reads the worktree file, and the
repository file only when the worktree has none, so a worktree file wins whole.
The watcher covers the repository root, a problem names its own file, and
`ActionSet.from_repo` puts "from the repository" in the topbar tooltip.

### 2.2 Icons in the open inspector — S, client
The inspector renders plain text headings while the icons live only in the
rail's section table. Share one table of id, label, and icon.

**Done.** The table and `SectionLabel` live in `app/src/sections.tsx`, which
the right rail and the open inspector both read.

### 2.3 Sidebar cards keep one size, and the CSS pilot — M, client
Rows vary because the branch line spans a second grid row and the signal block
is conditional. Give a row one height and a single-line signal area with an
ellipsis.

This item is also the CSS pilot. The goal is a whole app that stays easy to
theme and easy for an agent to change. Two layers, and one rule to place
anything:

- **Global** (`app/src/styles/`): the design language. Tokens for color,
  space, type, and motion; the status vocabulary (`.state`, the dot classes,
  the glyph tones); resets; and anything a theme must restyle from one place.
- **Module** (`<Component>.module.css` next to the component): the layout that
  one component owns. Grid areas, sizes, and local states.
- **The rule:** if a change should reach the whole app, it is a token or a
  shared class. If a change should reach one component, it is a module.

A module never writes a color, a font, or a motion value directly. It reads a
token. That keeps `[theme]` in `config.toml` the one theming surface, so the
pilot cannot make the app less themeable.

Pilot scope: the sidebar worktree row becomes the first module, together with
the fixed height above. Vite handles `*.module.css` with no new dependency.
Keep the class names readable in the DOM, so a person or an agent can still
find a rule from the inspector.

Done means: a row keeps one height whatever it shows; the signal area is one
line with an ellipsis; the module holds no color literal; a theme change still
restyles the row; the sidebar tests pass; and `docs/ui.md` carries the rule
above in one short section. The rest of the app moves later, one component at
a time, only where a module makes it simpler.

### 2.4 Worktree home directory — M, core
Create new worktrees in `~/tomo/worktrees/<repo>/<worktree>` instead of beside
the repository. Keep `worktree_parent_dir` as the override, never move existing
worktrees, and update the create dialog preview. Orca and Conductor both use
this shape.

### 2.5 Generic actions — S each, addon
"Open in Finder" as a built-in action next to the editor button, and a Drizzle
Studio action. The Drizzle one is a `.tomo.toml` entry, so it is easier after
2.1.

**Done (Finder).** `WorktreeHeader.tsx` has a Finder button next to the editor
button, with the `reveal_finder` shortcut in its tooltip. The Drizzle action
still waits for 2.1.

### 2.6 Infisical login — diagnosis first
The CLI opens the system browser and waits on a localhost callback, so the Tomo
pane is not in that path. Run the login in a pane, note the callback port, and
check whether the port is reachable and whether the daemon sees it. No fix until
the cause is known.

## 3. New features, each an addon

| Idea | Shape | Effort |
|---|---|---|
| Drag arrangement like Rectangle | An overlay that shows the target region while a pane drags. The drop regions and the split-tree moves already exist; this is presentation and hit testing. | M |
| Files by recency | Not a separate shelf (decision 0): sort the Files inspector by modification time and give it the same context menu (open, reveal in Finder, open in the editor). | S |
| Sound hooks | Sounds for hook events (`worktree.*`, `agent.*`, `action.*`). `sounds.ts` and the `[notifications] sounds` switch exist; this generalizes them. Keep it off by default. | S |
| Agent lineage | Which agent spawned which, per worktree. Needs a parent link at spawn time and a small view. | M |
| Archive postcards | A card for each archived worktree: dates, commits, agent sessions, and running time. `town_history` has part of it; commits and session counts need an aggregate from activity and git. | M |
| Worktree mascots | A small generated avatar for each worktree, from its id. Its own addon, separate from Towns (decision 0). Deferred. | S |
| Linear | Issues beside a worktree. External API, tokens, and polling, so it is the largest. | L |

## 4. Order

1. **1.1, 1.3, 1.4** — small, independent, and each removes a daily irritation.
2. **1.5 (the `lsof` deadline first)** — it protects the whole monitor tick.
3. **1.2** — the browser keep-alive, then the popup path.
4. **2.1, 2.2, 2.5** — repo-level actions unlock the Drizzle action.
5. **2.3, 2.4** — sidebar contract, then the worktree home.
6. **3** — one addon at a time, cheapest first: sounds, mascots, artifact shelf,
   lineage, postcards, drag overlay, Linear.

## 5. Open questions

- `.tomo.toml`: fallback only, or a merge with the worktree winning per id?
- Browser keep-alive: how many panes stay alive on a memory-tight machine?
- Artifact shelf: only recent files, or detect what an agent wrote?
- Mascots and towns both name a worktree. One identity or two?
- CSS: keep one global sheet with tokens, or move cards to CSS modules?
