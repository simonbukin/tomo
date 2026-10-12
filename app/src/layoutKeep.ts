/**
 * Which tab layouts stay mounted. A switch to a kept tab only shows a layer that is already drawn: no terminal is
 * made again, no scrollback is replayed, nothing moves. The active tab comes first, then the tabs seen most
 * recently, while their panes fit in the budget: each terminal holds a WebGL context, and the window has few. A kept
 * pane stays attached, which keeps its agent awake, so a hidden layer goes after `KEEP_MS` without a look.
 */
export const KEPT_PANES = 8;
export const KEEP_MS = 10 * 60 * 1000;

export interface Candidate {
  readonly id: string;
  readonly panes: number;
  /** A browser pane is a native view that a hidden layer cannot hide, so its tab is never kept hidden. */
  readonly keepable: boolean;
}

export function keptTabs(seen: ReadonlyMap<string, number>, active: string, candidates: ReadonlyMap<string, Candidate>, now: number, budget = KEPT_PANES, maxAge = KEEP_MS): string[] {
  const recent = [...seen].filter(([id, at]) => id !== active && now - at <= maxAge).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return [active, ...recent].reduce<{ ids: string[]; panes: number }>(
    (acc, id) => {
      const c = candidates.get(id);
      if (!c) return acc;
      if (id !== active && (!c.keepable || acc.panes + c.panes > budget)) return acc;
      return { ids: [...acc.ids, id], panes: acc.panes + c.panes };
    },
    { ids: [], panes: 0 },
  ).ids;
}

/** The kept ids in the order they were first kept, so a switch never moves a layer in the DOM. */
export const stableOrder = (previous: readonly string[], kept: readonly string[]): string[] => [...previous.filter((id) => kept.includes(id)), ...kept.filter((id) => !previous.includes(id))];
