# Tomo v1

**Status:** Build-ready
**Audience:** autonomous / long-horizon implementation agent
**Target user:** one technical user running multiple coding agents locally
**Primary platform:** macOS
**Secondary platform:** Linux where inexpensive to preserve compatibility
**Product stance:** personal tool first; no SaaS, teams, accounts, marketplace, cloud control plane, or enterprise concerns

---

# 1. TL;DR

Build **Tomo**, a very small, extremely fast desktop application for managing local software-development work spread across Git repositories, Git worktrees, terminals, and coding agents.

Tomo is not an IDE and is not an agent orchestrator.

Its primary job is to answer, immediately:

1. What repositories and worktrees exist?
2. Which ones am I actively working on?
3. What terminals and coding agents are running in each?
4. Which agents need my attention?
5. What else has each worktree spawned?
6. Which worktree is consuming my machine?
7. If I close Tomo or restart my computer, how quickly can I get back to where I was?

The core UI consists of:

* a **left sidebar** containing repositories → worktrees → agent/runtime status;
* a **center workspace** containing terminal tabs and panes;
* a small **right sidebar** for worktree context such as files and Git summary;
* a **Home** view showing all worktrees organized using lightweight user metadata such as project, priority, and tags.

Tomo must discover ordinary Git repositories and Git worktrees. It must never create a proprietary workspace format or hide repositories under Tomo-controlled directories.

Tomo must treat the **worktree as the main unit of context**.

Terminals, coding agents, subprocesses, runtime resource usage, metadata, notifications, and restored sessions all roll up to a worktree.

---

# 2. Product thesis

Most current agent-development environments are becoming increasingly complete IDEs or orchestration products.

Tomo deliberately goes in the opposite direction.

Its thesis is:

> Coding agents already have good interfaces. Git already manages branches and worktrees. Shells already run processes. Editors already edit files. Tomo should make these things visible, persistent, organized, and immediately reachable rather than replacing them.

The product should feel closer to **Pi applied to development workspaces** than to a reduced version of Cursor, Orca, Emdash, or another IDE.

Pi's useful lesson is not merely that it supports extensions. Its more important principle is **primitives rather than predetermined workflow**. Pi keeps its core narrow and makes opinionated behavior easy to change. Tomo should follow the same philosophy.

---

# 3. Product laws

These are architectural constraints, not aspirational slogans.

## 3.1 Reality lives outside Tomo

Git owns repositories and worktrees.

The filesystem owns source files.

Processes are normal OS processes.

Claude, Codex, and Pi own their conversations and native session formats.

Tomo must not make these things inaccessible without Tomo.

If Tomo is deleted, the user's repositories, worktrees, files, branches, and agent histories still exist normally.

## 3.2 Tomo observes before it invents

Prefer discovery over registration.

Prefer OS/Git/agent truth over replicated Tomo state.

Tomo may cache discovered data but must distinguish cached state from authoritative state.

## 3.3 Worktree is the primary context boundary

The worktree is the central durable unit shown to the user.

Do not introduce first-class objects named Task, Thread, Job, Run, Workspace Project, Agent Project, or similar unless technically unavoidable.

## 3.4 The UI is disposable

Closing the Tauri window must not terminate running terminal sessions.

`tomod`, a local Rust daemon, owns live terminal sessions.

The GUI is a client of the daemon.

## 3.5 Recovery is explicit rather than magical

There are three different states:

**Live:** process still exists under `tomod`.

**Restored:** UI/layout metadata was reconstructed after Tomo restarted.

**Resumed:** an agent process died but its native conversation was relaunched from its persisted session ID.

Never present “resumed” as if the original OS process survived.

## 3.6 Opinionated organization is metadata

Git branch names are not project management.

A worktree may have user-defined organizational metadata independent of its branch/path.

Initial useful metadata:

```text
display name
project
priority
tags
```

Do not force lifecycle/status taxonomy.

The user can later add or change organizational concepts.

## 3.7 Agents are first-class Tomo users

Anything important a human can inspect or control should, where practical, have a CLI/API equivalent.

The graphical client must not contain the only implementation of important actions.

## 3.8 Optimize for modification

This is initially a personal tool.

Prefer understandable source code and clean seams over abstract framework machinery.

It is acceptable to modify Tomo itself and commit the change.

Do not construct a generic extension framework merely to avoid editing the application.

---

# 4. What success looks like

A typical morning:

The user launches Tomo.

Within roughly one second, the Home view shows:

```text
MAIN FOCUS

Holly / Labor Relations
P1 · #lr #costing

Claude    waiting
Codex     working

3 terminal panes
7 descendant processes
1.8 GB RAM
```

Elsewhere:

```text
Holly / Calculation Engine
P2 · #engine
Codex    idle

YomYom / reader-audio
P3 · #japanese
no agents
```

The user enters Labor Relations.

The existing terminal layout reappears.

Claude's pane is still live because `tomod` survived the previous UI closure.

Another Codex pane is visibly waiting for input.

Claude launches a Playwright test.

A few seconds later Tomo can show that the Labor Relations runtime now contains Chromium descendants and that those processes are responsible for most of its memory usage.

Claude decides to delegate an investigation and runs:

```bash
tomo agent spawn codex --cwd .
```

A new terminal appears under the same worktree, launches Codex, and becomes visible to both the user and Tomo's runtime model.

The user quits the UI.

Nothing dies.

The user reopens it.

Everything reconnects.

After a machine reboot, Tomo restores the worktree/layout and offers or automatically performs native resume for eligible Claude, Codex, and Pi sessions.

---

# 5. Explicit non-goals for v1

Do **not** build:

* a source-code editor;
* LSP support;
* an embedded web browser;
* a graphical diff viewer;
* pull-request management;
* GitHub or Linear integrations;
* an issue tracker;
* autonomous orchestration;
* a general workflow engine;
* prompt management;
* MCP management;
* agent skill management;
* containers;
* remote machines;
* cloud execution;
* collaboration;
* user accounts;
* sync;
* chat UI;
* built-in AI inference;
* a plugin marketplace;
* arbitrary third-party UI plugins;
* a generic tmux/Zellij/backend abstraction;
* Windows support;
* a replacement for Git;
* a replacement for the agents' own TUIs.

Opening the user's external editor/browser is acceptable.

---

# 6. System architecture

Use:

```text
┌───────────────────────────────┐
│ Tauri desktop client          │
│ web UI + terminal renderer    │
└──────────────┬────────────────┘
               │ local IPC
               ▼
┌───────────────────────────────┐
│ tomod                         │
│ long-lived Rust daemon        │
│                               │
│ repos/worktrees               │
│ PTYs                          │
│ process provenance            │
│ agent state                   │
│ persistence                   │
│ notifications                 │
│ metadata                      │
└──────────────┬────────────────┘
               │
               ├── shell / PTY
               ├── Claude
               ├── Codex
               ├── Pi
               ├── dev server
               └── arbitrary subprocesses

               ▲
               │ same daemon API
┌──────────────┴────────────────┐
│ tomo CLI                      │
└───────────────────────────────┘
```

Tauri is appropriate because it explicitly supports a Rust/system backend communicating with a webview UI by message passing while avoiding an Electron runtime.

The GUI and CLI should use substantially the same daemon operations.

Do not implement core runtime behavior directly inside frontend components.

---

# 7. Repository and worktree discovery

A Repository is an ordinary Git repository.

A Worktree is an ordinary Git worktree.

Use Git itself as truth.

Expected discovery should ultimately derive from commands equivalent to:

```bash
git worktree list --porcelain
```

Tomo may maintain a small list of known repository roots.

For each known repository, discover all current worktrees at startup and on refresh.

Tomo must correctly handle a worktree:

* created through Tomo;
* created manually in another terminal;
* removed outside Tomo;
* moved when Git still knows its new location;
* with an unusual branch name;
* in detached HEAD state;
* with dirty changes;
* with no Tomo metadata.

### Creating worktrees

Tomo may offer a small native UI over normal Git operations.

Inputs:

```text
repository
new/existing branch
starting ref
filesystem location
```

The resulting worktree must be a completely ordinary Git worktree.

No hidden Tomo working directory.

### Cloning

A basic `Clone repository` flow may shell out to normal Git.

Again, no Tomo-specific repository format.

---

# 8. Organizational metadata

Tomo state and development state must be clearly separated.

Suggested local Tomo data:

```text
~/Library/Application Support/tomo/
```

on macOS, using the OS-standard application-data path rather than hard-coding this exact string.

Persist metadata keyed by a stable worktree identity where possible, with canonical path as part of identity/reconciliation.

Initial schema:

```rust
struct WorktreeMetadata {
    display_name: Option<String>,
    project: Option<String>,
    priority: Option<u8>,
    tags: Vec<String>,
}
```

Priority semantics:

```text
P1
P2
P3
P4
unset
```

Do not add an initial workflow/status field merely because Kanban typically has one.

The user may group Home by `project`, filter by tags, and sort by priority/activity.

Metadata is expendable.

Deleting Tomo metadata may make a card less organized, but must never make the underlying worktree unavailable.

---

# 9. Home

Home is first-class in v1.

It is **not a task board**.

It is a high-density view of worktrees.

Each worktree card should show only useful context:

```text
Labor Relations
Holly

P1   #lr #negotiations

Claude   waiting
Codex    working

+213 −81
1.8 GB
```

Where unavailable, omit information instead of filling the UI with empty labels.

Required Home operations:

* search;
* filter by repository/project/tag;
* sort by priority;
* sort by most recently active;
* group by repository;
* group by project;
* show all;
* show worktrees with agents needing attention.

Do not implement drag-and-drop workflow columns in v1.

A future Kanban-like grouping can be built once a real workflow dimension exists.

This is deliberately less ambitious than the original concept.

---

# 10. Main application shell

## Left sidebar

Hierarchy:

```text
Repository
  Worktree
    Agent
    Agent
```

Example:

```text
HOLLY

★ Labor Relations        P1
  ◉ Claude
  ● Codex

Calculation Engine       P2
  ○ Codex

main
```

Worktree rows should be able to surface at a glance:

* display name;
* branch, on hover/detail;
* priority;
* tags, where space permits;
* dirty Git state;
* number/type/state of agents;
* attention indicator;
* optional lightweight CPU/RAM warning.

Do not turn every datum into a permanent badge.

## Center

A worktree owns one or more tabs.

A tab owns one or more panes.

v1 pane type:

```text
Terminal
```

Required:

* create tab;
* close tab;
* rename tab;
* create pane;
* split pane horizontally;
* split pane vertically;
* focus pane;
* resize pane;
* close pane;
* keyboard navigation.

Terminal behavior must be good enough to use Claude Code, Codex, and Pi normally.

That implies proper support for:

* ANSI/VT sequences;
* colors;
* alternate screen;
* cursor movement;
* mouse where terminal applications expect it;
* terminal resizing;
* clipboard;
* scrollback;
* bracketed paste;
* Unicode/Japanese text;
* common shell interactive behavior.

Use a mature web terminal renderer rather than implementing terminal emulation from scratch.

## Right sidebar

Keep v1 intentionally modest.

Two sections:

**Git**

```text
branch
dirty/clean
files changed
insertions/deletions
ahead/behind if cheap
```

**Files**

Simple filesystem tree.

Required actions:

```text
reveal in Finder
copy path
open in configured external editor
```

Do not implement text editing.

---

# 11. `tomod`

`tomod` is a single-user local background daemon.

Responsibilities:

* own PTYs;
* own live terminal process handles;
* track terminal → pane → worktree relationships;
* discover/process agent signals;
* persist recoverable session information;
* provide local IPC;
* maintain process provenance;
* maintain worktree metadata;
* watch repository/worktree changes where useful;
* aggregate agent attention;
* send events to clients.

The daemon must be able to start independently of the GUI.

The GUI should locate/start it automatically when necessary.

Closing the GUI must not stop it.

Provide a clear command:

```bash
tomo daemon stop
```

for intentionally terminating it.

---

# 12. Terminal lifetime and persistence

## Client close

Acceptance:

1. Start Claude in a Tomo terminal.
2. Close the Tomo GUI completely.
3. Wait.
4. Reopen Tomo.
5. The exact same Claude process is still running in the same PTY.
6. Current terminal contents are visible.
7. User can continue interacting.

This is the primary persistence requirement.

## Daemon restart

Do not promise live process survival.

Persist enough information to reconstruct:

```text
repository
worktree
tabs
pane layout
pane cwd
pane title
recent screen/scrollback where practical
last process/agent type
agent native session reference
```

After daemon restart:

* rebuild the visual layout;
* ordinary shell panes become fresh shells in their previous cwd;
* supported agent panes may resume their native conversation;
* do not automatically relaunch arbitrary commands such as destructive scripts.

## Computer reboot

Same semantics as daemon restart.

OS processes died.

Tomo restores structure, then resumes eligible agent conversations.

Herdr uses exactly this distinction: live detach keeps processes alive, whereas server restart restores layout and depends on native agent session restoration to recover conversations.

---

# 13. Agent model

v1 officially supports:

```text
Claude Code
Codex
Pi
```

Other terminal programs still work normally but may appear as unrecognized processes.

Agent state exposed to users:

```text
working
waiting
idle
exited
unknown
```

Visual semantics:

```text
● working
◉ waiting
○ idle
× exited
? unknown
```

Avoid more states in v1.

---

# 14. Agent status authority

Do not attempt to infer every agent using one universal method.

Use the strongest available signal.

Priority:

```text
1. authoritative lifecycle integration
2. authoritative explicit report through tomo CLI/socket
3. known terminal/screen signature
4. process/activity heuristic
5. unknown
```

If a higher-authority source is active, lower-authority heuristics must not constantly overwrite it.

Events should include sequence/timestamp information so stale lifecycle messages cannot rewind current state.

Herdr already demonstrates this model: lifecycle integrations can become authoritative where available, while screen-state detection remains the fallback for agents without sufficient hooks.

---

# 15. Pi integration

Pi should have the richest v1 integration.

Pi exposes TypeScript lifecycle events including agent start/end/settled and explicit blocking UI-prompt events.

Create or install a tiny Tomo Pi extension that reports:

```text
agent_start       → working
ui_prompt_start   → waiting
ui_prompt_end     → working
agent_settled     → idle
```

Also report Pi's resumable session reference.

After reboot, restore using Pi's native session mechanism.

Do not add Tomo-specific UI inside Pi.

The integration should merely report lifecycle/session truth.

---

# 16. Claude integration

Maintain a minimal Tomo integration whose goals are:

1. identify Claude panes;
2. capture a resumable native session reference;
3. obtain lifecycle state where Claude's current hook interfaces make that reliable;
4. otherwise allow terminal/screen detection to determine working/waiting/idle.

After process loss, eligible Claude panes should resume using:

```bash
claude --resume <session>
```

Herdr currently uses native Claude session references for exactly this recovery path.

Do not scrape Claude's private internal persistence format if a supported hook/session mechanism is available.

---

# 17. Codex integration

Same philosophy as Claude.

Goals:

```text
detect Codex
capture native resumable session
use authoritative lifecycle events when trustworthy
fall back to terminal observation where necessary
```

Resume through:

```bash
codex resume <session>
```

Herdr similarly separates Codex session identity from terminal-derived lifecycle authority.

Do not overfit Tomo to undocumented Codex implementation details.

---

# 18. Attention model

An agent entering `waiting` creates attention on its pane and worktree.

An explicit Tomo notification may also create attention.

Required global action:

```text
Jump to next attention item
```

Suggested default:

```text
Cmd+Shift+A
```

Behavior:

1. choose oldest unread attention event;
2. focus its worktree;
3. focus its tab;
4. focus its pane;
5. mark attention as viewed once user actually focuses it.

A notification panel is optional for v1.

Do not build an inbox/task system.

cmux demonstrates that simple terminal/agent notifications that jump directly back to the originating workspace are enough to be highly useful.

---

# 19. Worktree runtime

Every open worktree has a runtime model.

Conceptually:

```rust
struct WorktreeRuntime {
    worktree_id: WorktreeId,
    tabs: Vec<Tab>,
    agents: Vec<AgentPresence>,
    root_processes: Vec<ProcessId>,
}
```

Every pane is associated with exactly one worktree.

Every process directly launched through a pane has provenance back to that pane and worktree.

This relationship must be visible through the daemon API.

---

# 20. Process provenance

This is a major differentiator and belongs in v1.

For each known process, track where possible:

```text
PID
parent PID
command
cwd
start time
worktree
pane
ownership classification
```

Distinguish:

**owned**

Process is known to descend from a process Tomo launched/owns in a pane.

**observed**

Tomo has reasonable evidence that the process relates to a worktree but does not own its lifetime.

Never automatically kill an observed process.

### Descendants

Periodically reconcile descendants of Tomo-owned pane roots.

Example:

```text
Claude
 ├─ node
 │   └─ playwright
 │       ├─ chromium
 │       ├─ chromium
 │       └─ chromium
 └─ git
```

If practical, use inherited Tomo environment variables as additional provenance for subprocesses:

```text
TOMO_WORKTREE_ID
TOMO_PANE_ID
TOMO_SESSION_ID
```

But do not depend solely on reading process environments later.

### Detached children

Expect some processes to daemonize, re-parent, or otherwise escape simple ancestry.

Do not fabricate perfect ownership.

If provenance becomes uncertain, classify it appropriately.

Reliable incomplete information is preferable to fake precision.

---

# 21. Resource accounting

Include **basic** resource accounting in v1 because it validates the process-provenance model and solves a real pain point.

Per owned/associated worktree expose:

```text
CPU
resident memory
process count
```

Aggregation can be approximate but must not double-count known descendants.

UI behavior should remain subtle.

Normal:

```text
Labor Relations
● Claude  ● Codex
```

High use:

```text
Labor Relations
● Claude  ● Codex      4.8 GB
```

Detailed process/resource inspection can be a small modal or right-sidebar section.

Do not build charts, histories, budgets, throttling, cgroups, alerts, or profiling in v1.

The requirement is:

> "What worktree is melting my machine, and roughly what inside it is responsible?"

Nothing more.

---

# 22. Notifications/protocol

Processes running inside Tomo should be able to address Tomo through the CLI.

Required:

```bash
tomo notify "Need approval"
```

Optional useful forms:

```bash
tomo notify --level attention "Need approval"
tomo notify --level info "Tests passed"
```

The command should infer pane/worktree from inherited environment where possible.

Agent integrations should use this same public path rather than a private frontend trick.

Support additional common terminal notification sequences later if trivial, but they are not necessary to complete v1.

---

# 23. CLI

The CLI is a first-class interface.

All commands that return structured entities should support:

```text
--json
```

Required families:

```bash
tomo status

tomo repo list
tomo repo add <path>

tomo worktree list
tomo worktree current
tomo worktree create ...
tomo worktree open ...
tomo worktree metadata get ...
tomo worktree metadata set ...

tomo pane list
tomo pane create
tomo pane split
tomo pane focus
tomo pane send
tomo pane close

tomo agent list
tomo agent spawn claude
tomo agent spawn codex
tomo agent spawn pi

tomo ps
tomo ps --worktree .

tomo notify "..."

tomo daemon status
tomo daemon stop
```

Commands should work from inside a Tomo terminal without requiring explicit worktree IDs when the current environment already supplies one.

Example:

```bash
tomo agent spawn codex --cwd .
```

should:

1. determine current worktree;
2. create a new terminal pane/tab according to a simple default;
3. start Codex there;
4. return its pane/agent identity;
5. cause the GUI to reflect it immediately.

This allows a parent coding agent to spawn helpers using ordinary shell commands without Tomo becoming an agent orchestrator.

---

# 24. Local daemon API

Use a boring local IPC mechanism appropriate to Rust/macOS, such as a Unix domain socket.

Do not expose network TCP by default.

Protocol must support:

* request/response;
* event subscription;
* version handshake;
* structured errors.

Do not design a public internet API.

The CLI and GUI should share generated/common request and response types where practical.

---

# 25. State persistence

Use SQLite unless implementation evidence strongly favors an even smaller transactional store.

SQLite is appropriate for:

```text
known repositories
worktree metadata
layout
tabs/panes
session references
notifications/attention
recent activity
```

Do not mirror Git state into SQLite as authoritative truth.

For example, branch name should normally be rediscovered from Git, not trusted forever because a database row says it is `foo`.

Every persisted field should conceptually fall into one category:

```text
authoritative Tomo metadata
cached external observation
recoverable runtime state
```

Make this distinction clear in code.

---

# 26. Self-editability

Do **not** implement a generic plugin system in v1.

Instead achieve self-editability through:

### Clear repository structure

Prefer small crates/modules with obvious responsibilities.

### Central configuration

Provide an ordinary human-editable config file for:

```text
external editor command
shell
keyboard bindings where feasible
display preferences
resource-warning threshold
default worktree parent directory
```

### Stable CLI

Many personalized workflows can simply be shell scripts that call Tomo.

### Internal boundaries

Implement optional/opinionated features such as agent adapters and Home organization in modules that could later become extensions without requiring them to be dynamically loaded today.

### Source modifications are allowed

This is initially a personal application.

The expected workflow may literally be:

```text
ask Pi/Claude to modify Tomo
run tests
commit change
restart/hot-reload development build
```

That is acceptable.

Do not build an extension framework until concrete modifications reveal what the stable extension API should be.

Future extraction should take inspiration from Pi's TypeScript extension system rather than inventing a binary ABI. Pi demonstrates that simple source-level TypeScript modules can expose lifecycle events, commands, tools, and UI while remaining hot-reloadable.

---

# 27. Keyboard-first behavior

Required shortcuts should have sensible defaults and be centrally defined.

At minimum:

```text
Home
command palette
next attention
previous/next worktree
new terminal
new tab
close pane
focus left/right/up/down pane
toggle left sidebar
toggle right sidebar
```

Mouse operation should remain complete.

Do not build Vim-emulation or elaborate keybinding modes.

---

# 28. Command palette

Implement a fast command palette.

It should search:

```text
worktrees
commands
repos
basic actions
```

Example:

```text
> labor
  Open worktree: Labor Relations

> new term
  New terminal

> priority
  Set worktree priority...
```

Do not put AI in the command palette.

---

# 29. Performance requirements

Tomo must feel materially faster and calmer than a conventional ADE.

Targets on a contemporary Apple Silicon Mac with a reasonable number of repositories/worktrees:

**GUI cold launch to usable shell:** target < 1 second when daemon is already alive.

**Reattach to existing terminal:** should feel effectively immediate.

**Sidebar/worktree switching:** target < 100 ms perceived delay excluding external Git commands.

**Command palette:** no perceptible input lag.

**Idle CPU:** approximately zero absent filesystem/process events.

**Idle memory:** minimize aggressively; investigate regressions rather than accepting Electron-like growth.

Do not compromise correctness to hit an arbitrary benchmark, but treat noticeable latency as a bug.

Benchmark with:

```text
1 repository / 3 worktrees
5 repositories / 25 worktrees
10 live panes
5 simultaneous coding agents
large terminal scrollback
```

---

# 30. Reliability requirements

The implementation is not complete if the happy path works but session recovery is fragile.

Test:

* GUI crash while daemon lives;
* GUI force quit;
* daemon restart;
* full machine reboot;
* repository moved;
* worktree deleted externally;
* worktree added externally;
* agent process exits;
* agent integration stops reporting;
* stale lifecycle message arrives;
* child process exits before polling;
* huge terminal output;
* terminal application uses alternate screen;
* pane closes while subprocess exists;
* Git command fails;
* malformed Tomo metadata;
* SQLite interrupted write;
* user launches multiple GUI clients.

Failures must degrade to recoverable states rather than corrupting worktrees.

---

# 31. Safety around processes

Tomo must be conservative about process termination.

Closing a pane may prompt when owned live processes remain.

Never kill processes merely because they appear associated through cwd or heuristic observation.

Use clear concepts:

```text
owned
observed
unknown
```

Only owned process trees are candidates for automatic lifecycle control.

Provide an explicit "kill process tree" action when useful.

No global cleanup daemon that guesses what the user wanted terminated.

---

# 32. Visual design

The desired visual character is:

```text
dense
quiet
fast
native-feeling
keyboard-friendly
low ornament
high information value
```

Avoid:

```text
giant cards
chat bubbles
gradient-heavy AI branding
dashboard chrome
large empty gutters
pervasive rounded rectangles
animations that delay interaction
```

Agent state should be identifiable mostly through tiny icons/dots and text.

Worktree names should dominate the left sidebar, not agent branding.

The application should feel closer to a very good terminal/file utility than a project-management SaaS product.

---

# 33. Implementation sequence

A long-horizon agent should implement in vertical slices and keep the application runnable.

## Milestone 1 — shell

Deliver:

```text
Rust workspace
tomod
tomo CLI
Tauri window
IPC handshake
single PTY
terminal rendering
```

Acceptance:

A shell opened by `tomod` is usable in Tauri.

Closing and reopening Tauri reconnects to the same shell process.

Do not proceed until this is dependable.

## Milestone 2 — repos/worktrees

Deliver:

```text
known repo management
Git discovery
left sidebar
worktree switching
worktree creation
basic metadata
```

Acceptance:

Externally created worktrees appear after discovery/refresh.

Tomo-created worktrees are completely ordinary Git worktrees.

## Milestone 3 — workspace model

Deliver:

```text
tabs
splits
pane persistence
layout restoration
keyboard navigation
```

Acceptance:

A complex terminal layout survives GUI closure exactly.

After daemon restart, structure is reconstructed correctly.

## Milestone 4 — agent recognition

Deliver:

```text
Claude
Codex
Pi
agent states
session references
attention navigation
```

Acceptance:

All three can be run normally.

Their presence appears under the correct worktree.

Pi semantic state is hook-driven.

Claude/Codex use strongest available supported state mechanisms with graceful fallback.

## Milestone 5 — recovery

Deliver:

```text
native agent session restore
reboot recovery
explicit restored/resumed semantics
```

Acceptance:

Start meaningful conversations in Claude, Codex, and Pi.

Terminate daemon/machine-equivalent state.

Restart.

Return to the correct worktree/layout and recover eligible agent conversations using their native resume mechanisms.

## Milestone 6 — process provenance

Deliver:

```text
root processes
descendant discovery
owned/observed distinction
tomo ps
CPU/RAM aggregation
```

Acceptance:

Have Claude launch Playwright/Chromium.

Tomo shows that Chromium belongs under the correct worktree/runtime and can identify it as the main memory consumer.

## Milestone 7 — Home + polish

Deliver:

```text
Home
project/priority/tags
filter/search/group/sort
command palette
Git sidebar
file tree
external editor action
```

Acceptance:

User can organize ten messy worktrees without renaming branches.

Finding any worktree or waiting agent requires only a few keystrokes.

---

# 34. P0 acceptance harness

Before considering v1 complete, automate or manually certify these exact scenarios.

## A — Tomo never owns my Git world

Create repository outside Tomo.

Create three worktrees using Git CLI.

Open Tomo.

All appear.

Quit Tomo permanently.

Every worktree remains usable normally.

**Pass:** yes/no.

## B — GUI is disposable

Launch Claude.

Begin a long operation.

Quit the GUI.

Wait.

Reopen.

**Pass:** same underlying process and terminal are still alive.

## C — recovery after process loss

Start Claude, Codex, and Pi conversations.

Record meaningful context in each.

Simulate daemon/machine restart.

Reopen Tomo.

**Pass:** layout returns and supported agents recover their conversation using native resume.

## D — attention is trustworthy

Run multiple agents.

Cause one to wait for the user.

**Pass:** sidebar identifies correct worktree/agent and Next Attention jumps directly to its terminal.

No other actively working agent is incorrectly marked waiting for a sustained period.

## E — organizational metadata solves the Orca pain

Create badly named branches/worktrees.

Assign:

```text
project = Labor Relations
priority = P1
tags = lr, costing
```

**Pass:** Home and sidebar make the intended grouping immediately obvious without changing Git names.

## F — spawned work is visible

From Claude, run an application test that launches Playwright and Chromium.

**Pass:** `tomo ps` and GUI associate the resulting process tree with the correct worktree.

## G — machine hog

Make one worktree consume several GB of RAM.

**Pass:** user can identify which worktree and approximately which child processes are responsible within seconds.

## H — agents can operate Tomo

From a Claude shell inside worktree A:

```bash
tomo agent spawn codex --cwd .
```

**Pass:** Codex starts in a newly managed terminal belonging to worktree A and appears in UI without manual refresh.

## I — external change reconciliation

While Tomo runs:

```text
create worktree externally
delete another worktree externally
change branch externally
```

**Pass:** Tomo reconciles without corrupted state or requiring database repair.

## J — terminal quality

Use Claude, Codex, Pi, vim, less, top, shell completion, Unicode/Japanese text, large output, alternate-screen programs, copy/paste, scrolling, and pane resizing.

**Pass:** terminal behavior does not make the user wish they had opened Terminal.app instead.

This acceptance criterion is deliberately subjective and important.

---

# 35. Definition of done

Tomo v1 is complete only when:

* there is an installable macOS application;
* `tomod` launches/reconnects reliably;
* the `tomo` CLI is installed and usable;
* repos and external Git worktrees are correctly discovered;
* worktrees can be created without proprietary storage;
* worktree metadata supports project, priority, tags, and display name;
* Home makes many worktrees easy to organize;
* terminals, tabs, and splits are pleasant for daily use;
* closing the GUI does not kill running work;
* reboot/daemon loss restores layout and resumes supported agent sessions;
* Claude, Codex, and Pi have useful presence/state/session integration;
* waiting agents are easy to find;
* process provenance works well enough to recognize common spawned process trees;
* basic CPU/RAM use rolls up by worktree;
* agents can drive important Tomo actions through the CLI;
* the right sidebar provides useful Git/file context without becoming an IDE;
* all P0 harness scenarios pass;
* documentation explains architecture, recovery semantics, CLI, config, and agent integrations;
* automated tests cover durable core logic;
* there are no placeholder buttons, dead settings pages, fake features, or TODO-only UX in the shipped v1.

---

# 36. Required implementation documentation

Leave behind:

```text
README.md
docs/architecture.md
docs/state-and-recovery.md
docs/agent-integrations.md
docs/cli.md
docs/development.md
docs/data-model.md
```

`architecture.md` must explain what is authoritative and what is cached.

`state-and-recovery.md` must explicitly explain live vs restored vs resumed.

`development.md` must make Tomo easy for another coding agent to modify.

Do not generate architectural documentation that merely repeats filenames. Explain the invariants and why they exist.

---

# 37. Decisions the implementation agent may make autonomously

Choose without asking the user:

* frontend framework;
* exact Rust crates;
* exact terminal-rendering library;
* exact SQLite layer;
* IPC serialization format;
* filesystem watcher;
* macOS background-daemon registration mechanism;
* styling implementation;
* test framework;
* internal identifiers.

Prefer mature, boring dependencies.

Do not replace this architecture with Electron, a web server exposed on localhost, a cloud service, Docker, or an embedded IDE merely because a library makes that easier.

---

# 38. Decisions that require very strong evidence to change

Do not casually change:

```text
worktree as context boundary
ordinary Git worktrees
daemon-owned persistence
GUI as disposable client
Claude/Codex/Pi first
agent-native session recovery
agent-friendly CLI
process provenance
metadata separate from Git
no built-in editor/browser in v1
no plugin framework in v1
```

If an implementation constraint makes one impossible, document the constraint and select the smallest alternative that preserves the underlying product principle.

---

# 39. Post-v1 candidates

Do not implement these merely because time remains.

Natural next candidates are:

```text
embedded browser surface
graphical diff surface
tiny read-only file viewer
richer process inspector
tmux interoperability
remote tomod
TypeScript extension host
custom metadata schemas/views
GitHub/PR extension
Linear extension
agent-created browser/test surfaces
```

The TypeScript extension host should be designed only after actual modifications to Tomo expose stable primitives worth publishing.

A good eventual test is:

> Can several features currently implemented internally be moved into extensions without inventing special APIs for each one?

If yes, the extension boundary is probably real.

---

# 40. Final product standard

Do not optimize for how many features Tomo has.

Optimize for the following moment:

The user has five repositories, fifteen worktrees, eight coding agents, three dev servers, and a stray Playwright run active.

They open Tomo.

Within a glance they understand the state of their work.

Within a keystroke they reach the agent that needs them.

Within seconds they know what is consuming resources.

They can close Tomo without fear.

They can restart the machine and recover their useful context.

An agent can create another pane or helper agent through ordinary CLI primitives.

And at no point does Tomo feel like it has invented an alternate software-development universe around their repositories.

If Tomo accomplishes that while remaining small enough that a coding agent can comfortably modify its source, it has succeeded.
