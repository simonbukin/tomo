import { beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../store";
import { defaultUi, sanitizeUi } from "../uiState";
import { columnWidth, cycleSidebar, MIDDLE_MIN_WIDTH, RAIL_WIDTH, shellLayout, snapPatch, snapSidebar, SNAP_CLOSED_BELOW, SNAP_MINIMAL_BELOW } from "./sidebarMode";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { toggleSidebar } = await import("../commands/shell");
const { allActions } = await import("../actions");

const initial = getState();
beforeEach(() => setState({ ...initial, ui: { ...defaultUi } }));

describe("sidebar cycle", () => {
  it("goes open, minimal, closed, open", () => {
    expect([cycleSidebar("open"), cycleSidebar("minimal"), cycleSidebar("closed")]).toEqual(["minimal", "closed", "open"]);
  });

  it("restores the open width after minimal and closed (scenario A)", () => {
    toggleSidebar("left", 1400);
    expect(getState().ui.leftMode).toBe("minimal");
    toggleSidebar("left", 1400);
    expect(getState().ui.leftMode).toBe("closed");
    toggleSidebar("left", 1400);
    expect(getState().ui).toMatchObject({ leftMode: "open", leftWidth: defaultUi.leftWidth });
  });

  it("cycles from the mode on screen when a narrow window collapsed the sidebar", () => {
    setState({ ui: { ...defaultUi, view: "worktree" } });
    expect(shellLayout(getState().ui, 600, true).left).toBe("minimal");
    toggleSidebar("left", 600);
    expect(getState().ui.leftMode).toBe("closed");
  });

  it("registers a set command for every mode on both sides", () => {
    const ids = allActions().filter((a) => a.group === "Navigation").map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["toggle_left_sidebar", "toggle_right_sidebar", "left_sidebar_open", "left_sidebar_minimal", "left_sidebar_closed", "right_sidebar_open", "right_sidebar_minimal", "right_sidebar_closed"]));
    allActions().find((a) => a.id === "right_sidebar_minimal")!.run();
    expect(getState().ui.rightMode).toBe("minimal");
  });
});

describe("snapSidebar", () => {
  it("snaps near zero closed, a narrow range minimal, and resizes freely beyond it", () => {
    expect(snapSidebar(0)).toEqual({ mode: "closed", width: null });
    expect(snapSidebar(SNAP_CLOSED_BELOW - 1)).toEqual({ mode: "closed", width: null });
    expect(snapSidebar(SNAP_CLOSED_BELOW)).toEqual({ mode: "minimal", width: null });
    expect(snapSidebar(RAIL_WIDTH)).toEqual({ mode: "minimal", width: null });
    expect(snapSidebar(SNAP_MINIMAL_BELOW - 1)).toEqual({ mode: "minimal", width: null });
    expect(snapSidebar(SNAP_MINIMAL_BELOW)).toEqual({ mode: "open", width: 180 });
    expect(snapSidebar(286.4)).toEqual({ mode: "open", width: 286 });
    expect(snapSidebar(900)).toEqual({ mode: "open", width: 480 });
    expect(snapSidebar(-40).mode).toBe("closed");
    expect(snapSidebar(Number.NaN).mode).toBe("closed");
  });

  it("keeps the saved open width when a drag lands on minimal or closed", () => {
    expect(snapPatch("left", 30)).toEqual({ leftMode: "minimal" });
    expect(snapPatch("right", 5)).toEqual({ rightMode: "closed" });
    expect(snapPatch("right", 320)).toEqual({ rightMode: "open", rightWidth: 320 });
  });

  it("restores a dragged width after minimal and a restart (scenario B)", () => {
    const dragged = { ...defaultUi, leftWidth: 260, ...snapPatch("left", 340) };
    const minimal = { ...dragged, leftMode: cycleSidebar(dragged.leftMode) };
    const reopened = { ...minimal, leftMode: "open" as const };
    expect(columnWidth(minimal.leftMode, minimal.leftWidth)).toBe(RAIL_WIDTH);
    expect(columnWidth(reopened.leftMode, reopened.leftWidth)).toBe(340);
    expect(sanitizeUi(JSON.parse(JSON.stringify(reopened)), [])).toMatchObject({ leftMode: "open", leftWidth: 340 });
  });
});

describe("shellLayout", () => {
  const ui = { leftMode: "open", rightMode: "open", leftWidth: 240, rightWidth: 280 } as const;

  it("keeps the preference when the window is wide enough", () => {
    expect(shellLayout(ui, 1400, true)).toEqual({ left: "open", right: "open", leftCol: 240, rightCol: 280 });
  });

  it("closes the right column when there is nothing to inspect", () => {
    expect(shellLayout(ui, 1400, false)).toEqual({ left: "open", right: "closed", leftCol: 240, rightCol: 0 });
  });

  it("collapses the right first, then the left, to keep the middle usable", () => {
    const at = (w: number) => {
      const l = shellLayout(ui, w, true);
      return [l.left, l.right];
    };
    expect(at(240 + 280 + MIDDLE_MIN_WIDTH)).toEqual(["open", "open"]);
    expect(at(240 + 280 + MIDDLE_MIN_WIDTH - 1)).toEqual(["open", "minimal"]);
    expect(at(240 + RAIL_WIDTH + MIDDLE_MIN_WIDTH - 1)).toEqual(["open", "closed"]);
    expect(at(240 + MIDDLE_MIN_WIDTH - 1)).toEqual(["minimal", "closed"]);
    expect(at(RAIL_WIDTH + MIDDLE_MIN_WIDTH - 1)).toEqual(["closed", "closed"]);
    expect(at(100)).toEqual(["closed", "closed"]);
  });

  it("never changes the saved preference", () => {
    const saved = { ...ui };
    shellLayout(saved, 300, true);
    expect(saved).toEqual(ui);
  });
});
