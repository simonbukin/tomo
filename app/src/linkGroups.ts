import type { WorktreeLink } from "./addons/types";

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
