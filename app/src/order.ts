import type { Id } from "./types";

export type DropPlace = "before" | "after";

/** Moves `id` next to `targetId`. Unknown ids leave the list unchanged. */
export function moveId(ids: Id[], id: Id, targetId: Id, place: DropPlace): Id[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(targetId) + (place === "after" ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Sorts items by their position in `order`; items missing from it keep their input order after the known ones. */
export function byManualOrder<T>(items: T[], order: Id[], idOf: (item: T) => Id): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/** Main worktrees first, everything else in the given order. */
export function mainFirst<T extends { is_main: boolean }>(items: T[]): T[] {
  return [...items.filter((w) => w.is_main), ...items.filter((w) => !w.is_main)];
}
