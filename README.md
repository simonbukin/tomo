# tomo

**by agents, for agents, shaped by you.**

Tomo keeps everything (worktrees, terminals, agents and so on) organized. The rest is up to you!

> **You are on `simon-main`: my own Tomo.** It is the base plus my six addons
> (Towns, GitHub, Usage, Actions, Runtime, Agentation) and my config in
> `personal/config.toml`. `scripts/install.sh --with-config` installs that
> config and keeps a backup of yours. Want a clean start? Use `main`.

## Features

- **Worktrees first**: every worktree of a repo in one sidebar, with its terminals, agents, and tags.
- **Terminals that survive**: each pane runs in its own process, so a daemon or app restart keeps your shells and agents.
- **Agent state tracking**: hooks from Claude Code, Codex, and Pi show working, done, needs you, idle, or dead for each agent and worktree.
- **Subagents**: each live subagent shows under its agent.
- **Resume after a restart**: agent sessions come back, including a turn that the restart cut off.
- **Sleeping agents**: an agent idle for an hour ends and leaves a scrollable snapshot; a key resumes the same session.
- **Code editor**: a CodeMirror 6 pane for quick edits, opened from the palette or a file path in a terminal.
- **Search everything**: `⌘K` finds worktrees, files, terminal scrollback, and agent sessions as you type.
- **Terminal links**: `⌘`-click a file path or a URL in any terminal.
- **Paste and drop**: paste an image or drop a file on a terminal, and the agent gets its path.
- **Main stays current**: each repo's main worktree fast-forwards to its upstream on its own.
- **Archive**: checkpoint, close, and remove a worktree in one step, and keep its branch.
- **Pinned tabs**: pin a tab as a small icon that stays first.
- **Attention**: `⌘⇧A` jumps to the next agent that needs you.
- **Hooks and a CLI**: run your commands on Tomo events, and drive all of Tomo from `tomo` with `--json`.
- **Addons**: add state, commands, and a place in the window through a few seams.

## This repo

- **`main`** is the base: a clean, flat copy for you to install, use, and take
  apart. It has the core, the window, and the addon seams, with no addons and
  no opinions of mine in it. All yours to mess with!
- **[`simon-main`](https://github.com/simonbukin/tomo/tree/simon-main)** is my
  own Tomo config. I regularly update this with my own opinions, themes, and addons.
  You can use it as reference or for inspiration!

## Install

macOS only, for now (but feel free to add support if you want)

```bash
git clone https://github.com/simonbukin/tomo && tomo/scripts/install.sh
tomo integrations install
```

The script builds the release binaries, puts `tomo` and `tomod` in
`~/.local/bin`, and puts `Tomo.app` in `/Applications`. The second line adds
the hooks for Claude, Codex, and Pi; they do nothing outside a Tomo terminal.

Open Tomo.app, add a repository with the plus button, and every worktree of it
turns up in the sidebar. Click one and a shell opens there. `⌘K` is the command
palette; `⌘⇧A` jumps to the next agent that wants you.

## The shape of it

| part | what it is |
|---|---|
| `tomod` | a local Rust daemon. It owns the terminals, the state, and the agent signals. |
| `tomo` | the command line client. Agents and scripts talk to Tomo through it. |
| Tomo.app | a window. Close it and nothing dies; open it again and everything reconnects. |

The worktree is the unit. Terminals, agents, processes, and attention all roll
up to one. Tags group worktrees and need no config.

## A few commands

```bash
tomo status                      # daemon, counts, integrations
tomo worktree list               # every worktree, with its agents
tomo agent spawn codex --cwd .   # start an agent in a new pane here
tomo notify "need a human"       # raise attention from inside a pane
tomo worktree archive .          # checkpoint, close, remove, keep the branch
```

Add `--json` to any of them.

## Making it yours

Everything below is a file you can edit.

- **Config** lives in `~/Library/Application Support/tomo/config.toml`. Tomo
  writes a commented default on first run: themes, fonts, keybindings, agents.
- **Themes** are 14 colors in `[theme]`. The look itself is one token file,
  `app/src/styles/tokens.css`; [DESIGN.md](DESIGN.md) says how it fits
  together.
- **Hooks** run your commands on events like `agent.waiting` or
  `worktree.created`, with the event JSON on stdin.
- **Addons** add their own state, their own commands, and their own place in
  the window. [docs/addons.md](docs/addons.md) lists every seam and the few
  files that an addon touches.

## Things to build

Ideas, small to large. Build what you want! Perhaps...

- A new theme?
- A sidebar that works like you think: by owner, by age, by ticket, or as a tree.
- An integration you'll use... Linear perhaps? Or Hira? 
- A new agent provider?
- A streak counter for merged branches?
- A small pet in the corner that sleeps when your agents are idle perhaps?

`simon-main` has working versions of several of these if you want to look!

## Docs

[architecture](docs/architecture.md) ·
[cli](docs/cli.md) ·
[hooks](docs/hooks.md) ·
[theming](docs/theming.md) ·
[addons](docs/addons.md) ·
[agent integrations](docs/agent-integrations.md) ·
[development](docs/development.md)

[DESIGN.md](DESIGN.md) is how it is meant to look and why.

## Building on it

```bash
cargo test --workspace
cd app && pnpm install && pnpm test
```

The landing page is one static file at [site/index.html](site/index.html), with
no build step.

## Don't like something?

All good. Fork it and do whatever you want with it. It is public domain for a reason.
