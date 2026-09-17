import { GitBranch, ListFilter, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { addonApps, branchMark } from "./addons";
import { Wordmark } from "./Brand";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useMemo, useState, type ReactNode } from "react";
import { openWorktree, setMetadata } from "./actions";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "./components/ui";
import { homeEmpty } from "./emptyStates";
import { RowError } from "./RowError";
import { EmptyState } from "./states";
import { openMenu } from "./MenuHost";
import { NO_STATE, filterWorktrees, groupWorktrees, needsAttention, orderedStates, sortWorktrees, stateLabel } from "./homeQuery";
import { greeting, repoSummaries, scopeKind, scopeTitle, scopeWorktrees, statusLine, tally } from "./homeScope";
import { durationLabel } from "./previewModel";
import { repoMenu, worktreeMenu } from "./menus";
import { Signals } from "./Signals";
import { agentStatus, dotClass, tintClass } from "./glyphs";
import { ProcessIcon } from "./ProcessIcon";
import { agentsOf, queryContext, repoName, setState, setUi, useStore, visibleRepos } from "./store";
import { RepoAvatar } from "./Sidebar";
import { summarizeState } from "./Sidebar";
import type { Filter, FilterKind, HomeOptions, Worktree } from "./types";

/** A card draws its agents as tinted provider icons, so the signal list leaves them out. */
const AGENT_SIGNALS = ["agent"] as const;

const KIND_LABEL: Record<FilterKind, string> = { state: "state", repo: "repo", project: "project", tag: "tag", agent: "agent", archived: "archived", attention: "attention" };

export function Home() {
  const s = useStore((x) => x);
  const o = s.ui.home;
  const set = (patch: Partial<HomeOptions>) => setUi({ home: { ...o, ...patch } });
  const ctx = useMemo(() => queryContext(s), [s.repos, s.agents, s.attention, s.config?.states]);
  const repos = visibleRepos(s);
  const known = s.worktrees.filter((w) => (repos.some((r) => r.id === w.repo_id) || !s.repos.some((r) => r.id === w.repo_id)) && (s.ui.showMain || !w.is_main));
  const inScope = scopeWorktrees(known, o.scope);
  const visible = sortWorktrees(filterWorktrees(inScope, o, ctx), o.sort, ctx);
  const searching = o.query.trim().length > 0 || o.filters.length > 0;
  const overview = o.scope.kind === "all" && !searching;
  const apps = addonApps(s);
  const counts = tally(inScope, ctx, apps);
  const scope = o.scope;
  const scopeRepo = scope.kind === "repo" ? repos.find((r) => r.id === scope.repoId) : undefined;
  const repoFor = (key: string) => (o.group === "repo" ? repos.find((r) => r.name === key) : undefined);
  const groups = groupWorktrees(visible, o.group, ctx);
  const empty = homeEmpty(s.repos.length, s.worktrees.filter((w) => !w.archived_at_ms).length, visible.length);
  const stateIdOf = (key: string) => (key === NO_STATE ? null : orderedStates(ctx.states).find((st) => st.label === key)?.id ?? key);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragged, setDragged] = useState<Worktree | null>(null);
  const onDragStart = ({ active }: DragStartEvent) => setDragged(s.worktrees.find((w) => w.id === active.id) ?? null);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragged(null);
    const key = over?.data.current?.key as string | undefined;
    const w = s.worktrees.find((x) => x.id === active.id);
    if (w && key !== undefined && w.metadata.state !== stateIdOf(key)) setMetadata(w.id, { state: stateIdOf(key) });
  };

  const addFilter = (f: Filter) => set({ filters: o.filters.some((x) => x.kind === f.kind && x.value === f.value) ? o.filters : [...o.filters, f] });
  const removeFilter = (f: Filter) => set({ filters: o.filters.filter((x) => !(x.kind === f.kind && x.value === f.value)) });
  const values = (kind: FilterKind): { value: string; label: string }[] => {
    switch (kind) {
      case "state":
        return orderedStates(ctx.states).map((st) => ({ value: st.id, label: st.label })).concat({ value: "", label: "no state" });
      case "repo":
        return s.repos.map((r) => ({ value: r.id, label: r.name }));
      case "project":
        return [...new Set(s.worktrees.map((w) => w.metadata.project).filter((p): p is string => !!p))].sort().map((p) => ({ value: p, label: p }));
      case "tag":
        return [...new Set(s.worktrees.flatMap((w) => w.metadata.tags))].sort().map((t) => ({ value: t, label: `#${t}` }));
      case "agent":
        return ["waiting", "working", "idle", "none"].map((v) => ({ value: v, label: v }));
      case "archived":
        return [{ value: "yes", label: "archived" }, { value: "no", label: "active" }];
      case "attention":
        return [{ value: "yes", label: "needs attention" }];
    }
  };
  const filterMenu = (): MenuItem[] =>
    (Object.keys(KIND_LABEL) as FilterKind[]).map((kind) => ({
      label: KIND_LABEL[kind],
      submenu: values(kind).map((v) => ({ label: v.label, checked: o.filters.some((f) => f.kind === kind && f.value === v.value), run: () => addFilter({ kind, value: v.value }) })),
    }));
  const displayMenu = (): MenuItem[] => [
    { label: "view", submenu: (["list", "board"] as const).map((v) => ({ label: v, checked: o.view === v, run: () => set({ view: v }) })) },
    { label: "group by", submenu: (["state", "repo", "project", "none"] as const).map((g) => ({ label: g, checked: o.group === g, run: () => set({ group: g }) })) },
    { label: "sort", submenu: (["state", "recent", "created", "name"] as const).map((v) => ({ label: v, checked: o.sort === v, run: () => set({ sort: v }) })) },
    { separator: true },
    { label: "show main worktree", checked: s.ui.showMain, run: () => setUi({ showMain: !s.ui.showMain }) },
    { label: "show archived", checked: o.showArchived, run: () => set({ showArchived: !o.showArchived }) },
  ];
  const label = (f: Filter) => {
    const v = values(f.kind).find((x) => x.value === f.value);
    return `${KIND_LABEL[f.kind]}: ${v?.label ?? f.value}`;
  };

  return (
    <div className="home">
      <div className="home-bar">
        <label className="home-search">
          <Search className="icon" />
          <input placeholder="search worktrees, branches, projects, tags" value={o.query} onChange={(e) => set({ query: e.target.value })} autoFocus />
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger className="ghost"><ListFilter className="icon" /> filter</DropdownMenuTrigger>
          <DropdownMenuContent><MenuItems items={filterMenu} /></DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger className="ghost"><SlidersHorizontal className="icon" /> display</DropdownMenuTrigger>
          <DropdownMenuContent><MenuItems items={displayMenu} /></DropdownMenuContent>
        </DropdownMenu>
        {o.filters.map((f) => (
          <span key={`${f.kind}:${f.value}`} className="chip rise">
            {label(f)}
            <IconButton label="Remove filter" onClick={() => removeFilter(f)}><X className="icon" /></IconButton>
          </span>
        ))}
        {(o.query || o.filters.length > 0) && <button className="link" onClick={() => set({ query: "", filters: [] })}>clear</button>}
        <span className="spacer" />
        <span className="faint">{visible.length} of {s.worktrees.length}</span>
      </div>
      {o.scope.kind !== "all" && (
        <div className="scope-head">
          <span className="scope-kind">{scopeKind(o.scope)}</span>
          <span className="scope-title">{scopeTitle(o.scope, s.repos)}</span>
          {scopeRepo && <span className="scope-path">{scopeRepo.path}</span>}
          <span className="spacer" />
          <span className="faint">{counts.worktrees} worktrees · {counts.agents} agents{counts.attention > 0 ? ` · ${counts.attention} need you` : ""}</span>
          <button className="link" onClick={() => set({ scope: { kind: "all" } })}>all work</button>
        </div>
      )}
      {overview && repos.length > 0 && (
        <div className="repo-ledger">
          <div className="home-greet">
            <h2 className="home-hello">{greeting(new Date().getHours())}</h2>
            <p className="home-status">{statusLine(counts)}</p>
          </div>
          <div className="repo-list">
            <div className="repo-list-head"><span /><span>repository</span><span>worktrees</span><span>agents</span><span>apps</span><span>last activity</span></div>
            {repoSummaries(inScope, repos, ctx, apps).map((r) => (
              <div key={r.repo.id} className="repo-list-row" title={r.repo.path} onClick={() => set({ scope: { kind: "repo", repoId: r.repo.id } })} onContextMenu={(e) => openMenu(e, repoMenu(r.repo))}>
                <RepoAvatar repo={r.repo} />
                <span className="name">{r.repo.name}{!r.repo.exists && <span className="faint"> · missing</span>}</span>
                <span className="num">{r.worktrees}</span>
                <span className="num">{r.agents}{r.attention > 0 && <span className={dotClass("needs")} />}</span>
                <span className="num">{r.apps}</span>
                <span className="muted">{r.lastActiveMs === null ? "—" : `${durationLabel(r.lastActiveMs)} ago`}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {empty === "no-repos" && (
        <div className="home-empty rise">
          <Wordmark height={28} />
          <EmptyState title="No repositories yet." detail="Add a Git repository. Tomo finds its worktrees." action={<Button variant="default" onClick={() => setState({ dialog: { kind: "add-repo" } })}>Add repository</Button>} />
        </div>
      )}
      {o.scope.kind === "all" && empty === "no-worktrees" && <EmptyState title="No active worktrees." action={<Button variant="default" onClick={() => setState({ dialog: { kind: "create-worktree" } })}>New worktree</Button>} />}
      {o.scope.kind !== "all" && visible.length === 0 && !searching && <EmptyState title="No worktrees." action={<Button variant="default" onClick={() => setState({ dialog: { kind: "create-worktree", repoId: scopeRepo?.id } })}>New worktree</Button>} />}
      {searching && visible.length === 0 && <EmptyState title="No worktrees match." action={<Button variant="link" onClick={() => set({ query: "", filters: [] })}>clear search and filters</Button>} />}
      {!overview && (o.view === "board" ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragged(null)}>
          <div className="board">
            {groups.map((g) => (
              <BoardColumn key={g.key || "all"} groupKey={g.key} droppable={o.group === "state"}>
                <div className="section-label">{repoFor(g.key) && <RepoAvatar repo={repoFor(g.key)!} />}{g.key || "all"}<span className="right">{g.items.length}</span></div>
                <div className="board-cards">{g.items.map((w) => <Card key={w.id} w={w} draggable={o.group === "state"} />)}</div>
              </BoardColumn>
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragged && (
              <div className="card card-overlay">
                <div className="card-title"><span className="state state-none" /><span className="name">{dragged.name}</span></div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      ) : (
        groups.map((g) => (
          <section key={g.key || "all"} className="home-group">
            {g.key && <div className="section-label">{repoFor(g.key) && <RepoAvatar repo={repoFor(g.key)!} />}{g.key}<span className="right">{g.items.length}</span></div>}
            <div className="wt-list">{g.items.map((w) => <Row key={w.id} w={w} />)}</div>
          </section>
        ))
      ))}
    </div>
  );
}

function Row({ w }: { w: Worktree }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const repo = useStore((s) => repoName(s, w.repo_id));
  const attention = useStore((s) => needsAttention(w, queryContext(s)));
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const g = w.git;
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const summary = summarizeState(agents, attention);
  return (
    <div
      className={`wt-list-row${attention ? " row-attention" : ""}${w.exists || archived ? "" : " row-missing"}${archived ? " row-archived" : ""}${busy ? " row-archiving" : ""}`}
      onClick={() => !archived && !busy && openWorktree(w.id)}
      onContextMenu={(e) => openMenu(e, worktreeMenu(w))}
      title={w.path}
    >
      <span className={busy ? "state state-archiving" : dotClass(archived ? null : agentStatus(summary))} />
      <span className="name">{w.name}{w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}</span>
      <span className="muted">{w.metadata.project ?? repo}</span>
      <span className="muted">{busy ? "archiving..." : archived ? "archived" : (state ?? "")}</span>
      <span className="branch">{branch}{g?.dirty ? " *" : ""}{!w.exists && !archived ? " · missing" : ""}</span>
      <span className="agents">
        <RowError worktreeId={w.id} />
        {!archived && <Signals worktreeId={w.id} className="signals" />}
        {w.metadata.tags.length > 0 && <span className="tag">{w.metadata.tags.map((t) => `#${t}`).join(" ")}</span>}
      </span>
      <span className="runtime">
        {g && (g.insertions > 0 || g.deletions > 0) && <span><span className="ins">+{g.insertions}</span> <span className="del">−{g.deletions}</span></span>}
      </span>
    </div>
  );
}

/** A drop between columns only sets `worktree.state`. Order inside a column stays the configured sort. */
function BoardColumn({ groupKey, droppable, children }: { groupKey: string; droppable: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${groupKey}`, data: { key: groupKey }, disabled: !droppable });
  return (
    <section ref={setNodeRef} className={`board-col${isOver ? " board-col-over" : ""}`}>
      {children}
    </section>
  );
}

function Card({ w, draggable = false }: { w: Worktree; draggable?: boolean }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const repo = useStore((s) => repoName(s, w.repo_id));
  const attention = useStore((s) => needsAttention(w, queryContext(s)));
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const mark = useStore((s) => branchMark(s, w));
  const g = w.git;
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const sub = [w.metadata.project ?? repo, busy ? "archiving..." : archived ? "archived" : state].filter(Boolean).join(" · ");
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const summary = summarizeState(agents, attention);
  const drag = useDraggable({ id: w.id, disabled: !draggable || archived || busy });
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      className={`card rise${attention ? " card-attention" : ""}${w.exists || archived ? "" : " card-missing"}${archived ? " card-archived" : ""}${busy ? " card-archiving" : ""}${drag.isDragging ? " card-dragging" : ""}`}
      onClick={() => !archived && !busy && openWorktree(w.id)}
      onContextMenu={(e) => openMenu(e, worktreeMenu(w))}
      title={[w.path, state ? `state: ${state}` : null, busy ? "archiving..." : null].filter(Boolean).join("\n")}
    >
      <div className="card-title">
        <span className={busy ? "state state-archiving" : dotClass(archived ? null : agentStatus(summary))} />
        <span className="name">{w.name}{w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}</span>
      </div>
      {branch && (
        <div className="card-branch" title={mark ? `${branch} — ${mark.text}` : branch}>
          <GitBranch className={`icon branch-${mark?.tone ?? "plain"}`} aria-label={mark?.text ?? "branch"} />
          <span className="card-branch-name">{branch}</span>
          {g?.dirty && <span className="card-dirty" aria-label="uncommitted changes">*</span>}
        </div>
      )}
      <div className="card-sub">{sub}{!w.exists && !archived && " · missing"}</div>
      {!archived && agents.length > 0 && (
        <div className="card-agents">
          {agents.map((a) => <ProcessIcon key={a.pane_id} agent={a.kind} size={13} className={tintClass(agentStatus(a.state))} />)}
        </div>
      )}
      {w.metadata.tags.length > 0 && <div className="card-tags">{w.metadata.tags.map((t) => <span key={t} className="tag-chip">#{t}</span>)}</div>}
      {!archived && <Signals worktreeId={w.id} className="card-signals" omit={AGENT_SIGNALS} />}
      <RowError worktreeId={w.id} />
      {g && (g.insertions > 0 || g.deletions > 0) && (
        <div className="card-foot">
          <span><span className="ins">+{g.insertions}</span> <span className="del">−{g.deletions}</span></span>
        </div>
      )}
    </div>
  );
}
