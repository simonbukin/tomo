- **PARKED** sound hook addon -> add sounds to anything tomo does (new wroktree, agent started, browser opened etc. basically sound ride along for all hooks)
- **PARKED** agent lineage would be ideal, g showing spawned agents and what is happening in a worktree
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
- **DEFERRED** side note: seems like right now, logging into infisical doesn't work! why might this be? like infisical login goes to the browser and then that finishes and should redirect back to the pane but does not. something to investigate.
- **NEW** startup should feel instantaneous. See item 2.8 in `docs/backlog.md`: measure the daemon boot, the client mount, and the pane restore apart, then stop holding the first snapshot for git status.
