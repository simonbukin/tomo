import { currentWorktree, focusPane, type Action } from "../actions";
import { rpc, RpcFailure } from "../api";
import { notify } from "../store";
import type { Tab } from "../types";

export async function reopenClosedTab(): Promise<void> {
  const w = currentWorktree();
  if (!w) return;
  try {
    const tab = await rpc<Tab>("tab_reopen", { worktree_id: w.id });
    if (tab.active_pane_id) window.setTimeout(() => focusPane(tab.active_pane_id!), 80);
  } catch (e) {
    if (!(e instanceof RpcFailure && e.code === "not_found")) notify("error", (e as Error).message);
  }
}

export const commands: Action[] = [{ id: "reopen_tab", label: "Reopen closed tab", group: "Tabs", run: reopenClosedTab, whenWorktree: true }];
