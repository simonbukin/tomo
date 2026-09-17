import { agentRoster, type AgentRow } from "./agentRoster";
import { openWorktree, focusPane } from "./actions";
import { agentStatus, dotClass } from "./glyphs";
import { durationLabel } from "./previewModel";
import { ProcessIcon } from "./ProcessIcon";
import { EmptyState } from "./states";
import { useStore, visibleRepos } from "./store";
import { KIND_LABEL } from "./types";

/**
 * Open the worktree, then put the caller's pane in front. openWorktree focuses
 * whatever pane the daemon calls active, on its own timer, so the second focus
 * has to run after that one or it is overwritten.
 */
async function jumpTo(row: AgentRow): Promise<void> {
  await openWorktree(row.worktreeId);
  window.setTimeout(() => focusPane(row.paneId), 80);
}

export function Agents() {
  const rows = useStore((s) => agentRoster(Object.values(s.agents), s.worktrees, visibleRepos(s)));
  return (
    <div className="agents">
      <div className="agents-bar">
        <span className="agents-title">agents</span>
        <span className="faint">{rows.length > 0 ? `${rows.length} running` : ""}</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No active agents." />
      ) : (
        <div className="agents-list">
          <div className="agents-head"><span /><span>agent</span><span>state</span><span>location</span><span>elapsed</span></div>
          {rows.map((row) => (
            <div key={row.paneId} className="agents-row" onClick={() => jumpTo(row)} title={`${row.repo} / ${row.worktree}`}>
              <span className={dotClass(agentStatus(row.state))} />
              <span className="agents-kind"><ProcessIcon agent={row.kind} size={11} />{KIND_LABEL[row.kind]}</span>
              <span className="agents-state">{row.state === "waiting" ? "needs input" : row.state}</span>
              <span className="agents-where">{row.repo} / {row.worktree}</span>
              <span className="agents-elapsed">{row.updatedAtMs > 0 ? durationLabel(row.updatedAtMs) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
