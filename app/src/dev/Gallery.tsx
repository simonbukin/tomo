import { useEffect, useState } from "react";
import { applyFrame, getState, setState } from "../store";
import { defaultUi } from "../uiState";
import { WorktreeCard } from "../Home";
import { RightSidebar } from "../RightSidebar";
import type { AgentPresence, AgentState, Frame, GitSummary, Repo, Worktree } from "../types";

const REPO: Repo = { id: "r1", path: "/Users/you/Projects/tomo", name: "tomo", exists: true, remote_url: "git@github.com:you/tomo.git" };

const git = (patch: Partial<GitSummary> = {}): GitSummary => ({
  branch: "feat/thing",
  head: "abc1234",
  detached: false,
  dirty: false,
  files_changed: 0,
  untracked: 0,
  conflicts: 0,
  insertions: 0,
  deletions: 0,
  ahead: null,
  behind: null,
  upstream: "origin/feat/thing",
  ...patch,
});

const wt = (id: string, patch: Partial<Worktree> = {}): Worktree => ({
  id,
  repo_id: REPO.id,
  path: `/Users/you/tomo/worktrees/tomo/${id}`,
  name: id,
  branch: "feat/thing",
  head: "abc1234",
  detached: false,
  is_main: false,
  exists: true,
  git: git(),
  metadata: { display_name: null, project: null, state: null, tags: [] },
  last_active_ms: Date.now(),
  first_seen_ms: Date.now(),
  archived_at_ms: null,
  archiving: false,
  tab_count: 1,
  pane_count: 1,
  ...patch,
});

const agent = (worktreeId: string, kind: AgentPresence["kind"], state: AgentState, n = 0): AgentPresence => ({
  pane_id: `${worktreeId}-p${n}`,
  worktree_id: worktreeId,
  kind,
  state,
  session_ref: null,
  authority: "lifecycle",
  updated_at_ms: Date.now(),
  pid: null,
});

/** One named state of one component. The gallery renders each on its own, with nothing else on screen. */
interface Scene {
  name: string;
  worktree: Worktree;
  agents?: AgentPresence[];
  /** A `pr_changed` payload, so an addon state can be shown without naming the addon here. */
  frame?: Frame;
}

const SCENES: Scene[] = [
  { name: "quiet", worktree: wt("quiet") },
  { name: "dirty tree", worktree: wt("dirty", { git: git({ dirty: true, files_changed: 3, insertions: 42, deletions: 7 }) }) },
  { name: "detached head", worktree: wt("detached", { branch: null, detached: true }) },
  { name: "one agent working", worktree: wt("working"), agents: [agent("working", "claude", "working")] },
  { name: "three agents", worktree: wt("crowd"), agents: [agent("crowd", "claude", "working"), agent("crowd", "codex", "idle", 1), agent("crowd", "pi", "waiting", 2)] },
  { name: "tags", worktree: wt("tagged", { metadata: { display_name: null, project: "checkout", state: null, tags: ["spike", "ui", "needs-review"] } }) },
  { name: "archived", worktree: wt("archived", { archived_at_ms: Date.now() }) },
  { name: "archiving", worktree: wt("busy", { archiving: true }) },
  { name: "directory missing", worktree: wt("gone", { exists: false }) },
  { name: "main worktree", worktree: wt("tomo", { is_main: true }) },
  { name: "pull request open", worktree: wt("pr-open"), frame: { seq: 1, event: "pr_changed", data: { worktree_id: "pr-open", pr: { number: 12, title: "Add the thing", url: "", state: "open", draft: false, review_decision: null, mergeable: "mergeable", checks_passed: 3, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1 } } } },
  { name: "checks failed", worktree: wt("pr-fail"), frame: { seq: 2, event: "pr_changed", data: { worktree_id: "pr-fail", pr: { number: 13, title: "Break the thing", url: "", state: "open", draft: false, review_decision: null, mergeable: "mergeable", checks_passed: 1, checks_failed: 2, checks_pending: 0, fetched_at_ms: 1 } } } },
  { name: "checks running", worktree: wt("pr-run"), frame: { seq: 3, event: "pr_changed", data: { worktree_id: "pr-run", pr: { number: 14, title: "Try the thing", url: "", state: "open", draft: true, review_decision: null, mergeable: null, checks_passed: 0, checks_failed: 0, checks_pending: 4, fetched_at_ms: 1 } } } },
  { name: "merged", worktree: wt("pr-merged"), frame: { seq: 4, event: "pr_changed", data: { worktree_id: "pr-merged", pr: { number: 15, title: "Shipped the thing", url: "", state: "merged", draft: false, review_decision: "approved", mergeable: null, checks_passed: 5, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1 } } } },
];

/**
 * Seeds the store from the scenes once. Every view reads one module-level store, so a
 * fixture is all a part needs to render on its own, with no daemon and no window chrome.
 */
function seed(): void {
  const worktrees = SCENES.map((s) => s.worktree);
  const agents = SCENES.flatMap((s) => s.agents ?? []);
  setState({
    ...getState(),
    loaded: true,
    connected: true,
    repos: [REPO],
    worktrees,
    agents: Object.fromEntries(agents.map((a) => [a.pane_id, a])),
    ui: { ...defaultUi, view: "home", activeWorktreeId: worktrees[0].id },
  });
  SCENES.forEach((s) => s.frame && applyFrame(s.frame));
}

export function Gallery() {
  const [ready, setReady] = useState(false);
  const [inspector, setInspector] = useState(SCENES[1].worktree.id);
  useEffect(() => {
    seed();
    setReady(true);
  }, []);
  if (!ready) return null;
  const shown = SCENES.find((s) => s.worktree.id === inspector) ?? SCENES[0];
  return (
    <div className="gallery">
      <h2 className="gallery-head">worktree card</h2>
      <div className="gallery-grid">
        {SCENES.map((s) => (
          <figure key={s.name} className="gallery-cell">
            <figcaption className="gallery-caption">{s.name}</figcaption>
            <WorktreeCard w={s.worktree} />
          </figure>
        ))}
      </div>
      <h2 className="gallery-head">right inspector</h2>
      <div className="gallery-picker">
        {SCENES.map((s) => (
          <button key={s.name} type="button" className={`seg${s.worktree.id === inspector ? " seg-active" : ""}`} onClick={() => setInspector(s.worktree.id)}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="gallery-inspector">
        <RightSidebar worktree={shown.worktree} />
      </div>
    </div>
  );
}
