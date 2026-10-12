import type { CoverStyle } from "./glyphCover";

/**
 * Which glyph cover a change on screen gets. A scene is what the centre shows; comparing the last scene with the next
 * one says what happened: another view, another worktree, a new, closed or other tab, a new split, a pane that fell
 * asleep or woke.
 */
export interface Scene {
  readonly view: string;
  readonly worktreeId: string | null;
  readonly tabId: string | null;
  readonly tabIds: readonly string[];
  readonly leaves: readonly string[];
  readonly asleep: readonly string[];
}

export type CoverTarget = { readonly kind: "center" } | { readonly kind: "layout" } | { readonly kind: "pane"; readonly paneId: string };

export interface CoverPlan {
  readonly target: CoverTarget;
  readonly style: CoverStyle;
  readonly reverse?: boolean;
  /** Open from the last click, when it was inside the target. */
  readonly fromPointer?: boolean;
}

const added = (before: readonly string[], after: readonly string[]) => after.filter((id) => !before.includes(id));
const toggled = (before: readonly string[], after: readonly string[]) => [...added(before, after), ...added(after, before)];

export function coversFor(prev: Scene | null, next: Scene): CoverPlan[] {
  if (!prev) return [];
  if (prev.view !== next.view) return [{ target: { kind: "center" }, style: "aperture" }];
  if (!next.tabId) return [];
  if (prev.worktreeId !== next.worktreeId || !prev.tabId) return [{ target: { kind: "layout" }, style: "aperture" }];
  if (prev.tabId !== next.tabId) {
    if (!next.tabIds.includes(prev.tabId)) return [{ target: { kind: "layout" }, style: "silk" }];
    if (!prev.tabIds.includes(next.tabId)) return [{ target: { kind: "layout" }, style: "aperture", fromPointer: true }];
    return [{ target: { kind: "layout" }, style: "halftone", reverse: next.tabIds.indexOf(next.tabId) < next.tabIds.indexOf(prev.tabId) }];
  }
  const born = added(prev.leaves, next.leaves).map((paneId): CoverPlan => ({ target: { kind: "pane", paneId }, style: "halftone" }));
  const slept = toggled(prev.asleep, next.asleep)
    .filter((id) => next.leaves.includes(id))
    .map((paneId): CoverPlan => ({ target: { kind: "pane", paneId }, style: "silk" }));
  return [...born, ...slept];
}
