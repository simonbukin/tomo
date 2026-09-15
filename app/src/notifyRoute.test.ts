import { describe, expect, it } from "vitest";
import { attentionDelivery, attentionToastKey, looksAt, notificationText, route, type AttentionNames, type RouteContext } from "./notifyRoute";
import type { AttentionItem } from "./types";

const onPane: RouteContext = { windowFocused: true, desktopEnabled: true, view: "worktree", activeWorktreeId: "w1", focusedPaneId: "p1" };
const elsewhere: RouteContext = { ...onPane, activeWorktreeId: "w2", focusedPaneId: "p9" };
const away: RouteContext = { ...onPane, windowFocused: false };
const target = { worktree_id: "w1", pane_id: "p1" };

const item = (kind: AttentionItem["kind"], message = "App exited with code 1"): AttentionItem => ({
  id: "a1",
  worktree_id: "w1",
  pane_id: "p1",
  level: "attention",
  message,
  created_at_ms: 0,
  viewed_at_ms: null,
  kind,
  url: null,
  agent_kind: null,
  resolved_at_ms: null,
});
const names: AttentionNames = { worktree: "aogashima", action: { id: "sampler", label: "Sampler" } };

describe("looksAt", () => {
  it("is true only while Tomo is focused on the pane, or on the worktree for an item without a pane", () => {
    expect(looksAt(target, onPane)).toBe(true);
    expect(looksAt({ ...target, pane_id: null }, onPane)).toBe(true);
    expect(looksAt(target, away)).toBe(false);
    expect(looksAt(target, { ...onPane, focusedPaneId: "p2" })).toBe(false);
    expect(looksAt(target, { ...onPane, view: "home" })).toBe(false);
    expect(looksAt({ ...target, worktree_id: "w2" }, onPane)).toBe(false);
  });
});

describe("route: the PRD table", () => {
  it("copied branch and theme changed go to the status message only", () => {
    expect(route("success", onPane)).toEqual(["status"]);
    expect(route("success", away)).toEqual(["status"]);
  });

  it("an Action that starts or completes normally shows only UI state", () => {
    expect(route("action_started", elsewhere, target)).toEqual([]);
    expect(route("action_completed", away, target)).toEqual([]);
  });

  it("a crash toasts unless the user already looks at it, and also notifies the desktop while away", () => {
    expect(route("crash", elsewhere, target)).toEqual(["toast"]);
    expect(route("crash", onPane, target)).toEqual([]);
    expect(route("crash", away, target)).toEqual(["toast", "desktop"]);
    expect(route("crash", { ...away, desktopEnabled: false }, target)).toEqual(["toast"]);
  });

  it("a waiting agent never toasts while Tomo is focused and notifies the desktop while away", () => {
    expect(route("waiting", elsewhere, target)).toEqual([]);
    expect(route("waiting", onPane, target)).toEqual([]);
    expect(route("waiting", away, target)).toEqual(["desktop"]);
  });

  it("a human checkpoint always chimes, toasts when not on its pane, and notifies the desktop while away", () => {
    expect(route("checkpoint", elsewhere, target)).toEqual(["chime", "toast"]);
    expect(route("checkpoint", onPane, target)).toEqual(["chime"]);
    expect(route("checkpoint", away, target)).toEqual(["chime", "toast", "desktop"]);
  });

  it("config warnings and failures toast; a daemon reconnect toasts only when it is prolonged", () => {
    expect(route("config_warning", onPane)).toEqual(["toast"]);
    expect(route("failure", onPane)).toEqual(["toast"]);
    expect(route("daemon_reconnected", onPane)).toEqual([]);
    expect(route("daemon_disconnected", onPane)).toEqual(["toast"]);
  });
});

describe("attentionDelivery: scenarios", () => {
  it("D: a crash elsewhere gives an error toast with Logs and Restart, keyed to the attention item", () => {
    const d = attentionDelivery(item("crash"), elsewhere, names);
    expect(d.toast).toEqual({ key: attentionToastKey("a1"), level: "error", title: "Sampler crashed", detail: "exit code 1 · aogashima", actions: ["logs", "restart"] });
    expect(d.desktop).toBeNull();
    expect(d.markSeen).toBe(false);
  });

  it("D: a crash without a known Action or pane offers no dead actions", () => {
    const d = attentionDelivery({ ...item("crash", "gone"), pane_id: null }, elsewhere, { worktree: null, action: null });
    expect(d.toast).toMatchObject({ title: "Action crashed", detail: "gone", actions: [] });
  });

  it("E: a crash while the user looks at its logs gives no toast", () => {
    expect(attentionDelivery(item("crash"), onPane, names)).toEqual({ channels: [], markSeen: false, toast: null, desktop: null });
  });

  it("F: a checkpoint while Tomo is unfocused gives a desktop notification, a toast, and a chime", () => {
    const d = attentionDelivery(item("checkpoint", "check the login page"), away, names);
    expect(d.channels).toEqual(["chime", "toast", "desktop"]);
    expect(d.desktop).toEqual({ title: "aogashima", body: "review requested: check the login page" });
    expect(d.toast).toMatchObject({ level: "warning", title: "Review requested", detail: "check the login page · aogashima", actions: ["open", "resolve"] });
  });

  it("a waiting item on the focused pane is marked seen and gets no toast", () => {
    expect(attentionDelivery(item("waiting", "Claude is waiting"), onPane, names)).toEqual({ channels: [], markSeen: true, toast: null, desktop: null });
    expect(attentionDelivery(item("waiting", "Claude is waiting"), elsewhere, names).toast).toBeNull();
  });
});

describe("notificationText", () => {
  it("names the worktree and marks checkpoints", () => {
    expect(notificationText({ kind: "checkpoint", message: "check the login page" }, "aogashima")).toEqual({ title: "aogashima", body: "review requested: check the login page" });
    expect(notificationText({ kind: "waiting", message: "Claude is waiting for you" }, null)).toEqual({ title: "Tomo", body: "Claude is waiting for you" });
  });
});
