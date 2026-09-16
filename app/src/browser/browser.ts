import { invoke } from "@tauri-apps/api/core";
import { focusPane, openWorktree } from "../actions";
import { rpc } from "../api";
import { errorText, failToast, getState, recordDiagnostic, toast, type State } from "../store";
import type { Id } from "../types";

/** The panes that own a webview, sorted, so that an unchanged set stays the same array for the store. */
export const browserPaneIds = (s: State): Id[] =>
  Object.values(s.panes)
    .filter((p) => p.kind === "browser")
    .map((p) => p.id)
    .sort();

export function normalizeUrl(text: string): string {
  const t = text.trim();
  if (!t) return "about:blank";
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t) ? t : `http://${t}`;
}

export async function openBrowser(worktreeId: Id, url: string | null = null, tabId: Id | null = null): Promise<Id | null> {
  try {
    const r = await rpc<{ pane: { id: Id } }>("browser_open", { worktree_id: worktreeId, url, tab_id: tabId });
    if (worktreeId !== getState().ui.activeWorktreeId) await openWorktree(worktreeId);
    window.setTimeout(() => focusPane(r.pane.id), 80);
    return r.pane.id;
  } catch (e) {
    failToast("Browser failed to open")(e);
    return null;
  }
}

/** Shows a page in the worktree's live browser pane, or opens one. */
export async function openInBrowser(worktreeId: Id, url: string): Promise<void> {
  const live = Object.values(getState().panes).find((p) => p.worktree_id === worktreeId && p.kind === "browser" && p.live);
  if (!live) {
    await openBrowser(worktreeId, url);
    return;
  }
  try {
    await rpc("browser_navigate", { pane_id: live.id, url });
    if (worktreeId !== getState().ui.activeWorktreeId) await openWorktree(worktreeId);
    focusPane(live.id);
  } catch (e) {
    failToast("Browser failed to open")(e);
  }
}

/** A failed browser host call is a diagnostic. With a title, the user caused it and also sees a toast. */
export const browserHostFailed =
  (op: string, title?: string) =>
  (e: unknown): void => {
    recordDiagnostic("error", "browser", `${op}: ${errorText(e)}`);
    if (title) toast({ level: "error", title, detail: errorText(e) });
  };

export function browserCommand(paneId: Id, command: "browser_back" | "browser_forward" | "browser_reload"): void {
  invoke(command, { paneId }).catch(browserHostFailed(command, "Browser command failed"));
}
