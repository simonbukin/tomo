import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { useEffect, useState } from "react";
import { applyFrame, getState, setState, setUi } from "../store";
import { defaultUi } from "../uiState";
import { Home, WorktreeCard } from "../Home";
import { RightSidebar } from "../RightSidebar";
import { Sidebar, WorktreeRow } from "../Sidebar";
import { WorktreePreview } from "../WorktreePreview";
import { BOARD_REPO, BOARD_WARN_BYTES, rowBoard } from "./rowBoard";
import { LeftRail } from "../shell/LeftRail";
import { BottomStrip } from "../shell/BottomStrip";
import { aPane } from "../test-fixtures";
import { WorktreeHeader } from "../WorktreeHeader";
import type { AgentPresence, AgentState, Config, Frame, GitSummary, HomeOptions, Repo, Subagent, Worktree } from "../types";

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
  metadata: { display_name: null, tags: [] },
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
  estimated: false,
  seen: false,
});

const sub = (id: string | null, label: string, state: AgentState, description: string | null, minutesAgo = 1): Subagent => ({ id, label, description, state, started_at_ms: Date.now() - minutesAgo * 60_000 , updated_at_ms: Date.now() - minutesAgo * 60_000 });

/** One named state of one component. The gallery renders each on its own, with nothing else on screen. */
interface Scene {
  name: string;
  worktree: Worktree;
  agents?: AgentPresence[];
  /** An addon event such as `pr_changed`, so an addon state can be shown without naming the addon here. */
  frame?: Frame;
}

const SCENES: Scene[] = [
  { name: "quiet", worktree: wt("quiet") },
  { name: "dirty tree", worktree: wt("dirty", { git: git({ dirty: true, files_changed: 3, insertions: 42, deletions: 7 }) }) },
  { name: "detached head", worktree: wt("detached", { branch: null, detached: true }) },
  { name: "one agent working", worktree: wt("working"), agents: [agent("working", "claude", "working")] },
  { name: "one agent idle", worktree: wt("resting"), agents: [agent("resting", "claude", "idle")] },
  { name: "turn done", worktree: wt("finished"), agents: [{ ...agent("finished", "claude", "done"), updated_at_ms: Date.now() - 3 * 60_000 }] },
  { name: "needs you", worktree: wt("asking"), agents: [agent("asking", "claude", "waiting")] },
  { name: "agent dead", worktree: wt("crashed"), agents: [agent("crashed", "claude", "dead")] },
  { name: "dead, seen, and one working", worktree: wt("mixed"), agents: [{ ...agent("mixed", "claude", "dead"), seen: true }, agent("mixed", "codex", "working", 1)] },
  { name: "no signal", worktree: wt("silent"), agents: [agent("silent", "pi", "unknown")] },
  { name: "estimated from CPU", worktree: wt("guess"), agents: [{ ...agent("guess", "codex", "working"), estimated: true }] },
  { name: "done, subagent runs", worktree: wt("background"), agents: [{ ...agent("background", "claude", "done"), subagents: [sub("b1", "Explore", "working", "watch the build", 2), sub("b2", "Plan", "exited", "plan the fix", 4)] }] },
  {
    name: "action crashed",
    worktree: wt("storybook"),
    agents: [agent("storybook", "claude", "idle")],
    frame: { seq: 6, event: "actions_changed", data: { set: { worktree_id: "storybook", actions: [{ id: "storybook", label: "storybook", command: "pnpm sample", mode: "pane", show: "topbar", shortcut: null }, { id: "serve", label: "serve", command: "pnpm dev", mode: "pane", show: "topbar", shortcut: null }], error: null, from_repo: false } } },
  },
  {
    name: "subagents",
    worktree: wt("fanout"),
    agents: [{ ...agent("fanout", "claude", "working"), subagents: [sub("s1", "Explore", "working", "find the hook table", 3), sub("s2", "Plan", "exited", "plan the status change", 5), sub(null, "general-purpose", "working", "check the reduced-motion guard", 0)] }],
  },
  {
    name: "many subagents",
    worktree: wt("swarm"),
    agents: [{ ...agent("swarm", "claude", "waiting"), subagents: ["a", "b", "c", "d", "e"].map((id, i) => sub(id, "Explore", i === 0 ? "waiting" : "working", `read part ${id} of the docs`, i)) }],
  },
  { name: "asleep after idle", worktree: wt("eepy"), agents: [{ ...agent("eepy", "claude", "idle"), sleep: "asleep", updated_at_ms: Date.now() - 2 * 3600_000 }] },
  { name: "asleep after done", worktree: wt("eepy-done"), agents: [{ ...agent("eepy-done", "claude", "done"), sleep: "asleep" }, { ...agent("eepy-done", "codex", "idle", 1), sleep: "asleep" }] },
  { name: "one awake, one asleep", worktree: wt("half-eepy"), agents: [{ ...agent("half-eepy", "claude", "done"), sleep: "asleep" }, agent("half-eepy", "codex", "idle", 1)] },
  { name: "three agents", worktree: wt("crowd"), agents: [agent("crowd", "claude", "working"), agent("crowd", "codex", "idle", 1), agent("crowd", "pi", "waiting", 2)] },
  { name: "tags", worktree: wt("tagged", { metadata: { display_name: null, tags: ["checkout", "spike", "review"] } }) },
  { name: "archived", worktree: wt("archived", { archived_at_ms: Date.now() }) },
  { name: "archiving", worktree: wt("busy", { archiving: true }) },
  { name: "directory missing", worktree: wt("gone", { exists: false }) },
  { name: "main worktree", worktree: wt("tomo", { is_main: true }) },
  { name: "pull request open", worktree: wt("pr-open"), frame: { seq: 1, event: "pr_changed", data: { worktree_id: "pr-open", pr: { number: 12, title: "Add the thing", url: "", state: "open", draft: false, review_decision: null, mergeable: "mergeable", checks_passed: 3, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1 } } } },
  { name: "checks failed", worktree: wt("pr-fail"), frame: { seq: 2, event: "pr_changed", data: { worktree_id: "pr-fail", pr: { number: 13, title: "Break the thing", url: "", state: "open", draft: false, review_decision: null, mergeable: "mergeable", checks_passed: 1, checks_failed: 2, checks_pending: 0, fetched_at_ms: 1 } } } },
  { name: "checks running", worktree: wt("pr-run"), frame: { seq: 3, event: "pr_changed", data: { worktree_id: "pr-run", pr: { number: 14, title: "Try the thing", url: "", state: "open", draft: true, review_decision: null, mergeable: null, checks_passed: 0, checks_failed: 0, checks_pending: 4, fetched_at_ms: 1 } } } },
  { name: "linear in review", worktree: wt("linear-review", { branch: "simon/eng-12-add-a-dark-mode-toggle" }), frame: { seq: 5, event: "linear_changed", data: { status: { available: true, reason: null, fetched_at_ms: 1, links: [
    { worktree_id: "linear-review", issue: { identifier: "ENG-12", title: "Add a dark mode toggle", url: "", state: { name: "In Review", kind: "started", color: "#0f783c" }, assignee: "Alex", priority: "Medium" } },
    { worktree_id: "linear-todo", issue: { identifier: "ENG-34", title: "Fix the flaky upload test", url: "", state: { name: "Todo", kind: "unstarted", color: "#e2e2e2" }, assignee: null, priority: "No priority" } },
  ] } } } },
  { name: "linear todo (pale colour)", worktree: wt("linear-todo", { branch: "simon/eng-34-fix-the-flaky-upload-test" }) },
  { name: "merged", worktree: wt("pr-merged"), frame: { seq: 4, event: "pr_changed", data: { worktree_id: "pr-merged", pr: { number: 15, title: "Shipped the thing", url: "", state: "merged", draft: false, review_decision: "approved", mergeable: null, checks_passed: 5, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1 } } } },
];

/**
 * Seeds the store from the scenes once. Every view reads one module-level store, so a
 * fixture is all a part needs to render on its own, with no daemon and no window chrome.
 */
const CRASH = { id: "crash-storybook", worktree_id: "storybook", pane_id: "storybook-action", level: "attention", message: "storybook exited with code 1", created_at_ms: Date.now(), viewed_at_ms: null, kind: "crash", url: null, agent_kind: null, resolved_at_ms: null } as const;

function seed(): void {
  const board = rowBoard(Date.now());
  const worktrees = SCENES.map((s) => s.worktree);
  const agents = [...SCENES.flatMap((s) => s.agents ?? []), ...board.agents];
  const panes = [aPane({ id: CRASH.pane_id, worktree_id: "storybook", live: false, exit_code: 1, source: { kind: "action", id: "storybook", label: "storybook" } }), ...board.panes];
  setState({
    ...getState(),
    loaded: true,
    connected: true,
    config: { ...getState().config, resource_warning_bytes: BOARD_WARN_BYTES } as Config,
    repos: [REPO, BOARD_REPO],
    worktrees: [...worktrees, ...board.worktrees],
    agents: Object.fromEntries(agents.map((a) => [a.pane_id, a])),
    attention: [CRASH, ...board.attention],
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
    rowErrors: board.rowErrors,
    resources: Object.fromEntries(Object.entries(board.rssBytes).map(([id, rss]) => [id, { worktree_id: id, rss_bytes: rss, cpu_percent: 0, process_count: 1 }])),
    ui: { ...defaultUi, view: "home", activeWorktreeId: worktrees[0].id, collapsedRepos: [BOARD_REPO.id] },
  });
  SCENES.forEach((s) => s.frame && applyFrame(s.frame));
  board.frames.forEach(applyFrame);
  const linear = getState().linear;
  if (linear) setState({ linear: { ...linear, links: [...linear.links, ...board.linear] } });
}

/** The rows of the approved Sidebar board, one column in each theme's own panel, and the hover cards beside their rows. */
function RowBoard() {
  const [board] = useState(() => rowBoard(Date.now()));
  const byId = (id: string) => getState().worktrees.find((w) => w.id === id)!;
  const row = (id: string) => <WorktreeRow key={id} w={byId(id)} active={id === board.active} />;
  return (
    <DndContext>
      <SortableContext items={[]}>
        <h2 className="gallery-head">worktree rows</h2>
        <div className="gallery-rows" data-board="rows">{board.worktrees.map((w) => row(w.id))}</div>
        <h2 className="gallery-head">worktree hover cards</h2>
        <div className="gallery-pairs" data-board="hovers">
          {board.hovers.map((id) => (
            <div key={id} className="gallery-pair">
              <div className="gallery-rows">{row(id)}</div>
              <div className="popover preview-card">
                <WorktreePreview w={byId(id)} />
              </div>
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

const nowMs = Date.now();

/** Store changes that the daemon would send, so the motion of the sidebar can be seen and filmed. */
const MOTION: { label: string; run: () => void }[] = [
  { label: "archive crowd", run: () => setState({ worktrees: getState().worktrees.map((w) => (w.id === "crowd" ? { ...w, archived_at_ms: nowMs } : w)) }) },
  { label: "add worktree", run: () => setState({ worktrees: [...getState().worktrees, wt("added")] }) },
  { label: "touch quiet", run: () => setState({ worktrees: getState().worktrees.map((w) => (w.id === "quiet" ? { ...w, last_active_ms: Date.now() + 60_000 } : w)) }) },
  {
    label: "add subagent",
    run: () => {
      const a = getState().agents["fanout-p0"];
      setState({ agents: { ...getState().agents, [a.pane_id]: { ...a, subagents: [...(a.subagents ?? []), sub(`n${a.subagents?.length ?? 0}`, "Explore", "working", "a new task", 0)] } } });
    },
  },
  {
    label: "end turn",
    run: () => {
      const a = getState().agents["fanout-p0"];
      setState({ agents: { ...getState().agents, [a.pane_id]: { ...a, state: "idle", subagents: [] } } });
    },
  },
  {
    label: "finish turn",
    run: () => {
      const a = getState().agents["working-p0"];
      setState({ agents: { ...getState().agents, [a.pane_id]: { ...a, state: a.state === "working" ? "done" : "working", updated_at_ms: Date.now() } } });
    },
  },
  { label: "reset", run: seed },
];

/** The Home layouts. The list shows only for a search or a filter, so the list view filters out archived work. */
const HOME_VIEWS: { label: string; home: Partial<HomeOptions> }[] = [
  { label: "cards", home: { scope: { kind: "repo", repoId: REPO.id }, filters: [] } },
  { label: "list", home: { scope: { kind: "all" }, filters: [{ kind: "archived", value: "no" }], view: "list", group: "none" } },
];

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
      <RowBoard />
      <h2 className="gallery-head">worktree card</h2>
      <div className="gallery-grid">
        {SCENES.map((s) => (
          <figure key={s.name} className="gallery-cell">
            <figcaption className="gallery-caption">{s.name}</figcaption>
            <WorktreeCard w={s.worktree} />
          </figure>
        ))}
      </div>
      <h2 className="gallery-head">worktree header</h2>
      <div className="app gallery-header">
        <WorktreeHeader worktree={SCENES.find((sc) => sc.worktree.id === "storybook")!.worktree} />
      </div>
      <h2 className="gallery-head">sidebar</h2>
      <div className="gallery-picker">
        {MOTION.map((m) => (
          <button key={m.label} type="button" className="seg" onClick={m.run}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="gallery-shells">
        <div className="app gallery-shell" data-shell="open">
          <Sidebar />
          <BottomStrip left="open" />
        </div>
        <div className="app gallery-shell" data-shell="minimal">
          <LeftRail />
          <BottomStrip left="minimal" />
        </div>
      </div>
      <h2 className="gallery-head">home</h2>
      <div className="gallery-picker">
        {HOME_VIEWS.map((v) => (
          <button key={v.label} type="button" className="seg" onClick={() => setUi({ home: { ...getState().ui.home, ...v.home } })}>
            {v.label}
          </button>
        ))}
        {MOTION.map((m) => (
          <button key={m.label} type="button" className="seg" onClick={m.run}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="app gallery-home">
        <Home />
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
