import type { WorktreeLink } from "./addons/types";

/**
 * Every `TEAM-123` in a branch or a title, in order, with the team in upper case: `you/eng-31-retry` gives `ENG-31`.
 * A word such as `utf-8` matches too, so a caller takes the first key that the worktree has, not the first key.
 * The daemon's Linear addon finds an issue with the same rule.
 */
export function ticketKeys(text: string): string[] {
  const pairs = text.split(/[^A-Za-z0-9-]+/).flatMap((segment) => {
    const parts = segment.split("-");
    return parts.slice(1).map((number, i) => [parts[i], number] as const);
  });
  return pairs.filter(([team, number]) => /^[A-Za-z]/.test(team) && /^\d+$/.test(number)).map(([team, number]) => `${team.toUpperCase()}-${Number(number)}`);
}

/** A ticket with the links that belong to it, such as its pull requests, or one link that belongs to no ticket here. */
export interface LinkGroup {
  head: WorktreeLink;
  children: WorktreeLink[];
  touchedMs: number;
}

const touched = (l: WorktreeLink): number => l.touchedMs ?? 0;
const newestFirst = (a: { touchedMs: number }, b: { touchedMs: number }): number => b.touchedMs - a.touchedMs;

/** The links of a worktree as groups, the most recently touched first. A link goes under the first ticket that it names and the worktree has. */
export function linkGroups(links: readonly WorktreeLink[]): LinkGroup[] {
  const keys = new Set(links.flatMap((l) => (l.key ? [l.key] : [])));
  const parent = (l: WorktreeLink): string | undefined => (l.tickets ?? []).find((t) => t !== l.key && keys.has(t));
  return links
    .filter((l) => !parent(l))
    .map((head) => {
      const children = head.key ? links.filter((l) => parent(l) === head.key).sort((a, b) => touched(b) - touched(a)) : [];
      return { head, children, touchedMs: Math.max(touched(head), ...children.map(touched)) };
    })
    .sort(newestFirst);
}
