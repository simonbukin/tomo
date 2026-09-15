import { agentStatus, dotClass } from "./glyphs";
import { durationLabel, gitLines } from "./previewModel";
import { KIND_LABEL, type AgentPresence, type Worktree } from "./types";
import "./styles/previews.css";

export function AgentPreview({ agent }: { agent: AgentPresence }) {
  return (
    <div className="preview">
      <div className="preview-head">
        <span className={dotClass(agentStatus(agent.state))} />
        {KIND_LABEL[agent.kind]} · {agent.state}
      </div>
      {agent.session_ref && <div className="mono muted">session {agent.session_ref.slice(0, 8)}</div>}
      <div className="muted">last activity {durationLabel(agent.updated_at_ms)} ago</div>
    </div>
  );
}

export function GitPreview({ worktree: w }: { worktree: Worktree }) {
  return (
    <div className="preview">
      <div className="preview-head mono">{w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "no branch")}</div>
      {w.git ? gitLines(w.git).map((line) => <div key={line} className="muted">{line}</div>) : <div className="muted">no git status yet</div>}
      <div className="mono faint">
        {w.head.slice(0, 7)} · {w.path}
      </div>
    </div>
  );
}
