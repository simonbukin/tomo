import { describe, expect, it } from "vitest";
import { attentionRoute, notificationText, type RouteContext } from "./notifyRoute";

const focused: RouteContext = { windowFocused: true, desktopEnabled: true, view: "worktree", activeWorktreeId: "w1", focusedPaneId: "p1" };
const item = { worktree_id: "w1", pane_id: "p1" };

describe("attentionRoute", () => {
  it("sends a desktop notification only while Tomo is not focused", () => {
    expect(attentionRoute(item, { ...focused, windowFocused: false })).toBe("desktop");
    expect(attentionRoute(item, { ...focused, windowFocused: false, desktopEnabled: false })).toBe("indicator");
  });

  it("shows only the in-app indicator for another worktree, pane, or view", () => {
    expect(attentionRoute({ ...item, worktree_id: "w2" }, focused)).toBe("indicator");
    expect(attentionRoute({ ...item, pane_id: "p2" }, focused)).toBe("indicator");
    expect(attentionRoute(item, { ...focused, view: "home" })).toBe("indicator");
  });

  it("adds nothing when the user already looks at the pane or its worktree", () => {
    expect(attentionRoute(item, focused)).toBe("none");
    expect(attentionRoute({ ...item, pane_id: null }, focused)).toBe("none");
  });
});

describe("notificationText", () => {
  it("names the worktree and marks checkpoints", () => {
    expect(notificationText({ kind: "checkpoint", message: "check the login page" }, "aogashima")).toEqual({ title: "aogashima", body: "review requested: check the login page" });
    expect(notificationText({ kind: "waiting", message: "Claude is waiting for you" }, null)).toEqual({ title: "Tomo", body: "Claude is waiting for you" });
  });
});
