import { cx } from "./components/ui";
import { agentMark, agentTitle, statusDot, type Mark } from "./glyphs";
import { worktreeLead } from "./homeQuery";
import { queryContext, useStore } from "./store";
import type { AgentPresence, Worktree } from "./types";

/**
 * The one live mark: a square whose motion, fill, and color tell the state. A change of state keeps the element,
 * so the working rhombus turns back to a square when it becomes done. `small` is the size of a subagent line.
 */
export function StateMark({ mark, title, small, className, hidden }: { mark: Mark; title?: string; small?: boolean; className?: string; hidden?: boolean }) {
  return <span {...statusDot(mark, cx(small && "state-small", className), title)} aria-hidden={hidden || undefined} />;
}

export function AgentMark({ agent, small, className }: { agent: AgentPresence | null; small?: boolean; className?: string }) {
  return <StateMark mark={agent && agentMark(agent)} title={agent ? agentTitle(agent) : undefined} small={small} className={className} />;
}

/** The mark of a worktree: the mark of its most urgent agent, or the archive in progress. */
export function WorktreeMark({ w, className }: { w: Worktree; className?: string }) {
  const lead = useStore((s) => worktreeLead(w, queryContext(s)));
  return w.archiving ? <StateMark mark="archiving" className={className} /> : <AgentMark agent={lead} className={className} />;
}
