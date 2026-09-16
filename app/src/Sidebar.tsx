import { ArrowDownUp, ChevronDown, ChevronRight, Ellipsis, History, Plus, RotateCw, Star } from "lucide-react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { addonViews, repoAvatar } from "./addons";
import { byManualOrder } from "./order";
import { useEffect, useMemo, useRef, useState } from "react";
import { RowError } from "./RowError";
import { Signals } from "./Signals";
import styles from "./WorktreeRow.module.css";
import { agentStatus, dotClass } from "./glyphs";
import { useFlip } from "./useFlip";
import { openWorktree, runAction, toggleRepoCollapsed } from "./actions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "./components/ui";
import { openMenu } from "./MenuHost";
import { needsAttention, sortWorktrees, stateLabel } from "./homeQuery";
import { bulkMenu, repoMenu, worktreeMenu } from "./menus";
import { useShortcuts } from "./shortcuts";
import { agentsOf, clearSelection, getState, needsMe, queryContext, setSelection, setState, setUi, useStore, visibleRepos } from "./store";
import type { AgentPresence, AgentState, Id, Repo, SidebarSort, Worktree } from "./types";

const SORTS: SidebarSort[] = ["name", "recent", "created", "attention", "state", "manual"];

export function Sidebar() {
  const repos = useStore(visibleRepos);
  const worktrees = useStore((s) => s.worktrees);
  const selectionSize = useStore((s) => s.selection.size);
  const agents = useStore((s) => s.agents);
  const attention = useStore((s) => s.attention);
  const states = useStore((s) => s.config?.states ?? []);
  const ui = useStore((s) => s.ui);
  const needCount = useStore((s) => needsMe(s).length);
  const shortcut = useShortcuts();
  const active = ui.view === "worktree" ? ui.activeWorktreeId : null;
  const ctx = useMemo(() => ({ repos, agents: Object.values(agents), attention, states }), [repos, agents, attention, states]);
  const shown = worktrees.filter((w) => ui.showArchivedInSidebar || !w.archived_at_ms);
  const manual = ui.sidebarSort === "manual";
  const orderedRepos = manual ? byManualOrder(repos, ui.repoOrder, (r) => r.id) : repos;
  const grouped = orderedRepos.map((r) => ({ repo: r, items: sortWorktrees(shown.filter((w) => w.repo_id === r.id), ui.sidebarSort, ctx, ui.manualOrder[r.id] ?? []) })).filter((g) => g.items.length || !g.repo.exists);
  const orphans = sortWorktrees(shown.filter((w) => !repos.some((r) => r.id === w.repo_id)), ui.sidebarSort, ctx);
  const listRef = useRef<HTMLDivElement>(null);
  const order = [...grouped.flatMap((g) => g.items), ...orphans].map((w) => w.id).join(",");
  const [dropped, setDropped] = useState(false);
  useFlip(listRef, [order, grouped.map((g) => g.repo.id).join(","), ui.collapsedRepos.join(","), selectionSize], !dropped);
  useEffect(() => {
    if (dropped) setDropped(false);
  }, [dropped]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && clearSelection();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const currentOrder = (): Record<string, Id[]> => (manual ? ui.manualOrder : Object.fromEntries(grouped.map((g) => [g.repo.id, g.items.map((w) => w.id)])));
  const currentRepoOrder = () => grouped.map((g) => g.repo.id);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const from = active.data.current as DragData | undefined;
    const to = over?.data.current as DragData | undefined;
    if (!over || !from || !to || active.id === over.id || from.kind !== to.kind) return;
    if (from.kind === "repo") {
      const ids = currentRepoOrder();
      setDropped(true);
      setUi({ sidebarSort: "manual", manualOrder: currentOrder(), repoOrder: arrayMove(ids, ids.indexOf(from.id), ids.indexOf(to.id)) });
      return;
    }
    if (from.kind === "worktree" && to.kind === "worktree" && from.repoId === to.repoId) {
      const ids = grouped.find((g) => g.repo.id === from.repoId)?.items.map((w) => w.id) ?? [];
      setDropped(true);
      setUi({ sidebarSort: "manual", manualOrder: { ...currentOrder(), [from.repoId]: arrayMove(ids, ids.indexOf(from.id), ids.indexOf(to.id)) }, repoOrder: currentRepoOrder() });
    }
  };
  const sortMenu = (): MenuItem[] => [
    ...SORTS.map((s) => ({ label: s === "manual" ? "manual (drag rows)" : s, checked: ui.sidebarSort === s, run: () => setUi({ sidebarSort: s }) })),
    { separator: true },
    { label: "show archived", checked: ui.showArchivedInSidebar, run: () => setUi({ showArchivedInSidebar: !ui.showArchivedInSidebar }) },
    { label: "show hidden repos", checked: ui.showHiddenRepos, run: () => setUi({ showHiddenRepos: !ui.showHiddenRepos }) },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className={`side-btn${ui.view === "home" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "home" })}>home</button>
        <IconButton label={needCount ? `Activity, ${needCount} need you` : "Activity"} shortcut={shortcut("activity")} className={`side-btn side-activity${ui.view === "activity" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "activity" })}><History className="icon" />{needCount > 0 && <span className="rail-count" aria-hidden>{needCount}</span>}</IconButton>
        {addonViews().map((v) => (
          <IconButton key={v.id} label={v.label} shortcut={shortcut(v.id)} className={`side-btn${ui.view === v.id ? " side-btn-active" : ""}`} onClick={() => setUi({ view: v.id })}><v.icon className="icon" /></IconButton>
        ))}
        <span className="spacer" />
        <DropdownMenu>
          <DropdownMenuTrigger render={<IconButton label={`Sort: ${ui.sidebarSort}`} />}><ArrowDownUp className="icon" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><MenuItems items={sortMenu} /></DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Add repository" shortcut={shortcut("add_repo")} onClick={() => setState({ dialog: { kind: "add-repo" } })}><Plus className="icon" /></IconButton>
        <IconButton label="Refresh repositories and worktrees" shortcut={shortcut("refresh")} onClick={() => runAction("refresh")}><RotateCw className="icon" /></IconButton>
      </div>
      <div className="sidebar-scroll" ref={listRef}>
        {selectionSize > 0 && (
          <div className="selection-bar">
            <span>{selectionSize} selected</span>
            <button className="link" onClick={clearSelection}>clear</button>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]} onDragEnd={onDragEnd}>
          <SortableContext items={grouped.map((g) => repoKey(g.repo.id))} strategy={verticalListSortingStrategy}>
            {grouped.map(({ repo, items }) => (
              <RepoGroup key={repo.id} repo={repo} items={items} active={active} sortable />
            ))}
          </SortableContext>
        </DndContext>
        {orphans.length > 0 && <RepoGroup repo={{ id: "", name: "other", path: "", exists: true, remote_url: null }} items={orphans} active={active} />}
        {repos.length === 0 && (
          <div className="sidebar-empty">
            No repositories yet. Add one with the plus button or run <code>tomo repo add &lt;path&gt;</code>.
          </div>
        )}
      </div>
    </aside>
  );
}

type DragData = { kind: "repo"; id: Id } | { kind: "worktree"; id: Id; repoId: Id };

const repoKey = (id: Id) => `repo:${id}`;

function RepoGroup({ repo, items, active, sortable = false }: { repo: Repo; items: Worktree[]; active: string | null; sortable?: boolean }) {
  const drag = useSortable({ id: repoKey(repo.id), data: { kind: "repo", id: repo.id } satisfies DragData, disabled: !sortable || !repo.id });
  const collapsed = useStore((s) => s.ui.collapsedRepos.includes(repo.id));
  const hidden = useStore((s) => s.ui.hiddenRepos.includes(repo.id));
  const attention = useStore((s) => items.some((w) => needsAttention(w, queryContext(s))));
  const toggle = () => repo.id && toggleRepoCollapsed(repo.id);
  const shortcut = useShortcuts();
  return (
    <div ref={drag.setNodeRef} className={`repo-group${drag.isDragging ? " is-dragging" : ""}`} style={{ transform: CSS.Translate.toString(drag.transform), transition: drag.transition }}>
      <div ref={drag.setActivatorNodeRef} className="section-label repo-head" {...drag.attributes} {...drag.listeners} onContextMenu={(e) => repo.id && openMenu(e, repoMenu(repo))}>
        <span className="repo-toggle" onClick={toggle}>{collapsed ? <ChevronRight className="icon chevron" /> : <ChevronDown className="icon chevron" />}</span>
        <RepoAvatar repo={repo} />
        <span className="repo-name" onClick={toggle}>{repo.name}</span>
        {!repo.exists && <span className="faint">missing</span>}
        {hidden && <span className="faint">hidden</span>}
        {collapsed && <span className="faint">{items.length}</span>}
        {collapsed && attention && <span className={dotClass("needs")} />}
        {repo.id && <IconButton label="New worktree" shortcut={shortcut("create_worktree")} onClick={() => setState({ dialog: { kind: "create-worktree", repoId: repo.id } })}><Plus className="icon" /></IconButton>}
      </div>
      {!collapsed && (
        <SortableContext items={items.filter((w) => !w.is_main && !w.archived_at_ms).map((w) => w.id)} strategy={verticalListSortingStrategy}>
          {items.map((w) => (
            <WorktreeRow key={w.id} w={w} active={w.id === active} siblings={items} sortable={sortable} />
          ))}
        </SortableContext>
      )}
    </div>
  );
}

export function RepoAvatar({ repo, size = 14 }: { repo: Repo; size?: number }) {
  const Avatar = repoAvatar();
  return Avatar && <Avatar repo={repo} size={size} />;
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

export function WorktreeRow({ w, active, siblings = [], sortable = false }: { w: Worktree; active: boolean; siblings?: Worktree[]; sortable?: boolean }) {
  const drag = useSortable({ id: w.id, data: { kind: "worktree", id: w.id, repoId: w.repo_id } satisfies DragData, disabled: !sortable || w.is_main || !!w.archived_at_ms });
  const selected = useStore((s) => s.selection.has(w.id));
  const agents = useStore((s) => agentsOf(s, w.id));
  const attention = useStore((s) => needsAttention(w, queryContext(s)));
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const summary = archived ? "none" : summarizeState(agents, attention);
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      style={{ transform: CSS.Translate.toString(drag.transform), transition: drag.transition }}
      data-flip={w.id}
      className={["wt-row", styles.row, drag.isDragging && styles.dragging, active && styles.active, !w.exists && !archived && styles.missing, archived && styles.archived, busy && styles.archiving, selected && styles.selected].filter(Boolean).join(" ")}
      onClick={(e) => { if (!selectRow(e, w, siblings) && !archived && !busy) openWorktree(w.id); }}
      onContextMenu={(e) => {
        const sel = getState().selection;
        openMenu(e, sel.size > 1 && sel.has(w.id) ? bulkMenu([...sel]) : worktreeMenu(w));
      }}
    >
      <span className={`${busy ? "state state-archiving" : dotClass(agentStatus(summary))}${selected ? " state-selected" : ""}`} />
      <span className={styles.nameLine}>
        <span className={styles.name}>{w.name}</span>
        {w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}
      </span>
      <span className={styles.meta}>
        <RowError worktreeId={w.id} />
        <DropdownMenu>
          <DropdownMenuTrigger render={<IconButton label="More" className={styles.more} onClick={(e) => e.stopPropagation()} />}><Ellipsis className="icon" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><MenuItems items={() => worktreeMenu(w)} /></DropdownMenuContent>
        </DropdownMenu>
      </span>
      <span className={styles.sub}>
        <span className={styles.branch} title={w.path}>
          {busy ? <span className={styles.stateLabel}>archiving… · </span> : archived ? "archived · " : state ? <span className={styles.stateLabel}>{state} · </span> : null}{branch}
          {w.git?.dirty ? " *" : ""}
          {w.metadata.tags.length > 0 && <span className="tag"> {w.metadata.tags.map((t) => `#${t}`).join(" ")}</span>}
        </span>
        <span className={styles.signalArea}>{archived ? null : <Signals worktreeId={w.id} />}</span>
      </span>
    </div>
  );
}
