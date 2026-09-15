import { equalizeTab, focusedPaneId, type Action } from "../actions";
import { rpc } from "../api";
import type { DropPlace } from "../generated";
import { reorderTabs } from "../layoutModel";
import { activeTab, getState, notify, paneIds, setState } from "../store";
import { neighbor } from "../terminals";
import type { Id, Tab } from "../types";

const fail = (e: unknown) => notify("error", (e as Error).message);

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

function moveActiveTab(delta: number): void {
  const s = getState();
  const tabs = s.tabs[s.ui.activeWorktreeId ?? ""] ?? [];
  const i = tabs.findIndex((t) => t.is_active);
  if (i >= 0 && tabs[i + delta]) moveTab(tabs[i].id, i + delta);
}

function swapWithNeighbor(dir: "left" | "right" | "up" | "down"): void {
  const s = getState();
  const tab = activeTab(s, s.ui.activeWorktreeId);
  const from = focusedPaneId();
  const to = tab && from ? neighbor(from, paneIds(tab.layout), dir) : null;
  if (from && to) movePane(from, { paneId: to }, "center");
}

function equalizeActiveTab(): void {
  const s = getState();
  const tab = activeTab(s, s.ui.activeWorktreeId);
  if (tab) equalizeTab(tab.id);
}

export const commands: Action[] = [
  { id: "move_tab_left", label: "Move tab left", group: "Tabs", whenWorktree: true, run: () => moveActiveTab(-1) },
  { id: "move_tab_right", label: "Move tab right", group: "Tabs", whenWorktree: true, run: () => moveActiveTab(1) },
  ...(["left", "right", "up", "down"] as const).map((dir): Action => ({ id: `move_pane_${dir}`, label: `Move pane ${dir} (swap with neighbor)`, group: "Panes", whenWorktree: true, run: () => swapWithNeighbor(dir) })),
  { id: "equalize_splits", label: "Equalize splits", group: "Panes", whenWorktree: true, run: equalizeActiveTab },
];
