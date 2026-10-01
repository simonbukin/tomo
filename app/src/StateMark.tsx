import { useLayoutEffect, useRef } from "react";
import { cx } from "./components/ui";
import { agentMark, agentTitle, markTitle, type Mark } from "./glyphs";
import { worktreeLead } from "./homeQuery";
import { queryContext, useStore } from "./store";
import { opacities, seedField, stepField, type Field } from "./twinkle";
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

const x = (cell: number) => (cell % 3) * 3;
const y = (cell: number) => Math.floor(cell / 3) * 3;

export const cellsPath = (cells: readonly number[]): string => cells.map((c) => `M${x(c)} ${y(c)}h3v3h-3z`).join("");

const holdsStill = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function Twinkle() {
  const group = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    if (holdsStill()) return;
    const cells = [...group.current!.children] as SVGElement[];
    const paint = (f: Field) => opacities(f).forEach((o, c) => cells[c].style.setProperty("opacity", o.toFixed(3)));
    let field = seedField(Math.random);
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      field = stepField(field, (now - last) / 1000, Math.random);
      last = now;
      paint(field);
      frame = requestAnimationFrame(tick);
    };
    paint(field);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <g ref={group}>
      {ALL.map((c) => (
        <rect key={c} className="tw" x={x(c)} y={y(c)} width={3} height={3} />
      ))}
    </g>
  );
}

function Cells({ mark }: { mark: Mark }) {
  if (mark === null) return null;
  if (mark === "working" || mark === "archiving")
    return <Twinkle />;
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
 * `small` is the 6px size of a subagent line. The span holds the tooltip, so the text of a line stays the text.
 */
export function StateMark({ mark, title, small, className, hidden }: { mark: Mark; title?: string; small?: boolean; className?: string; hidden?: boolean }) {
  return (
    <span className={cx("state mark", small && "state-small", className)} data-mark={mark ?? "none"} title={markTitle(mark, title)} aria-hidden={hidden || undefined}>
      <svg viewBox="0 0 9 9" aria-hidden>
        <Cells mark={mark} />
      </svg>
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
