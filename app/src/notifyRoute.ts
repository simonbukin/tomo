import type { AttentionItem, Id, UiState } from "./types";

export type AttentionRoute = "desktop" | "indicator" | "none";

export interface RouteContext {
  windowFocused: boolean;
  desktopEnabled: boolean;
  view: UiState["view"];
  activeWorktreeId: Id | null;
  focusedPaneId: Id | null;
}

/**
 * Where a new attention item gets an extra signal. The sidebar, tab, and title bar indicators
 * always render from state: `indicator` adds nothing, `none` also marks a waiting item as seen.
 */
export function attentionRoute(item: Pick<AttentionItem, "worktree_id" | "pane_id">, ctx: RouteContext): AttentionRoute {
  if (!ctx.windowFocused) return ctx.desktopEnabled ? "desktop" : "indicator";
  const onWorktree = ctx.view === "worktree" && ctx.activeWorktreeId === item.worktree_id;
  return onWorktree && (item.pane_id == null || item.pane_id === ctx.focusedPaneId) ? "none" : "indicator";
}

export function notificationText(item: Pick<AttentionItem, "kind" | "message">, worktreeName: string | null): { title: string; body: string } {
  return { title: worktreeName ?? "Tomo", body: item.kind === "checkpoint" ? `review requested: ${item.message}` : item.message };
}
