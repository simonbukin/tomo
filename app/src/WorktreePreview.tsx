import type { Signal } from "./activityModel";
import { agentMark, agentStatus, GLYPH, STATUS_LABEL, subagentStatus } from "./glyphs";
import { AgentMark, StateMark } from "./StateMark";
import { durationLabel, gitLines } from "./previewModel";
import { ProcessIcon } from "./ProcessIcon";
import { signalDetail } from "./addons";
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
      return signal.state === "waiting" ? `${GLYPH.needs} ${KIND_LABEL[signal.agent]} needs input` : `${GLYPH[agentStatus(signal.state) ?? "unknown"]} ${KIND_LABEL[signal.agent]}`;
    case "warn":
      return `⚠ ${formatBytes(signal.bytes)}`;
    case "addon":
      return [signal.glyph, signal.text].filter(Boolean).join(" ");
  }
}

const ORDER: Record<Subagent["state"], number> = { waiting: 0, dead: 1, working: 2, done: 3, unknown: 4, idle: 5, exited: 6 };

/** The live subagents of every agent in a worktree, most urgent first, then oldest first. */
export function subagentsOf(agents: { subagents?: Subagent[] }[]): Subagent[] {
  return agents.flatMap((a) => a.subagents ?? []).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.started_at_ms - b.started_at_ms);
}

/** Every subagent, indented under its worktree, one line each. With `flip`, each line is a `useFlip` item keyed under it. */
export function SubagentList({ worktreeId, flip }: { worktreeId: Id; flip?: string }) {
  const all = useStore((s) => subagentsOf(agentsOf(s, worktreeId)));
  if (!all.length) return null;
  return (
    <ul className="subagents" aria-label="subagents">
      {all.map((sub, i) => (
        <li key={sub.id ?? `launch-${i}`} data-flip={flip && `${flip}:${sub.id ?? `launch-${i}`}`} className={`subagent is-${sub.state}`}>
          <StateMark mark={subagentStatus(sub.state)} small />
          <span className="subagent-label">{sub.label}</span>
          <span className="subagent-desc">{sub.description}</span>
          <span className="subagent-age">{durationLabel(sub.started_at_ms)}</span>
        </li>
      ))}
    </ul>
  );
}

function SignalDetail({ worktreeId, signal }: { worktreeId: Id; signal: Signal }) {
  const Detail = signal.kind === "addon" ? signalDetail(signal.className) : null;
  return Detail ? <Detail worktreeId={worktreeId} /> : <div>{signalText(signal)}</div>;
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
              <AgentMark agent={a} />
              <ProcessIcon agent={a.kind} size={11} />
              <span>{KIND_LABEL[a.kind]}</span>
              <span className="muted">{STATUS_LABEL[agentMark(a) ?? "unknown"]}</span>
              <span className="faint">{durationLabel(a.updated_at_ms)}</span>
            </div>
          ))}
          <SubagentList worktreeId={w.id} />
        </div>
      )}
      {signals.length > 0 && (
        <div className="wt-preview-block">
          {signals.map((signal, i) => <SignalDetail key={i} worktreeId={w.id} signal={signal} />)}
        </div>
      )}
      {w.last_active_ms != null && <div className="faint">active {durationLabel(w.last_active_ms)} ago</div>}
    </div>
  );
}
