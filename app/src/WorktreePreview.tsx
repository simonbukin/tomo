import type { Signal } from "./activityModel";
import { agentStatus, dotClass, GLYPH, statusDot } from "./glyphs";
import { durationLabel, gitLines } from "./previewModel";
import { ProcessIcon } from "./ProcessIcon";
import { signalsFor } from "./Signals";
import { agentsOf, formatBytes, useStore } from "./store";
import { KIND_LABEL, type Id, type Subagent, type Worktree } from "./types";
import "./styles/previews.css";

export function signalText(signal: Signal): string {
  switch (signal.kind) {
    case "attention":
      return `${GLYPH.needs} ${signal.text}`;
    case "crash":
      return `${GLYPH.failed} ${signal.text}`;
    case "agent":
      return signal.state === "waiting" ? `${GLYPH.needs} ${KIND_LABEL[signal.agent]} needs input` : `${signal.state === "working" ? GLYPH.working : GLYPH.idle} ${KIND_LABEL[signal.agent]}`;
    case "warn":
      return `⚠ ${formatBytes(signal.bytes)}`;
    case "addon":
      return [signal.glyph, signal.text].filter(Boolean).join(" ");
  }
}

const ORDER: Record<Subagent["state"], number> = { waiting: 0, working: 1, unknown: 2, idle: 3, exited: 4 };

/** The live subagents of every agent in a worktree, most urgent first, then oldest first. */
export function subagentsOf(agents: { subagents?: Subagent[] }[]): Subagent[] {
  return agents.flatMap((a) => a.subagents ?? []).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.started_at_ms - b.started_at_ms);
}

/**
 * The subagents, indented under their worktree. Past `limit` the last line counts the rest,
 * so the list never grows past `limit` lines.
 */
export function SubagentList({ worktreeId, limit = Infinity }: { worktreeId: Id; limit?: number }) {
  const all = useStore((s) => subagentsOf(agentsOf(s, worktreeId)));
  if (!all.length) return null;
  const shown = all.length > limit ? all.slice(0, limit - 1) : all;
  const rest = all.length - shown.length;
  return (
    <ul className="subagents" aria-label="subagents">
      {shown.map((sub, i) => (
        <li key={sub.id ?? `launch-${i}`} data-flip={`sub:${worktreeId}:${sub.id ?? `launch-${i}`}`} className={`subagent is-${sub.state}`}>
          <span {...statusDot(agentStatus(sub.state))} />
          <span className="subagent-label">{sub.label}</span>
          <span className="subagent-desc">{sub.description}</span>
          <span className="subagent-age">{durationLabel(sub.started_at_ms)}</span>
        </li>
      ))}
      {rest > 0 && <li data-flip={`sub:${worktreeId}:more`} className="subagent subagent-more">+{rest} more</li>}
    </ul>
  );
}

/** Everything the client knows about one worktree, for the hover card on a sidebar row or a rail square. */
export function WorktreePreview({ w }: { w: Worktree }) {
  const agents = useStore((s) => agentsOf(s, w.id));
  const signals = useStore((s) => signalsFor(s, w.id)).filter((sig) => sig.kind !== "agent");
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "no branch");
  return (
    <div className="preview wt-preview">
      <div className="preview-head">{w.name}</div>
      <div className="mono muted">{branch}</div>
      {w.git && gitLines(w.git).map((line) => <div key={line} className="muted">{line}</div>)}
      {agents.length > 0 && (
        <div className="wt-preview-block">
          {agents.map((a) => (
            <div key={a.pane_id} className="wt-preview-agent">
              <span className={dotClass(agentStatus(a.state))} />
              <ProcessIcon agent={a.kind} size={11} />
              <span>{KIND_LABEL[a.kind]}</span>
              <span className="muted">{a.state}</span>
              <span className="faint">{durationLabel(a.updated_at_ms)}</span>
            </div>
          ))}
          <SubagentList worktreeId={w.id} />
        </div>
      )}
      {signals.length > 0 && (
        <div className="wt-preview-block">
          {signals.map((signal, i) => <div key={i}>{signalText(signal)}</div>)}
        </div>
      )}
      {w.last_active_ms != null && <div className="faint">active {durationLabel(w.last_active_ms)} ago</div>}
    </div>
  );
}
