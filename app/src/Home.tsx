import { ListFilter, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { Wordmark } from "./Brand";
import { useMemo, useState } from "react";
import { openWorktree, setMetadata } from "./actions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "./components/ui";
import { openMenu } from "./MenuHost";
import { NO_STATE, filterWorktrees, groupWorktrees, needsAttention, orderedStates, sortWorktrees, stateLabel } from "./homeQuery";
import { worktreeMenu } from "./menus";
import { Signals } from "./Signals";
import { agentStatus, dotClass } from "./glyphs";
import { agentsOf, queryContext, repoName, setState, setUi, useStore, visibleRepos } from "./store";
import { RepoAvatar } from "./Sidebar";
import { summarizeState } from "./Sidebar";
import type { Filter, FilterKind, HomeOptions, Worktree } from "./types";

const KIND_LABEL: Record<FilterKind, string> = { state: "state", repo: "repo", project: "project", tag: "tag", agent: "agent", archived: "archived", attention: "attention" };

export function Home() {
  const s = useStore((x) => x);
  const o = s.ui.home;
  const set = (patch: Partial<HomeOptions>) => setUi({ home: { ...o, ...patch } });
  const ctx = useMemo(() => queryContext(s), [s.repos, s.agents, s.attention, s.config?.states]);
  const repos = visibleRepos(s);
  const visible = sortWorktrees(filterWorktrees(s.worktrees.filter((w) => repos.some((r) => r.id === w.repo_id) || !s.repos.some((r) => r.id === w.repo_id)), o, ctx), o.sort, ctx);
  const repoFor = (key: string) => (o.group === "repo" ? repos.find((r) => r.name === key) : undefined);
  const groups = groupWorktrees(visible, o.group, ctx);
  const [over, setOver] = useState<string | null>(null);
  const stateIdOf = (key: string) => (key === NO_STATE ? null : orderedStates(ctx.states).find((st) => st.label === key)?.id ?? key);
  const dropTo = (key: string, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const w = s.worktrees.find((x) => x.id === id);
    if (w && w.metadata.state !== stateIdOf(key)) setMetadata(id, { state: stateIdOf(key) });
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
      {s.worktrees.length === 0 && (
        <div className="home-empty rise">
          <Wordmark height={28} />
          <p>No worktrees yet.</p>
          <button onClick={() => setState({ dialog: { kind: "add-repo" } })}>Add a repository</button>
        </div>
      )}
      {o.view === "board" ? (
        <div className="board">
          {groups.map((g) => (
            <section
              key={g.key || "all"}
              className={`board-col${over === g.key ? " board-col-over" : ""}`}
              onDragOver={(e) => { if (o.group === "state") { e.preventDefault(); setOver(g.key); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
              onDrop={(e) => o.group === "state" && dropTo(g.key, e)}
            >
              <div className="section-label">{repoFor(g.key) && <RepoAvatar repo={repoFor(g.key)!} />}{g.key || "all"}<span className="right">{g.items.length}</span></div>
              <div className="board-cards">{g.items.map((w) => <Card key={w.id} w={w} draggable={o.group === "state"} />)}</div>
            </section>
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key || "all"} className="home-group">
            {g.key && <div className="section-label">{repoFor(g.key) && <RepoAvatar repo={repoFor(g.key)!} />}{g.key}<span className="right">{g.items.length}</span></div>}
            <div className="wt-list">{g.items.map((w) => <Row key={w.id} w={w} />)}</div>
          </section>
        ))
      )}
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
      <span className="muted">{busy ? "archiving…" : archived ? "archived" : (state ?? "")}</span>
      <span className="branch">{branch}{g?.dirty ? " *" : ""}{!w.exists && !archived ? " · missing" : ""}</span>
      <span className="agents">
        {!archived && <Signals worktreeId={w.id} className="signals" />}
        {w.metadata.tags.length > 0 && <span className="tag">{w.metadata.tags.map((t) => `#${t}`).join(" ")}</span>}
      </span>
      <span className="runtime">
        {g && (g.insertions > 0 || g.deletions > 0) && <span><span className="ins">+{g.insertions}</span> <span className="del">−{g.deletions}</span></span>}
      </span>
    </div>
  );
}

function Card({ w, draggable = false }: { w: Worktree; draggable?: boolean }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const repo = useStore((s) => repoName(s, w.repo_id));
  const attention = useStore((s) => needsAttention(w, queryContext(s)));
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const g = w.git;
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const sub = [w.metadata.project ?? repo, busy ? "archiving…" : archived ? "archived" : state].filter(Boolean).join(" · ");
  const summary = summarizeState(agents, attention);
  return (
    <div
      className={`card rise${attention ? " card-attention" : ""}${w.exists || archived ? "" : " card-missing"}${archived ? " card-archived" : ""}${busy ? " card-archiving" : ""}`}
      draggable={draggable && !archived && !busy}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", w.id)}
      onClick={() => !archived && !busy && openWorktree(w.id)}
      onContextMenu={(e) => openMenu(e, worktreeMenu(w))}
      title={[w.path, state ? `state: ${state}` : null, busy ? "archiving…" : null].filter(Boolean).join("\n")}
    >
      <div className="card-title">
        <span className={busy ? "state state-archiving" : dotClass(archived ? null : agentStatus(summary))} />
        <span className="name">{w.name}{w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}</span>
      </div>
      <div className="card-sub">{sub}{g?.dirty ? " *" : ""}{!w.exists && !archived && " · missing"}</div>
      {!archived && <Signals worktreeId={w.id} className="card-signals" />}
      {g && (g.insertions > 0 || g.deletions > 0) && (
        <div className="card-foot">
          <span><span className="ins">+{g.insertions}</span> <span className="del">−{g.deletions}</span></span>
        </div>
      )}
    </div>
  );
}
