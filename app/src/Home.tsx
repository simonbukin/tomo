import { FolderGit2, Search } from "lucide-react";
import { useMemo } from "react";
import { openWorktree } from "./actions";
import { agentsOf, defaultHome, formatBytes, repoName, setState, setUi, useStore, type State } from "./store";
import { summarizeState } from "./Sidebar";
import type { HomeOptions, Worktree } from "./types";

function matches(w: Worktree, s: State, o: HomeOptions): boolean {
  if (o.repo && w.repo_id !== o.repo) return false;
  if (o.project && (w.metadata.project ?? "") !== o.project) return false;
  if (o.tag && !w.metadata.tags.includes(o.tag)) return false;
  if (o.attentionOnly && !agentsOf(s, w.id).some((a) => a.state === "waiting") && !s.attention.some((a) => a.worktree_id === w.id && !a.viewed_at_ms)) return false;
  if (o.query) {
    const q = o.query.toLowerCase();
    const hay = [w.name, w.branch ?? "", w.metadata.project ?? "", w.metadata.tags.join(" "), repoName(s, w.repo_id), w.path].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sorted(list: Worktree[], o: HomeOptions): Worktree[] {
  return [...list].sort((a, b) => {
    if (o.sort === "recent") return (b.last_active_ms ?? 0) - (a.last_active_ms ?? 0);
    const pa = a.metadata.priority ?? 9;
    const pb = b.metadata.priority ?? 9;
    return pa - pb || (b.last_active_ms ?? 0) - (a.last_active_ms ?? 0) || a.name.localeCompare(b.name);
  });
}

export function Home() {
  const s = useStore((x) => x);
  const o = s.ui.home;
  const set = (patch: Partial<HomeOptions>) => setUi({ home: { ...o, ...patch } });
  const projects = useMemo(() => [...new Set(s.worktrees.map((w) => w.metadata.project).filter((p): p is string => !!p))].sort(), [s.worktrees]);
  const tags = useMemo(() => [...new Set(s.worktrees.flatMap((w) => w.metadata.tags))].sort(), [s.worktrees]);
  const visible = sorted(s.worktrees.filter((w) => matches(w, s, o)), o);
  const groups: { key: string; title: string; items: Worktree[] }[] =
    o.group === "none"
      ? [{ key: "all", title: "", items: visible }]
      : Object.entries(
          visible.reduce<Record<string, Worktree[]>>((acc, w) => {
            const key = o.group === "repo" ? repoName(s, w.repo_id) : (w.metadata.project ?? "No project");
            (acc[key] ??= []).push(w);
            return acc;
          }, {}),
        )
          .sort(([a], [b]) => (a === "No project" ? 1 : b === "No project" ? -1 : a.localeCompare(b)))
          .map(([key, items]) => ({ key, title: key, items }));

  return (
    <div className="home">
      <div className="home-bar">
        <label className="home-search">
          <Search className="icon" />
          <input placeholder="search worktrees, branches, projects, tags" value={o.query} onChange={(e) => set({ query: e.target.value })} autoFocus />
        </label>
        <select value={o.repo} onChange={(e) => set({ repo: e.target.value })}>
          <option value="">all repos</option>
          {s.repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={o.project} onChange={(e) => set({ project: e.target.value })}>
          <option value="">all projects</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={o.tag} onChange={(e) => set({ tag: e.target.value })}>
          <option value="">all tags</option>
          {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
        <select value={o.sort} onChange={(e) => set({ sort: e.target.value as HomeOptions["sort"] })}>
          <option value="priority">sort: priority</option>
          <option value="recent">sort: recent</option>
        </select>
        <select value={o.group} onChange={(e) => set({ group: e.target.value as HomeOptions["group"] })}>
          <option value="repo">group: repo</option>
          <option value="project">group: project</option>
          <option value="none">group: none</option>
        </select>
        <label className="check"><input type="checkbox" checked={o.attentionOnly} onChange={(e) => set({ attentionOnly: e.target.checked })} /> needs attention</label>
        {(o.query || o.repo || o.project || o.tag || o.attentionOnly) && <button className="link" onClick={() => set(defaultHome)}>clear</button>}
      </div>
      {s.worktrees.length === 0 && (
        <div className="home-empty">
          <FolderGit2 className="icon" />
          <p>No worktrees yet.</p>
          <button onClick={() => setState({ dialog: { kind: "add-repo" } })}>Add a repository</button>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.key} className="home-group">
          {g.title && <div className="section-label">{g.title}<span className="right">{g.items.length}</span></div>}
          <div className="cards">
            {g.items.map((w) => <Card key={w.id} w={w} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Card({ w }: { w: Worktree }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const res = useStore((s) => s.resources[w.id]);
  const repo = useStore((s) => repoName(s, w.repo_id));
  const attention = useStore((s) => s.attention.some((a) => a.worktree_id === w.id && !a.viewed_at_ms));
  const g = w.git;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const sub = [w.metadata.project ?? repo, branch].filter(Boolean).join(" · ");
  const summary = summarizeState(agents, attention);
  return (
    <div className={`card${attention ? " card-attention" : ""}${w.exists ? "" : " card-missing"}`} onClick={() => openWorktree(w.id)}>
      <div className="card-title">
        <span className={`state state-${summary}`} />
        <span className="name">{w.name}</span>
        <span className="wt-meta">
          {w.metadata.priority && <span className={`prio prio-${w.metadata.priority}`}>p{w.metadata.priority}</span>}
        </span>
      </div>
      <div className="card-sub">{sub}{g?.dirty ? " *" : ""}{!w.exists && " · missing"}</div>
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
