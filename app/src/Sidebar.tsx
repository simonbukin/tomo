import { Plus, RotateCw } from "lucide-react";
import { openWorktree, runAction } from "./actions";
import { agentsOf, formatBytes, setState, setUi, useStore } from "./store";
import type { AgentPresence, AgentState, Repo, Worktree } from "./types";

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
        <button className={`side-btn${view === "home" ? " side-btn-active" : ""}`} onClick={() => setUi({ view: "home" })}>home</button>
        <span className="spacer" />
        <button className="ghost" title="Add repository" onClick={() => setState({ dialog: { kind: "add-repo" } })}><Plus className="icon" /></button>
        <button className="ghost" title="Refresh repositories and worktrees" onClick={() => runAction("refresh")}><RotateCw className="icon" /></button>
      </div>
      <div className="sidebar-scroll">
        {grouped.map(({ repo, items }) => (
          <RepoGroup key={repo.id} repo={repo} items={items} active={view === "worktree" ? active : null} />
        ))}
        {orphans.length > 0 && <RepoGroup repo={{ id: "", name: "other", path: "", exists: true }} items={orphans} active={active} />}
        {repos.length === 0 && (
          <div className="sidebar-empty">
            No repositories yet. Add one with the plus button or run <code>tomo repo add &lt;path&gt;</code>.
          </div>
        )}
      </div>
    </aside>
  );
}

function RepoGroup({ repo, items, active }: { repo: Repo; items: Worktree[]; active: string | null }) {
  return (
    <div className="repo-group">
      <div className="section-label repo-head">
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
  const attention = useStore((s) => s.attention.some((a) => a.worktree_id === w.id && !a.viewed_at_ms));
  const res = useStore((s) => s.resources[w.id]);
  const threshold = useStore((s) => s.config?.resource_warning_bytes ?? Infinity);
  const hot = res && res.rss_bytes >= threshold;
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  const summary = summarizeState(agents, attention);
  return (
    <div className={`wt-row${active ? " wt-active" : ""}${w.exists ? "" : " wt-missing"}`} onClick={() => openWorktree(w.id)} title={w.path}>
      <span className={`state state-${summary}`} />
      <span className="wt-name">{w.name}</span>
      <span className="wt-meta">
        {w.metadata.priority && <span className={`prio prio-${w.metadata.priority}`}>p{w.metadata.priority}</span>}
        {hot && <span className="hot">{formatBytes(res.rss_bytes)}</span>}
      </span>
      <span className="wt-branch">
        {branch}
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
