import { ArrowDownUp, ChevronDown, ChevronRight, Ellipsis, Map, Plus, RotateCw } from "lucide-react";
import { useEffect, useMemo } from "react";
import { openWorktree, runAction, toggleRepoCollapsed } from "./actions";
import { Mark } from "./Brand";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "./components/ui";
import { openMenu } from "./MenuHost";
import { needsAttention, sortWorktrees, stateLabel } from "./homeQuery";
import { bulkMenu, repoMenu, worktreeMenu } from "./menus";
import { agentsOf, clearSelection, formatBytes, getState, queryContext, setSelection, setState, setUi, useStore, visibleRepos } from "./store";
import type { AgentPresence, AgentState, Repo, SidebarSort, Worktree } from "./types";

const SORTS: SidebarSort[] = ["name", "recent", "created", "attention", "state"];

export function Sidebar() {
  const repos = useStore(visibleRepos);
  const worktrees = useStore((s) => s.worktrees);
  const selectionSize = useStore((s) => s.selection.size);
  const agents = useStore((s) => s.agents);
  const attention = useStore((s) => s.attention);
  const states = useStore((s) => s.config?.states ?? []);
  const ui = useStore((s) => s.ui);
  const active = ui.view === "worktree" ? ui.activeWorktreeId : null;
  const ctx = useMemo(() => ({ repos, agents: Object.values(agents), attention, states }), [repos, agents, attention, states]);
  const shown = worktrees.filter((w) => ui.showArchivedInSidebar || !w.archived_at_ms);
  const grouped = repos.map((r) => ({ repo: r, items: sortWorktrees(shown.filter((w) => w.repo_id === r.id), ui.sidebarSort, ctx) })).filter((g) => g.items.length || !g.repo.exists);
  const orphans = sortWorktrees(shown.filter((w) => !repos.some((r) => r.id === w.repo_id)), ui.sidebarSort, ctx);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && clearSelection();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const sortMenu = (): MenuItem[] => [
    ...SORTS.map((s) => ({ label: s, checked: ui.sidebarSort === s, run: () => setUi({ sidebarSort: s }) })),
    { separator: true },
    { label: "show archived", checked: ui.showArchivedInSidebar, run: () => setUi({ showArchivedInSidebar: !ui.showArchivedInSidebar }) },
    { label: "show hidden repos", checked: ui.showHiddenRepos, run: () => setUi({ showHiddenRepos: !ui.showHiddenRepos }) },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <Mark size={14} />
        <button className={`side-btn${ui.view === "home" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "home" })}>home</button>
        <IconButton label="Japan map" className={`side-btn${ui.view === "towns" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "towns" })}><Map className="icon" /></IconButton>
        <span className="spacer" />
        <DropdownMenu>
          <DropdownMenuTrigger render={<IconButton label={`Sort: ${ui.sidebarSort}`} />}><ArrowDownUp className="icon" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><MenuItems items={sortMenu} /></DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Add repository" onClick={() => setState({ dialog: { kind: "add-repo" } })}><Plus className="icon" /></IconButton>
        <IconButton label="Refresh repositories and worktrees" onClick={() => runAction("refresh")}><RotateCw className="icon" /></IconButton>
      </div>
      <div className="sidebar-scroll">
        {selectionSize > 0 && (
          <div className="selection-bar">
            <span>{selectionSize} selected</span>
            <button className="link" onClick={clearSelection}>clear</button>
          </div>
        )}
        {grouped.map(({ repo, items }) => (
          <RepoGroup key={repo.id} repo={repo} items={items} active={active} />
        ))}
        {orphans.length > 0 && <RepoGroup repo={{ id: "", name: "other", path: "", exists: true, remote_url: null, github: null }} items={orphans} active={active} />}
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
  const collapsed = useStore((s) => s.ui.collapsedRepos.includes(repo.id));
  const hidden = useStore((s) => s.ui.hiddenRepos.includes(repo.id));
  const attention = useStore((s) => items.some((w) => needsAttention(w, queryContext(s))));
  const toggle = () => repo.id && toggleRepoCollapsed(repo.id);
  return (
    <div className="repo-group">
      <div className="section-label repo-head" onContextMenu={(e) => repo.id && openMenu(e, repoMenu(repo))}>
        <span className="repo-toggle" onClick={toggle}>{collapsed ? <ChevronRight className="icon chevron" /> : <ChevronDown className="icon chevron" />}</span>
        <RepoAvatar repo={repo} />
        <span className="repo-name" onClick={toggle}>{repo.name}</span>
        {!repo.exists && <span className="faint">missing</span>}
        {hidden && <span className="faint">hidden</span>}
        {collapsed && <span className="faint">{items.length}</span>}
        {collapsed && attention && <span className="state state-waiting" />}
        {repo.id && <IconButton label="New worktree" onClick={() => setState({ dialog: { kind: "create-worktree", repoId: repo.id } })}><Plus className="icon" /></IconButton>}
      </div>
      {!collapsed && items.map((w) => (
        <WorktreeRow key={w.id} w={w} active={w.id === active} siblings={items} />
      ))}
    </div>
  );
}

export function RepoAvatar({ repo, size = 14 }: { repo: Repo; size?: number }) {
  if (!repo.github) return null;
  return <img className="repo-avatar" width={size} height={size} src={`https://github.com/${repo.github.owner}.png?size=64`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />;
}

function selectRow(e: React.MouseEvent, w: Worktree, siblings: Worktree[]): boolean {
  const s = getState();
  if (e.metaKey) {
    const next = new Set(s.selection);
    if (next.has(w.id)) next.delete(w.id);
    else next.add(w.id);
    setSelection(next, w.id);
    return true;
  }
  if (e.shiftKey) {
    const ids = siblings.map((x) => x.id);
    const a = ids.indexOf(s.selectionAnchor ?? "");
    const b = ids.indexOf(w.id);
    const range = a >= 0 ? ids.slice(Math.min(a, b), Math.max(a, b) + 1) : [w.id];
    setSelection(new Set([...s.selection, ...range]), s.selectionAnchor ?? w.id);
    return true;
  }
  clearSelection();
  return false;
}

export function summarizeState(agents: AgentPresence[], attention: boolean): AgentState | "none" {
  if (attention || agents.some((a) => a.state === "waiting")) return "waiting";
  if (agents.some((a) => a.state === "working")) return "working";
  if (agents.some((a) => a.state === "idle")) return "idle";
  if (agents.some((a) => a.state === "unknown")) return "unknown";
  return "none";
}

export function WorktreeRow({ w, active, siblings = [] }: { w: Worktree; active: boolean; siblings?: Worktree[] }) {
  const selected = useStore((s) => s.selection.has(w.id));
  const agents = useStore((s) => agentsOf(s, w.id));
  const attention = useStore((s) => needsAttention(w, queryContext(s)));
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const res = useStore((s) => s.resources[w.id]);
  const threshold = useStore((s) => s.config?.resource_warning_bytes ?? Infinity);
  const hot = res && res.rss_bytes >= threshold;
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const summary = archived ? "none" : summarizeState(agents, attention);
  return (
    <div
      className={`wt-row${active ? " wt-active" : ""}${w.exists || archived ? "" : " wt-missing"}${archived ? " wt-archived" : ""}${busy ? " wt-archiving" : ""}${selected ? " wt-selected" : ""}`}
      onClick={(e) => { if (!selectRow(e, w, siblings) && !archived && !busy) openWorktree(w.id); }}
      onContextMenu={(e) => {
        const sel = getState().selection;
        openMenu(e, sel.size > 1 && sel.has(w.id) ? bulkMenu([...sel]) : worktreeMenu(w));
      }}
    >
      <span className={`state state-${busy ? "archiving" : summary}${selected ? " state-selected" : ""}`} />
      <span className="wt-name">{w.name}</span>
      <span className="wt-meta">
        {hot && <span className="hot">{formatBytes(res.rss_bytes)}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger render={<IconButton label="More" className="wt-more" onClick={(e) => e.stopPropagation()} />}><Ellipsis className="icon" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><MenuItems items={() => worktreeMenu(w)} /></DropdownMenuContent>
        </DropdownMenu>
      </span>
      <span className="wt-branch" title={w.path}>
        {busy ? <span className="wt-state">archiving… · </span> : archived ? "archived · " : state ? <span className="wt-state">{state} · </span> : null}{branch}
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
