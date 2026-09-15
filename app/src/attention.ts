import { getCurrentWindow } from "@tauri-apps/api/window";
import { rpc } from "./api";
import { attentionRoute, notificationText } from "./notifyRoute";
import { playChime } from "./sounds";
import { activeTab, getState } from "./store";
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

export async function announceAttention(item: AttentionItem): Promise<void> {
  if (item.kind === "checkpoint") playChime("checkpoint");
  const s = getState();
  const route = attentionRoute(item, {
    windowFocused: await windowFocused(),
    desktopEnabled: s.config?.notifications?.desktop ?? true,
    view: s.ui.view,
    activeWorktreeId: s.ui.activeWorktreeId,
    focusedPaneId: activeTab(s, s.ui.activeWorktreeId)?.active_pane_id ?? null,
  });
  if (route === "none" && item.kind === "waiting") rpc("attention_view", { id: item.id }).catch(() => {});
  if (route === "desktop") {
    const { title, body } = notificationText(item, s.worktrees.find((w) => w.id === item.worktree_id)?.name ?? null);
    showDesktopNotification(title, body);
  }
}
