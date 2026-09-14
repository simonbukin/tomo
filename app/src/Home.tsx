import { ListFilter, Search, SlidersHorizontal, X } from "lucide-react";
import { Wordmark } from "./Brand";
import { useMemo, useRef } from "react";
import { openWorktree } from "./actions";
import { openMenu, openMenuAt, type MenuItem } from "./ContextMenu";
import { filterWorktrees, groupWorktrees, needsAttention, sortWorktrees, type QueryContext } from "./homeQuery";
import { worktreeMenu } from "./menus";
import { agentsOf, formatBytes, repoName, setState, setUi, useStore, visibleRepos } from "./store";
import { RepoAvatar } from "./Sidebar";
import { summarizeState } from "./Sidebar";
import type { Filter, FilterKind, HomeOptions, Worktree } from "./types";

const KIND_LABEL: Record<FilterKind, string> = { repo: "repo", project: "project", tag: "tag", priority: "priority", agent: "agent", archived: "archived", attention: "attention" };

export function Home() {
  const s = useStore((x) => x);
  const o = s.ui.home;
  const set = (patch: Partial<HomeOptions>) => setUi({ home: { ...o, ...patch } });
  const ctx: QueryContext = useMemo(() => ({ repos: s.repos, agents: Object.values(s.agents), attention: s.attention }), [s.repos, s.agents, s.attention]);
  const repos = visibleRepos(s);
  const visible = sortWorktrees(filterWorktrees(s.worktrees.filter((w) => repos.some((r) => r.id === w.repo_id) || !s.repos.some((r) => r.id === w.repo_id)), o, ctx), o.sort, ctx);
  const repoFor = (key: string) => (o.group === "repo" ? repos.find((r) => r.name === key) : undefined);
  const groups = groupWorktrees(visible, o.group, ctx);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const displayBtn = useRef<HTMLButtonElement>(null);

  const addFilter = (f: Filter) => set({ filters: o.filters.some((x) => x.kind === f.kind && x.value === f.value) ? o.filters : [...o.filters, f] });
  const removeFilter = (f: Filter) => set({ filters: o.filters.filter((x) => !(x.kind === f.kind && x.value === f.value)) });
  const values = (kind: FilterKind): { value: string; label: string }[] => {
    switch (kind) {
      case "repo":
        return s.repos.map((r) => ({ value: r.id, label: r.name }));
      case "project":
        return [...new Set(s.worktrees.map((w) => w.metadata.project).filter((p): p is string => !!p))].sort().map((p) => ({ value: p, label: p }));
      case "tag":
        return [...new Set(s.worktrees.flatMap((w) => w.metadata.tags))].sort().map((t) => ({ value: t, label: `#${t}` }));
      case "priority":
        return ["1", "2", "3", "4"].map((p) => ({ value: p, label: `p${p}` })).concat({ value: "", label: "unset" });
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
    { label: "group by", submenu: (["repo", "project", "priority", "none"] as const).map((g) => ({ label: g, checked: o.group === g, run: () => set({ group: g }) })) },
    { label: "sort", submenu: (["priority", "recent", "created", "name"] as const).map((v) => ({ label: v, checked: o.sort === v, run: () => set({ sort: v }) })) },
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
        <button ref={filterBtn} className="ghost" onClick={() => openMenuAt(filterBtn.current!, filterMenu())}><ListFilter className="icon" /> filter</button>
        <button ref={displayBtn} className="ghost" onClick={() => openMenuAt(displayBtn.current!, displayMenu())}><SlidersHorizontal className="icon" /> display</button>
        {o.filters.map((f) => (
          <span key={`${f.kind}:${f.value}`} className="chip rise">
            {label(f)}
            <button className="chip-x" onClick={() => removeFilter(f)}><X className="icon" /></button>
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
            <section key={g.key || "all"} className="board-col">
              <div className="section-label">{repoFor(g.key) && <RepoAvatar repo={repoFor(g.key)!} />}{g.key || "all"}<span className="right">{g.items.length}</span></div>
              <div className="board-cards">{g.items.map((w) => <Card key={w.id} w={w} />)}</div>
            </section>
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key || "all"} className="home-group">
            {g.key && <div className="section-label">{repoFor(g.key) && <RepoAvatar repo={repoFor(g.key)!} />}{g.key}<span className="right">{g.items.length}</span></div>}
            <div className="cards">{g.items.map((w) => <Card key={w.id} w={w} />)}</div>
          </section>
        ))
      )}
    </div>
  );
}

function Card({ w }: { w: Worktree }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const res = useStore((s) => s.resources[w.id]);
  const repo = useStore((s) => repoName(s, w.repo_id));
  const attention = useStore((s) => needsAttention(w, { repos: s.repos, agents: Object.values(s.agents), attention: s.attention }));
  const g = w.git;
  const archived = !!w.archived_at_ms;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const sub = [w.metadata.project ?? repo, branch].filter(Boolean).join(" · ");
  const summary = summarizeState(agents, attention);
  return (
    <div
      className={`card rise${attention ? " card-attention" : ""}${w.exists || archived ? "" : " card-missing"}${archived ? " card-archived" : ""}`}
      onClick={() => !archived && openWorktree(w.id)}
      onContextMenu={(e) => openMenu(e, worktreeMenu(w))}
    >
      <div className="card-title">
        <span className={`state state-${archived ? "none" : summary}`} />
        <span className="name">{w.name}</span>
        <span className="wt-meta">
          {archived && <span className="faint">archived</span>}
          {w.metadata.priority && <span className={`prio prio-${w.metadata.priority}`}>p{w.metadata.priority}</span>}
        </span>
      </div>
      <div className="card-sub">{sub}{g?.dirty ? " *" : ""}{!w.exists && !archived && " · missing"}</div>
      {w.metadata.tags.length > 0 && <div className="card-sub">{w.metadata.tags.map((t) => `#${t}`).join(" ")}</div>}
      {agents.length > 0 && (
        <div className="card-agents">
          {agents.map((a) => (
            <span key={a.pane_id} className={`agent-line is-${a.state}`}>
              <span className={`state state-${a.state}`} />
              <span className="agent-state">{a.state}</span>
              <span className="agent-kind">· {a.kind}</span>
            </span>
          ))}
        </div>
      )}
      {(g && (g.insertions > 0 || g.deletions > 0)) || w.pane_count > 0 || (res && res.rss_bytes > 64 * 1024 * 1024) ? (
        <div className="card-foot">
          {g && (g.insertions > 0 || g.deletions > 0) && <span><span className="ins">+{g.insertions}</span> <span className="del">−{g.deletions}</span></span>}
          <span className="right">
            {w.pane_count > 0 && <span>{w.pane_count} pane{w.pane_count === 1 ? "" : "s"}</span>}
            {res && res.rss_bytes > 64 * 1024 * 1024 && <span>{formatBytes(res.rss_bytes)}</span>}
          </span>
        </div>
      ) : null}
    </div>
  );
}
