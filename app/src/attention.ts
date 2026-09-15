import { getCurrentWindow } from "@tauri-apps/api/window";
import { focusPane, openWorktree, resolveCheckpoint, restartWorktreeAction } from "./actions";
import { rpc } from "./api";
import { attentionDelivery, type AttentionActionId, type AttentionNames, type RouteContext } from "./notifyRoute";
import { playChime } from "./sounds";
import { activeTab, getState, toast, type State } from "./store";
import type { AttentionItem } from "./types";

async function windowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return document.hasFocus();
  }
}

// tauri-plugin-notification installs a `window.Notification` that sends a native notification.
function showDesktopNotification(title: string, body: string): void {
  if (typeof Notification === "undefined" || Notification.permission === "denied") return;
  const send = () => {
    new Notification(title, { body });
  };
  if (Notification.permission === "granted") send();
  else Notification.requestPermission().then((p) => p === "granted" && send()).catch(() => {});
}

export function routeContext(s: State, focused: boolean): RouteContext {
  return {
    windowFocused: focused,
    desktopEnabled: s.config?.notifications?.desktop ?? true,
    view: s.ui.view,
    activeWorktreeId: s.ui.activeWorktreeId,
    focusedPaneId: activeTab(s, s.ui.activeWorktreeId)?.active_pane_id ?? null,
  };
}

function namesOf(s: State, item: AttentionItem): AttentionNames {
  const actionId = item.pane_id ? s.panes[item.pane_id]?.action_id : null;
  const def = actionId ? s.actions[item.worktree_id]?.actions.find((a) => a.id === actionId) : null;
  return { worktree: s.worktrees.find((w) => w.id === item.worktree_id)?.name ?? null, action: actionId ? { id: actionId, label: def?.label ?? actionId } : null };
}

function toastAction(id: AttentionActionId, item: AttentionItem, names: AttentionNames): { label: string; run: () => void } {
  const goTo = () => {
    void openWorktree(item.worktree_id);
    if (item.pane_id) window.setTimeout(() => void focusPane(item.pane_id!), 80);
  };
  switch (id) {
    case "logs":
      return { label: "Logs", run: goTo };
    case "open":
      return { label: "Open", run: goTo };
    case "restart":
      return { label: "Restart", run: () => names.action && restartWorktreeAction(item.worktree_id, names.action.id) };
    case "resolve":
      return { label: "Resolve", run: () => resolveCheckpoint(item.id) };
  }
}

/** Delivers a new attention item. The item itself stays in state; a dismissed toast never resolves it. */
export async function announceAttention(item: AttentionItem): Promise<void> {
  const focused = await windowFocused();
  const s = getState();
  const names = namesOf(s, item);
  const delivery = attentionDelivery(item, routeContext(s, focused), names);
  if (delivery.channels.includes("chime")) playChime("checkpoint");
  if (delivery.markSeen) rpc("attention_view", { id: item.id }).catch(() => {});
  if (delivery.toast) {
    const { actions, ...rest } = delivery.toast;
    toast({ ...rest, actions: actions.map((a) => toastAction(a, item, names)) });
  }
  if (delivery.desktop) showDesktopNotification(delivery.desktop.title, delivery.desktop.body);
}
