import { activateTab, focusPane, openWorktree } from "../actions";
import { rpcParsed } from "../api";
import { paneResultSchema } from "../schemas";
import { failToast, getState, type State } from "../store";
import type { Id } from "../types";

export type Position = { line: number; col: number | null };

/** The panes that hold a buffer, sorted, so that an unchanged set stays the same array for the store. */
export const editorPaneIds = (s: State): Id[] =>
  Object.values(s.panes)
    .filter((p) => p.kind === "editor")
    .map((p) => p.id)
    .sort();

/** The path relative to the worktree root, or null for a path outside it. A relative path stays as it is. */
export function worktreeRelative(root: string, path: string): string | null {
  if (!path.startsWith("/")) return path;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** Starts the editor chunk download, so that the first open does not wait for it. */
export const preloadEditor = (): Promise<unknown> => import("./cm");

/**
 * Shows a file of the worktree in an editor pane. A pane that already shows the file takes the focus
 * and moves to the line; otherwise a new tab opens. Returns the pane id, or null when the open failed.
 */
export async function openFile(worktreeId: Id, path: string, at: Position | null = null): Promise<Id | null> {
  const s = getState();
  const root = s.worktrees.find((w) => w.id === worktreeId)?.path ?? "";
  const rel = worktreeRelative(root, path);
  const existing = Object.values(s.panes).find((p) => p.worktree_id === worktreeId && p.kind === "editor" && p.editor?.path === rel);
  const cm = import("./cm");
  try {
    const paneId = existing
      ? existing.id
      : (await rpcParsed("editor_open", paneResultSchema, { worktree_id: worktreeId, path, line: at?.line ?? null, col: at?.col ?? null, tab_id: null })).pane.id;
    if (worktreeId !== getState().ui.activeWorktreeId || getState().ui.view !== "worktree") await openWorktree(worktreeId);
    if (existing) activateTab(existing.tab_id);
    window.setTimeout(() => focusPane(paneId), 60);
    if (existing && at) void cm.then((m) => m.reveal(paneId, at.line, at.col ?? 1));
    return paneId;
  } catch (e) {
    failToast("Could not open the file")(e);
    return null;
  }
}
