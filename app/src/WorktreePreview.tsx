import type { Signal } from "./activityModel";
import { agentStatus, dotClass, GLYPH } from "./glyphs";
import { durationLabel, gitLines } from "./previewModel";
import { ProcessIcon } from "./ProcessIcon";
import { signalsFor } from "./Signals";
import { agentsOf, formatBytes, useStore } from "./store";
import { KIND_LABEL, type Worktree } from "./types";
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
