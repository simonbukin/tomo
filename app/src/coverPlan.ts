import type { CoverStyle } from "./glyphCover";
import type { MaskStyle } from "./glyphMask";

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

/** A cover over the new content, from its own ground: for a change that has nothing old left to show. */
export interface CoverPlan {
  readonly kind: "cover";
  readonly target: CoverTarget;
  readonly style: CoverStyle;
  readonly reverse?: boolean;
  /** Open from the last click, when it was near the target. */
  readonly fromPointer?: boolean;
}

/**
 * The old tab's layout, still mounted, is masked away over the new one, so the switch never shows a blank frame.
 * When the old layout is not kept, the new one gets `fallback` instead.
 */
export interface SwapPlan {
  readonly kind: "swap";
  readonly fromTabId: string;
  readonly style: MaskStyle;
  readonly reverse?: boolean;
  readonly fromPointer?: boolean;
  readonly fallback: CoverStyle;
}

export type Plan = CoverPlan | SwapPlan;

const added = (before: readonly string[], after: readonly string[]) => after.filter((id) => !before.includes(id));
const toggled = (before: readonly string[], after: readonly string[]) => [...added(before, after), ...added(after, before)];

export function coversFor(prev: Scene | null, next: Scene): Plan[] {
  if (!prev) return [];
  if (prev.view !== next.view) return [{ kind: "cover", target: { kind: "center" }, style: "aperture" }];
  if (!next.tabId) return [];
  if (!prev.tabId) return [{ kind: "cover", target: { kind: "layout" }, style: "aperture" }];
  if (prev.worktreeId !== next.worktreeId) return [{ kind: "swap", fromTabId: prev.tabId, style: "iris", fallback: "aperture" }];
  if (prev.tabId !== next.tabId) {
    if (!next.tabIds.includes(prev.tabId)) return [{ kind: "cover", target: { kind: "layout" }, style: "silk" }];
    if (!prev.tabIds.includes(next.tabId)) return [{ kind: "swap", fromTabId: prev.tabId, style: "iris", fromPointer: true, fallback: "aperture" }];
    return [{ kind: "swap", fromTabId: prev.tabId, style: "sweep", reverse: next.tabIds.indexOf(next.tabId) < next.tabIds.indexOf(prev.tabId), fallback: "halftone" }];
  }
  const born = added(prev.leaves, next.leaves).map((paneId): Plan => ({ kind: "cover", target: { kind: "pane", paneId }, style: "halftone" }));
  const slept = toggled(prev.asleep, next.asleep)
    .filter((id) => next.leaves.includes(id))
    .map((paneId): Plan => ({ kind: "cover", target: { kind: "pane", paneId }, style: "silk" }));
  return [...born, ...slept];
}
