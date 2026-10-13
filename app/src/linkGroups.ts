import type { WorktreeLink } from "./addons/types";

/**
 * The first `TEAM-123` in a branch or a title, with the team in upper case: `you/eng-31-retry` gives `ENG-31`.
 * The daemon's Linear addon finds an issue in a branch with the same rule.
 */
export function ticketKey(text: string): string | null {
  const pairs = text.split(/[^A-Za-z0-9-]+/).flatMap((segment) => {
    const parts = segment.split("-");
    return parts.slice(1).map((number, i) => [parts[i], number] as const);
  });
  const found = pairs.find(([team, number]) => /^[A-Za-z]/.test(team) && /^\d+$/.test(number));
  return found ? `${found[0].toUpperCase()}-${Number(found[1])}` : null;
}

/** A ticket with the links that belong to it, such as its pull requests, or one link that belongs to no ticket here. */
export interface LinkGroup {
  head: WorktreeLink;
  children: WorktreeLink[];
  touchedMs: number;
}

const touched = (l: WorktreeLink): number => l.touchedMs ?? 0;
const newestFirst = (a: { touchedMs: number }, b: { touchedMs: number }): number => b.touchedMs - a.touchedMs;

/** The links of a worktree as groups, the most recently touched first. A link goes under the ticket that it names when the worktree has that ticket. */
export function linkGroups(links: readonly WorktreeLink[]): LinkGroup[] {
  const keys = new Set(links.flatMap((l) => (l.key ? [l.key] : [])));
  const belongs = (l: WorktreeLink): boolean => !!l.ticket && l.ticket !== l.key && keys.has(l.ticket);
  return links
    .filter((l) => !belongs(l))
    .map((head) => {
      const children = links.filter((l) => belongs(l) && l.ticket === head.key).sort((a, b) => touched(b) - touched(a));
      return { head, children, touchedMs: Math.max(touched(head), ...children.map(touched)) };
    })
    .sort(newestFirst);
}
