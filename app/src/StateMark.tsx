import type { CSSProperties } from "react";
import { cx } from "./components/ui";
import { agentMark, agentTitle, markTitle, type Mark } from "./glyphs";
import { worktreeLead } from "./homeQuery";
import { queryContext, useStore } from "./store";
import type { AgentPresence, Worktree } from "./types";

type StillMark = Exclude<Mark, null | "working" | "archiving">;

/** The lit cells of each still state, numbered 0 to 8 from the top left, row by row. */
export const LIT: Record<StillMark, readonly number[]> = {
  done: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  complete: [0, 1, 2, 3, 5, 6, 7, 8],
  needs: [1, 3, 4, 5, 7],
  idle: [4],
  failed: [0, 2, 4, 6, 8],
  unknown: [0, 2, 6, 8],
  sleeping: [0, 1, 2, 4, 6, 7, 8],
  "sleeping-done": [0, 1, 2, 4, 6, 7, 8],
};

const ALL = LIT.done;

/** Each cell twinkles on its own period and phase. The periods share no small ratio, so the pattern never repeats. */
const TWINKLE: readonly [number, number][] = [[1, 0.13], [1.37, 0.71], [0.83, 0.42], [1.19, 0.94], [1.61, 0.27], [0.91, 0.58], [1.29, 0.05], [0.77, 0.66], [1.07, 0.39]];

const x = (cell: number) => (cell % 3) * 3;
const y = (cell: number) => Math.floor(cell / 3) * 3;

export const cellsPath = (cells: readonly number[]): string => cells.map((c) => `M${x(c)} ${y(c)}h3v3h-3z`).join("");

function Cells({ mark }: { mark: Mark }) {
  if (mark === null) return null;
  if (mark === "working" || mark === "archiving")
    return TWINKLE.map(([tw, td], c) => <rect key={c} className="tw" x={x(c)} y={y(c)} width={3} height={3} style={{ "--tw": tw, "--td": td } as CSSProperties} />);
  const lit = LIT[mark];
  const off = ALL.filter((c) => !lit.includes(c));
  return (
    <>
      {off.length > 0 && <path className="off" d={cellsPath(off)} />}
      <path className="lit" d={cellsPath(lit)} />
    </>
  );
}

/**
 * The one live mark: a 3×3 grid in one 9px SVG. Color says what, motion says busy, and the pattern tells the still
 * states apart (see `.mark` in base.css). The lit cells are one path, so neighbours join with no seam at any zoom.
 * `small` is the 6px size of a subagent line.
 */
export function StateMark({ mark, title, small, className, hidden }: { mark: Mark; title?: string; small?: boolean; className?: string; hidden?: boolean }) {
  const tip = markTitle(mark, title);
  return (
    <svg className={cx("state mark", small && "state-small", className)} viewBox="0 0 9 9" data-mark={mark ?? "none"} role={tip && !hidden ? "img" : undefined} aria-hidden={hidden || !tip || undefined}>
      {tip && <title>{tip}</title>}
      <Cells mark={mark} />
    </svg>
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
