import { ArrowUpRight } from "lucide-react";
import { nowSignals, type Signal } from "./activityModel";
import { ProcessIcon } from "./ProcessIcon";
import { agentsOf, endpointsOf, formatBytes, useStore, type State } from "./store";
import { KIND_LABEL, type Id } from "./types";

export function signalsFor(s: State, worktreeId: Id): Signal[] {
  return nowSignals({
    attention: s.attention.filter((a) => a.worktree_id === worktreeId),
    agents: agentsOf(s, worktreeId),
    endpoints: endpointsOf(s, worktreeId),
    actions: s.actions[worktreeId]?.actions ?? [],
    rssBytes: s.resources[worktreeId]?.rss_bytes ?? null,
    warnBytes: s.config?.resource_warning_bytes ?? Infinity,
    pr: s.prs[worktreeId]?.pr ?? null,
  });
}

function SignalLine({ signal }: { signal: Signal }) {
  switch (signal.kind) {
    case "attention":
      return <span className="signal signal-attention"><span className="state state-waiting" />{signal.text}</span>;
    case "crash":
      return <span className="signal signal-crash"><span className="signal-glyph">×</span>{signal.text}</span>;
    case "agent":
      if (signal.state === "waiting") {
        return (
          <span className="signal agent-line is-waiting signal-attention">
            <span className="state state-waiting" />
            <ProcessIcon agent={signal.agent} size={11} />
            {KIND_LABEL[signal.agent]}
            <span className="signal-waiting-note">needs input</span>
          </span>
        );
      }
      return <span className={`signal agent-line is-${signal.state}`}><span className={`state state-${signal.state}`} /><ProcessIcon agent={signal.agent} size={11} />{KIND_LABEL[signal.agent]}</span>;
    case "runtime":
      return <span className="signal signal-runtime">{signal.label} <ArrowUpRight className="icon" /> :{signal.port}</span>;
    case "warn":
      return <span className="signal signal-warn">⚠ {formatBytes(signal.bytes)}</span>;
    case "pr":
      return <span className={`signal signal-pr-${signal.tone}`}><span className={`state ${signal.tone === "merged" ? "pr-merged" : "check-failed"}`} />{signal.text}</span>;
  }
}

/** At most three selective signals for a NOW card or sidebar row. Renders nothing for a quiet worktree. */
export function Signals({ worktreeId, className }: { worktreeId: Id; className?: string }) {
  const signals = useStore((s) => signalsFor(s, worktreeId));
  if (!signals.length) return null;
  return (
    <span className={className ?? "signals"}>
      {signals.map((sig, i) => <SignalLine key={i} signal={sig} />)}
    </span>
  );
}
