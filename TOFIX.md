States: **DONE** shipped on master · **DOC** documented, no code · **DEFERRED** your
call, not planned · **PARKED** waiting for your word. Detail and root causes live in
`docs/backlog.md`.

- **DONE** the right sidebar minimal view places status + icon side by side, so there is no alignment. should be a clean line of icons.
- **DONE** the icons in the right sidebar should be preserved in the actual open view, so icon + name, not just name
- **DONE** i thought that the tomo toml config is per worktree? right now it seems like if i have 2 worktrees open on the same repo, it will have tow diff configs... unless i need to update my worktree creation skill to copy it? seems like a weird pattern anyway. this is mostyl for the actions bar.
- **DONE**, popup logins deferred — the browser pane is a little finicky. seems like it doesn't really persist itself, eg switch back and forth sometimes refreshes it. ideally we make it more robust and hold state better, as well as redirect cleanly .right now the holly login flow + redirect cause a refresh that menas i cannot log in
- **DONE** the browser does not have a unique icon, it just appears as terminal icon in the tabs.
- **DONE** it would be super awesome to have both the splits model of arranging as well as a more intuitiv mac-y "Rectangle" stytle of arrangement, where if i grab a pane and drag it, it shows where it would b epalced on drop. Look into the Rectangle app as well as various other pane arrangement style apps. I think taht would be the ideal ux, all drag and drop driven with reasonable interaction pattersn / suggested drop zones!
- **DONE** as a recency sort, not a shelf (your call) — recent files addon -> right sidebar, show recent items and let me easily open them. mostly for generated artifacts like html, md, etc. basically instead of a file tree its like most recent touch + open in finder.... perhaps like an artifact shelf? detect artifacts that have been sent by chats? this may be a diff thing
- **DOC** an entry you paste into a repo `.tomo.toml` — drizzle studio action
- **DONE** open in finder should probably be a generic action too
- **PARKED** sound hook addon -> add sounds to anything tomo does (new wroktree, agent started, browser opened etc. basically sound ride along for all hooks)
- **PARKED** agent lineage would be ideal, g showing spawned agents and what is happening in a worktree
- **DONE**, endpoint identity still open — we have a port listener but seems a little inconsitent. should be fixed up and made more reliable. should detect what was spawned by the curent worktree
- **PARKED** archive history, when a tree is archived, get a quick summary of what happened, eg like
  - Aogashima
  Aug 23 – Sep 16
  43 commits
  11 agent sessions
  App ran 17h
  - display these somewhere in the app as a sort of worktree graveyard with little postcards
- **DEFERRED** worktree mascots is kind of interesting... perhaps just a simple avatar for each that's pixel based and randomly generated
- **PARKED** linear addon
- **DONE**, and the CSS pilot came with it — left sidebar card should stay the same size cleanly. ideally we have a nice api for cleaning up cards and customizing them to the right specs (should be easy, can perhaps be a good place for css modules? can we think more about css driven layouts, since this is agent driven anyway?)
- **DONE** the worktree host should be similar to orca, as in it should probably be like ~/tomo/worktrees/<repo>/<worktree>
- **DEFERRED** side note: seems like right now, logging into infisical doesn't work! why might this be? like infisical login goes to the browser and then that finishes and should redirect back to the pane but does not. something to investigate.
- **DONE** it was an em dash in your config, and `tomo config check` now warns — i closed, insatlled and reopened a worktree, then the claude pane, and it sent "-dangerously-skip-permissions" as a message imemdiately. a little weird!
- **NEW** git ingest: a smart input that searches git branches when creating a worktree (grab a branch name from a PR, paste or search it), and a branch that is not required — a default prefix (eg simon/) plus the town name, so a worktree is one click. See item 2.7 in `docs/backlog.md`.
- **NEW** startup should feel instantaneous. See item 2.8 in `docs/backlog.md`: measure the daemon boot, the client mount, and the pane restore apart, then stop holding the first snapshot for git status.
