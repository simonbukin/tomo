import { openWorktree, runAction } from "./actions";
import { agentsOf, formatBytes, repoName, setState, setUi, useStore } from "./store";
import { KIND_LABEL, STATE_GLYPH, type Repo, type Worktree } from "./types";

export function Sidebar() {
  const repos = useStore((s) => s.repos);
  const worktrees = useStore((s) => s.worktrees);
  const active = useStore((s) => s.ui.activeWorktreeId);
  const view = useStore((s) => s.ui.view);
  const grouped = repos.map((r) => ({ repo: r, items: worktrees.filter((w) => w.repo_id === r.id) })).filter((g) => g.items.length || !g.repo.exists);
  const orphans = worktrees.filter((w) => !repos.some((r) => r.id === w.repo_id));

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className={`side-btn${view === "home" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "home" })}>Home</button>
        <span className="spacer" />
        <button className="icon-btn" title="Add repository" onClick={() => setState({ dialog: { kind: "add-repo" } })}>+</button>
        <button className="icon-btn" title="Refresh" onClick={() => runAction("refresh")}>↻</button>
      </div>
      <div className="sidebar-scroll">
        {grouped.map(({ repo, items }) => (
          <RepoGroup key={repo.id} repo={repo} items={items} active={view === "worktree" ? active : null} />
        ))}
        {orphans.length > 0 && <RepoGroup repo={{ id: "", name: "Other", path: "", exists: true }} items={orphans} active={active} />}
        {repos.length === 0 && <div className="sidebar-empty">No repositories yet. Add one with + or run <code>tomo repo add &lt;path&gt;</code>.</div>}
      </div>
    </aside>
  );
}

function RepoGroup({ repo, items, active }: { repo: Repo; items: Worktree[]; active: string | null }) {
  return (
    <div className="repo-group">
      <div className="repo-head">
        <span className="repo-name">{repo.name.toUpperCase()}</span>
        {!repo.exists && <span className="muted"> missing</span>}
        <span className="spacer" />
        {repo.id && <button className="icon-btn" title="New worktree" onClick={() => setState({ dialog: { kind: "create-worktree", repoId: repo.id } })}>+</button>}
      </div>
      {items.map((w) => (
        <WorktreeRow key={w.id} w={w} active={w.id === active} />
      ))}
    </div>
  );
}

export function WorktreeRow({ w, active }: { w: Worktree; active: boolean }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const attention = useStore((s) => s.attention.some((a) => a.worktree_id === w.id && !a.viewed_at_ms));
  const res = useStore((s) => s.resources[w.id]);
  const threshold = useStore((s) => s.config?.resource_warning_bytes ?? Infinity);
  const hot = res && res.rss_bytes >= threshold;
  const branchLabel = w.detached ? `detached ${w.head.slice(0, 7)}` : w.branch ?? "";
  const title = `${useStore((s) => repoName(s, w.repo_id))} · ${branchLabel}\n${w.path}`;
  return (
    <div className={`wt-row${active ? " wt-active" : ""}${w.exists ? "" : " wt-missing"}`} onClick={() => openWorktree(w.id)} title={title}>
      <div className="wt-line">
        <span className={`wt-mark${attention ? " wt-attention" : ""}`}>{attention ? "★" : w.git?.dirty ? "•" : ""}</span>
        <span className="wt-name">{w.name}</span>
        {w.metadata.priority && <span className={`prio prio-${w.metadata.priority}`}>P{w.metadata.priority}</span>}
      </div>
      {(agents.length > 0 || hot || w.metadata.tags.length > 0) && (
        <div className="wt-line wt-sub">
          {agents.map((a) => (
            <span key={a.pane_id} className={`dot dot-${a.state}`} title={`${KIND_LABEL[a.kind]} ${a.state}`}>
              {STATE_GLYPH[a.state]} {KIND_LABEL[a.kind]}
            </span>
          ))}
          {w.metadata.tags.length > 0 && agents.length === 0 && <span className="muted">{w.metadata.tags.map((t) => `#${t}`).join(" ")}</span>}
          <span className="spacer" />
          {hot && <span className="hot">{formatBytes(res.rss_bytes)}</span>}
        </div>
      )}
    </div>
  );
}
