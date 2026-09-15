import { ArrowUpRight } from "lucide-react";
import type { ReactElement } from "react";
import { endpointUrl, nowSignals, type Signal } from "./activityModel";
import { addonSignals } from "./addons";
import { HoverCard } from "./components/ui";
import { agentStatus, dotClass, GLYPH } from "./glyphs";
import { AgentPreview, RuntimePreview } from "./HoverPreviews";
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
    addon: addonSignals(s, worktreeId),
  });
}

type AgentSignal = Extract<Signal, { kind: "agent" }>;
type RuntimeSignal = Extract<Signal, { kind: "runtime" }>;

function AgentHover({ worktreeId, signal, children }: { worktreeId: Id; signal: AgentSignal; children: ReactElement }) {
  const agent = useStore((s) => agentsOf(s, worktreeId).filter((a) => a.kind === signal.agent && a.state === signal.state).sort((a, b) => b.updated_at_ms - a.updated_at_ms)[0] ?? null);
  return <HoverCard content={agent && <AgentPreview agent={agent} />}>{children}</HoverCard>;
}

function RuntimeHover({ worktreeId, signal, children }: { worktreeId: Id; signal: RuntimeSignal; children: ReactElement }) {
  const endpoint = useStore((s) => endpointsOf(s, worktreeId).find((e) => endpointUrl(e) === signal.url) ?? null);
  return <HoverCard content={endpoint && <RuntimePreview endpoint={endpoint} label={signal.label} />}>{children}</HoverCard>;
}

function SignalLine({ worktreeId, signal }: { worktreeId: Id; signal: Signal }) {
  switch (signal.kind) {
    case "attention":
      return <span className="signal signal-attention"><span className={dotClass("needs")} />{signal.text}</span>;
    case "crash":
      return <span className="signal signal-crash"><span className="signal-glyph">{GLYPH.failed}</span>{signal.text}</span>;
    case "agent":
      return (
        <AgentHover worktreeId={worktreeId} signal={signal}>
          {signal.state === "waiting" ? (
            <span className="signal agent-line is-waiting signal-attention">
              <span className={dotClass("needs")} />
              <ProcessIcon agent={signal.agent} size={11} />
              {KIND_LABEL[signal.agent]}
              <span className="signal-waiting-note">needs input</span>
            </span>
          ) : (
            <span className={`signal agent-line is-${signal.state}`}><span className={dotClass(agentStatus(signal.state))} /><ProcessIcon agent={signal.agent} size={11} />{KIND_LABEL[signal.agent]}</span>
          )}
        </AgentHover>
      );
    case "runtime":
      return (
        <RuntimeHover worktreeId={worktreeId} signal={signal}>
          <span className="signal signal-runtime">{signal.label} <ArrowUpRight className="icon" /> :{signal.port}</span>
        </RuntimeHover>
      );
    case "warn":
      return <span className="signal signal-warn">⚠ {formatBytes(signal.bytes)}</span>;
    case "addon":
      return <span className={`signal ${signal.className}`}><span className={`state ${signal.dot}`} />{signal.text}</span>;
  }
}

/** At most three selective signals for a NOW card or sidebar row. Renders nothing for a quiet worktree. */
export function Signals({ worktreeId, className }: { worktreeId: Id; className?: string }) {
  const signals = useStore((s) => signalsFor(s, worktreeId));
  if (!signals.length) return null;
  return (
    <span className={className ?? "signals"}>
      {signals.map((sig, i) => <SignalLine key={i} worktreeId={worktreeId} signal={sig} />)}
    </span>
  );
}
