import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { aPane, aTab } = await import("./test-fixtures");
const { hookStatus } = await import("./glyphs");
const { reorderTabs } = await import("./layoutModel");
const { tabMenu } = await import("./menus");
const { LayoutDnd } = await import("./LayoutDnd");
const { TabBar } = await import("./Tabs");
const store = await import("./store");

const hook = { kind: "hook", id: "worktree.created", label: "Setup" };
const setup = aTab({ id: "s", title: "Setup", position: 0, pinned: true, is_active: false, layout: { type: "leaf", pane_id: "ps" }, active_pane_id: "ps" });
const shell = aTab({ id: "t", title: "Tab 1", position: 1, layout: { type: "leaf", pane_id: "pt" }, active_pane_id: "pt" });

const initial = store.getState();
beforeEach(() => {
  store.setState({
    ...initial,
    panes: { ps: aPane({ id: "ps", tab_id: "s", source: hook }), pt: aPane({ id: "pt", tab_id: "t" }) },
    tabs: { w1: [setup, shell] },
    ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1" },
  });
});
afterEach(cleanup);

const bar = () =>
  render(
    <LayoutDnd>
      <TabBar worktreeId="w1" />
    </LayoutDnd>,
  ).container;

describe("the tab strip", () => {
  it("draws a pinned tab first as an icon with its title only in the accessible name", () => {
    const tabs = [...bar().querySelectorAll(".tab")];
    expect(tabs.map((t) => t.classList.contains("tab-pinned"))).toEqual([true, false]);
    expect(tabs[0]).toHaveAttribute("aria-label", "Setup");
    expect(tabs[0].querySelector(".tab-title")).toBeNull();
    expect(tabs[0].querySelector(".tab-close")).toBeNull();
    expect(tabs[1].querySelector(".tab-title")).toHaveTextContent("Tab 1");
  });

  it("marks a running setup hook as working and a failed one as dead", () => {
    expect(bar().querySelector(".tab-pinned .tab-pin-mark")).toHaveClass("state-working");
    cleanup();
    store.setState({ panes: { ...store.getState().panes, ps: aPane({ id: "ps", tab_id: "s", source: hook, hook_exit_code: 2 }) } });
    const mark = bar().querySelector(".tab-pinned .tab-pin-mark");
    expect(mark).toHaveClass("state-fail");
    expect(mark).toHaveAttribute("title", "hook exited 2");
  });

  it("shows no mark for a plain shell", () => {
    expect(bar().querySelectorAll(".tab")[1].querySelector(".state")).toBeNull();
  });
});

describe("hookStatus", () => {
  const run = (patch: Parameters<typeof aPane>[0]) => hookStatus(aPane({ source: hook, ...patch }));
  it("maps the exit of the hook command onto the marks", () => {
    expect(run({})).toBe("working");
    expect(run({ hook_exit_code: 0 })).toBe("done");
    expect(run({ hook_exit_code: 1 })).toBe("failed");
    expect(run({ live: false, exit_code: 3 })).toBe("failed");
    expect(run({ live: false, exit_code: null })).toBeNull();
    expect(hookStatus(aPane({ hook_exit_code: 1 }))).toBeNull();
  });
});

describe("pinned order", () => {
  const tabs = [aTab({ id: "p", pinned: true }), aTab({ id: "a", position: 1 }), aTab({ id: "b", position: 2 })];
  it("keeps a move inside its own group, like the daemon", () => {
    expect(reorderTabs(tabs, "b", 0).map((t) => t.id)).toEqual(["p", "b", "a"]);
    expect(reorderTabs(tabs, "p", 2).map((t) => t.id)).toEqual(["p", "a", "b"]);
  });

  it("offers pin or unpin and no move across the boundary", () => {
    store.setState({ tabs: { w1: tabs } });
    const labels = (id: string) => tabMenu(tabs.find((t) => t.id === id)!, () => {}).flatMap((i) => ("label" in i ? [[i.label, !!i.disabled]] : []));
    expect(labels("p")).toContainEqual(["unpin tab", false]);
    expect(labels("p")).toContainEqual(["move right", true]);
    expect(labels("a")).toContainEqual(["pin tab", false]);
    expect(labels("a")).toContainEqual(["move left", true]);
    expect(labels("a")).toContainEqual(["move right", false]);
  });
});
