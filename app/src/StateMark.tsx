import { cx } from "./components/ui";
import { agentMark, agentTitle, markTitle, type Mark } from "./glyphs";
import { worktreeLead } from "./homeQuery";
import { queryContext, useStore } from "./store";
import type { AgentPresence, Worktree } from "./types";

const CELLS = Array.from({ length: 9 }, (_, i) => <i key={i} />);

/**
 * The one live mark: a 3×3 dot matrix. Color says what, motion says busy, and the pattern tells the still states
 * apart (see `.mx` in base.css). A change of state keeps the element, so the cells fade to the new pattern.
 * `small` is the size of a subagent line.
 */
export function StateMark({ mark, title, small, className, hidden }: { mark: Mark; title?: string; small?: boolean; className?: string; hidden?: boolean }) {
  return (
    <span className={cx("state mx", small && "state-small", className)} data-mark={mark ?? "none"} title={markTitle(mark, title)} aria-hidden={hidden || undefined}>
      {CELLS}
    </span>
  );
}

export function AgentMark({ agent, small, className }: { agent: AgentPresence | null; small?: boolean; className?: string }) {
  return <StateMark mark={agent && agentMark(agent)} title={agent ? agentTitle(agent) : undefined} small={small} className={className} />;
}

/** The mark of a worktree: the mark of its most urgent agent, or the archive in progress. */
export function WorktreeMark({ w, className }: { w: Worktree; className?: string }) {
  const lead = useStore((s) => worktreeLead(w, queryContext(s)));
  return w.archiving ? <StateMark mark="archiving" className={className} /> : <AgentMark agent={lead} className={className} />;
}
