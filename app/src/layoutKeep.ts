/**
 * Which tab layouts stay mounted. A switch to a kept tab only shows a layer that is already drawn: no terminal is
 * made again, no scrollback is replayed, nothing moves. The active tab comes first, then the tabs seen most
 * recently, while their panes fit in the budget: each terminal holds a WebGL context, and the window has few.
 */
export const KEPT_PANES = 8;

export interface Candidate {
  readonly id: string;
  readonly panes: number;
  /** A browser pane is a native view that a hidden layer cannot hide, so its tab is never kept hidden. */
  readonly keepable: boolean;
}

export function keptTabs(recent: readonly string[], active: string, candidates: ReadonlyMap<string, Candidate>, budget = KEPT_PANES): string[] {
  const order = [active, ...recent.filter((id) => id !== active)];
  return order.reduce<{ ids: string[]; panes: number }>(
    (acc, id) => {
      const c = candidates.get(id);
      if (!c) return acc;
      if (id !== active && (!c.keepable || acc.panes + c.panes > budget)) return acc;
      return { ids: [...acc.ids, id], panes: acc.panes + c.panes };
    },
    { ids: [], panes: 0 },
  ).ids;
}
