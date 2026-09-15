import type { ToastLevel } from "./store";
import type { AttentionItem, Id, UiState } from "./types";

/** A delivery surface. Attention, Activity, and Diagnostics are state, not channels. */
export type Channel = "status" | "toast" | "desktop" | "chime";

export type NotifyKind =
  | "success"
  | "action_started"
  | "action_completed"
  | "failure"
  | "config_warning"
  | "daemon_reconnected"
  | "daemon_disconnected"
  | "crash"
  | "waiting"
  | "checkpoint";

export interface RouteContext {
  windowFocused: boolean;
  desktopEnabled: boolean;
  view: UiState["view"];
  activeWorktreeId: Id | null;
  focusedPaneId: Id | null;
}

export type Target = Pick<AttentionItem, "worktree_id" | "pane_id">;

/** The user already looks at the pane, or at the worktree when the event has no pane. */
export function looksAt(target: Target, ctx: RouteContext): boolean {
  const onWorktree = ctx.windowFocused && ctx.view === "worktree" && ctx.activeWorktreeId === target.worktree_id;
  return onWorktree && (target.pane_id == null || target.pane_id === ctx.focusedPaneId);
}

const desktop = (ctx: RouteContext): Channel[] => (!ctx.windowFocused && ctx.desktopEnabled ? ["desktop"] : []);

/** The channels for one event. The in-app indicators always render from state, so an empty list is valid. */
export function route(kind: NotifyKind, ctx: RouteContext, target?: Target): Channel[] {
  const looking = target ? looksAt(target, ctx) : false;
  switch (kind) {
    case "success":
      return ["status"];
    case "action_started":
    case "action_completed":
    case "daemon_reconnected":
      return [];
    case "failure":
    case "config_warning":
    case "daemon_disconnected":
      return ["toast"];
    case "crash":
      return looking ? [] : ["toast", ...desktop(ctx)];
    case "waiting":
      return looking ? [] : desktop(ctx);
    case "checkpoint":
      return ["chime", ...(looking ? [] : (["toast"] as Channel[])), ...desktop(ctx)];
  }
}

export type AttentionActionId = "logs" | "restart" | "open" | "resolve";

export interface AttentionToast {
  key: string;
  level: ToastLevel;
  title: string;
  detail: string;
  actions: AttentionActionId[];
}

export interface AttentionDelivery {
  channels: Channel[];
  /** A waiting item that the user already looks at counts as seen. */
  markSeen: boolean;
  toast: AttentionToast | null;
  desktop: { title: string; body: string } | null;
}

export interface AttentionNames {
  worktree: string | null;
  /** What started the item's pane, when anything did, and whether an addon can start it again. */
  source: { kind: string; id: string; label: string; restartable: boolean } | null;
}

export const attentionToastKey = (id: Id) => `attention:${id}`;

const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

function exitDetail(message: string): string {
  const code = /code (-?\d+)/.exec(message)?.[1];
  return code ? `exit code ${code}` : message;
}

function toastFor(item: AttentionItem, names: AttentionNames): AttentionToast | null {
  const key = attentionToastKey(item.id);
  if (item.kind === "crash") {
    const actions: AttentionActionId[] = [...(item.pane_id ? (["logs"] as const) : []), ...(names.source?.restartable ? (["restart"] as const) : [])];
    return { key, level: "error", title: `${names.source?.label ?? "Action"} crashed`, detail: joined(exitDetail(item.message), names.worktree), actions };
  }
  if (item.kind === "checkpoint") return { key, level: "warning", title: "Review requested", detail: joined(item.message, names.worktree), actions: ["open", "resolve"] };
  return null;
}

export function attentionDelivery(item: AttentionItem, ctx: RouteContext, names: AttentionNames): AttentionDelivery {
  const channels = route(item.kind, ctx, item);
  return {
    channels,
    markSeen: item.kind === "waiting" && looksAt(item, ctx),
    toast: channels.includes("toast") ? toastFor(item, names) : null,
    desktop: channels.includes("desktop") ? notificationText(item, names.worktree) : null,
  };
}

export function notificationText(item: Pick<AttentionItem, "kind" | "message">, worktreeName: string | null): { title: string; body: string } {
  return { title: worktreeName ?? "Tomo", body: item.kind === "checkpoint" ? `review requested: ${item.message}` : item.message };
}
