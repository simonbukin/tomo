import { tabSchema } from "../schemas";
import { currentWorktree, focusPane, type Action } from "../actions";
import { RpcFailure, rpcParsed } from "../api";
import { failToast } from "../store";

export async function reopenClosedTab(): Promise<void> {
  const w = currentWorktree();
  if (!w) return;
  try {
    const tab = await rpcParsed("tab_reopen", tabSchema, { worktree_id: w.id });
    if (tab.active_pane_id) window.setTimeout(() => focusPane(tab.active_pane_id!), 80);
  } catch (e) {
    if (!(e instanceof RpcFailure && e.code === "not_found")) failToast("Reopen tab failed")(e);
  }
}

export const commands: Action[] = [{ id: "reopen_tab", label: "Reopen closed tab", group: "Tabs", run: reopenClosedTab, whenWorktree: true }];
