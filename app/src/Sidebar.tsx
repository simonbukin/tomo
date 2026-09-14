import { ArrowDownUp, Ellipsis, Map, Plus, RotateCw } from "lucide-react";
import { useMemo, useRef } from "react";
import { openWorktree, runAction } from "./actions";
import { openMenu, openMenuAt, type MenuItem } from "./ContextMenu";
import { needsAttention, sortWorktrees, type QueryContext } from "./homeQuery";
import { repoMenu, worktreeMenu } from "./menus";
import { agentsOf, formatBytes, setState, setUi, useStore } from "./store";
import type { AgentPresence, AgentState, Repo, SidebarSort, Worktree } from "./types";

const SORTS: SidebarSort[] = ["name", "recent", "created", "attention", "priority"];

export function Sidebar() {
  const repos = useStore((s) => s.repos);
  const worktrees = useStore((s) => s.worktrees);
  const agents = useStore((s) => s.agents);
  const attention = useStore((s) => s.attention);
  const ui = useStore((s) => s.ui);
  const active = ui.view === "worktree" ? ui.activeWorktreeId : null;
  const ctx: QueryContext = useMemo(() => ({ repos, agents: Object.values(agents), attention }), [repos, agents, attention]);
  const shown = worktrees.filter((w) => ui.showArchivedInSidebar || !w.archived_at_ms);
  const grouped = repos.map((r) => ({ repo: r, items: sortWorktrees(shown.filter((w) => w.repo_id === r.id), ui.sidebarSort, ctx) })).filter((g) => g.items.length || !g.repo.exists);
  const orphans = sortWorktrees(shown.filter((w) => !repos.some((r) => r.id === w.repo_id)), ui.sidebarSort, ctx);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const sortMenu = (): MenuItem[] => [
    ...SORTS.map((s) => ({ label: s, checked: ui.sidebarSort === s, run: () => setUi({ sidebarSort: s }) })),
    { separator: true },
    { label: "show archived", checked: ui.showArchivedInSidebar, run: () => setUi({ showArchivedInSidebar: !ui.showArchivedInSidebar }) },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className={`side-btn${ui.view === "home" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "home" })}>home</button>
        <button className={`side-btn${ui.view === "towns" ? " side-btn-active" : ""}`} title="Japan map" onClick={() => setUi({ view: "towns" })}><Map className="icon" /></button>
        <span className="spacer" />
        <button ref={sortBtn} className="ghost" title={`sort: ${ui.sidebarSort}`} onClick={() => openMenuAt(sortBtn.current!, sortMenu())}><ArrowDownUp className="icon" /></button>
        <button className="ghost" title="Add repository" onClick={() => setState({ dialog: { kind: "add-repo" } })}><Plus className="icon" /></button>
        <button className="ghost" title="Refresh repositories and worktrees" onClick={() => runAction("refresh")}><RotateCw className="icon" /></button>
      </div>
      <div className="sidebar-scroll">
        {grouped.map(({ repo, items }) => (
          <RepoGroup key={repo.id} repo={repo} items={items} active={active} />
        ))}
        {orphans.length > 0 && <RepoGroup repo={{ id: "", name: "other", path: "", exists: true }} items={orphans} active={active} />}
        {repos.length === 0 && (
          <div className="sidebar-empty">
            No repositories yet. Add one with the plus button or run <code>tomo repo add &lt;path&gt;</code>.
          </div>
        )}
      </div>
      <ResizeHandle side="left" />
    </aside>
  );
}

export function ResizeHandle({ side }: { side: "left" | "right" }) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const app = document.querySelector<HTMLElement>(".app");
    const startWidth = currentWidth(side);
    let latest = startWidth;
    document.body.classList.add("resizing-h", "no-anim");
    const move = (ev: MouseEvent) => {
      const delta = side === "left" ? ev.clientX - start : start - ev.clientX;
      latest = Math.min(480, Math.max(180, startWidth + delta));
      app?.style.setProperty(side === "left" ? "--left-w" : "--right-w", `${latest}px`);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-h", "no-anim");
      setUi(side === "left" ? { leftWidth: latest } : { rightWidth: latest });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className={`resize-handle resize-${side}`} onMouseDown={onMouseDown} />;
}

function currentWidth(side: "left" | "right"): number {
  const el = document.querySelector<HTMLElement>(side === "left" ? ".sidebar" : ".rightbar");
  return el?.getBoundingClientRect().width ?? 240;
}

function RepoGroup({ repo, items, active }: { repo: Repo; items: Worktree[]; active: string | null }) {
  return (
    <div className="repo-group">
      <div className="section-label repo-head" onContextMenu={(e) => repo.id && openMenu(e, repoMenu(repo))}>
        <span>{repo.name}</span>
        {!repo.exists && <span className="faint">missing</span>}
        {repo.id && <button className="ghost" title="New worktree" onClick={() => setState({ dialog: { kind: "create-worktree", repoId: repo.id } })}><Plus className="icon" /></button>}
      </div>
      {items.map((w) => (
        <WorktreeRow key={w.id} w={w} active={w.id === active} />
      ))}
    </div>
  );
}

export function summarizeState(agents: AgentPresence[], attention: boolean): AgentState | "none" {
  if (attention || agents.some((a) => a.state === "waiting")) return "waiting";
  if (agents.some((a) => a.state === "working")) return "working";
  if (agents.some((a) => a.state === "idle")) return "idle";
  if (agents.some((a) => a.state === "unknown")) return "unknown";
  return "none";
}

export function WorktreeRow({ w, active }: { w: Worktree; active: boolean }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const attention = useStore((s) => needsAttention(w, { repos: s.repos, agents: Object.values(s.agents), attention: s.attention }));
  const res = useStore((s) => s.resources[w.id]);
  const threshold = useStore((s) => s.config?.resource_warning_bytes ?? Infinity);
  const hot = res && res.rss_bytes >= threshold;
  const archived = !!w.archived_at_ms;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const summary = archived ? "none" : summarizeState(agents, attention);
  const menuBtn = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={`wt-row${active ? " wt-active" : ""}${w.exists || archived ? "" : " wt-missing"}${archived ? " wt-archived" : ""}`}
      onClick={() => !archived && openWorktree(w.id)}
      onContextMenu={(e) => openMenu(e, worktreeMenu(w))}
      title={w.path}
    >
      <span className={`state state-${summary}`} />
      <span className="wt-name">{w.name}</span>
      <span className="wt-meta">
        {w.metadata.priority && <span className={`prio prio-${w.metadata.priority}`}>p{w.metadata.priority}</span>}
        {hot && <span className="hot">{formatBytes(res.rss_bytes)}</span>}
        <button ref={menuBtn} className="ghost wt-more" title="More" onClick={(e) => { e.stopPropagation(); openMenuAt(menuBtn.current!, worktreeMenu(w)); }}><Ellipsis className="icon" /></button>
      </span>
      <span className="wt-branch">
        {archived ? "archived · " : ""}{branch}
        {w.git?.dirty ? " *" : ""}
        {w.metadata.tags.length > 0 && <span className="tag"> {w.metadata.tags.map((t) => `#${t}`).join(" ")}</span>}
      </span>
      {agents.length > 0 && (
        <span className="wt-agents">
          {agents.map((a) => (
            <span key={a.pane_id} className={`agent-line is-${a.state}`}>
              <span className={`state state-${a.state}`} />
              <span className="agent-state">{a.state}</span>
              <span className="agent-kind">· {a.kind}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
