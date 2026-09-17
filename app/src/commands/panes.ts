import { focusedPaneId, type Action } from "../actions";
import { rpc } from "../api";
import type { DropPlace } from "../generated";
import { reorderTabs } from "../layoutModel";
import { activeTab, failToast, getState, paneIds, setState } from "../store";
import { neighbor } from "../terminals";
import type { Id, Tab } from "../types";

const fail = failToast("Move failed");

/** Reorders at once, then the daemon's `tabs_changed` snapshot wins. A failed call puts the old order back. */
export function moveTab(tabId: Id, position: number): void {
  const tab = Object.values(getState().tabs).flat().find((t) => t.id === tabId);
  if (!tab) return;
  const before = getState().tabs[tab.worktree_id] ?? [];
  const next = reorderTabs(before, tabId, position);
  if (next.every((t, i) => t.id === before[i]?.id)) return;
  const put = (from: Tab[], to: Tab[]) => setState((s) => (s.tabs[tab.worktree_id] === from ? { tabs: { ...s.tabs, [tab.worktree_id]: to } } : {}));
  put(before, next);
  rpc("tab_move", { tab_id: tabId, position }).catch((e) => {
    put(next, before);
    fail(e);
  });
}

export type PaneTarget = { paneId: Id } | { tabId: Id };

export function movePane(paneId: Id, target: PaneTarget, place: DropPlace): void {
  const to = "paneId" in target ? { target_pane_id: target.paneId, tab_id: null } : { target_pane_id: null, tab_id: target.tabId };
  rpc("pane_move", { pane_id: paneId, ...to, place }).catch(fail);
}

/** Take one pane out of its tab and give it a tab of its own. A drop beside the tabs lands here. */
export async function paneToNewTab(paneId: Id): Promise<void> {
  const pane = getState().panes[paneId];
  if (!pane) return;
  try {
    const tab = await rpc<Tab>("tab_create", { worktree_id: pane.worktree_id, title: null });
    movePane(paneId, { tabId: tab.id }, "right");
  } catch (e) {
    fail(e);
  }
}

function swapWithNeighbor(dir: "left" | "right" | "up" | "down"): void {
  const s = getState();
  const tab = activeTab(s, s.ui.activeWorktreeId);
  const from = focusedPaneId();
  const to = tab && from ? neighbor(from, paneIds(tab.layout), dir) : null;
  if (from && to) movePane(from, { paneId: to }, "center");
}

export const commands: Action[] = [
  ...(["left", "right", "up", "down"] as const).map((dir): Action => ({ id: `move_pane_${dir}`, label: `Move pane ${dir} (swap with neighbor)`, group: "Panes", whenWorktree: true, run: () => swapWithNeighbor(dir) })),
];
