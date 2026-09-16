import { describe, expect, it } from "vitest";
import { dropRegion, insertionSide, leafIds, moveBoxes, movePane, paneBoxes, reorder, reorderTabs, stickyRegion } from "./layoutModel";
import type { LayoutNode, Tab } from "./types";

const box = { left: 100, top: 50, width: 400, height: 200 };
const leaf = (pane_id: string): LayoutNode => ({ type: "leaf", pane_id });
const split = (id: string, direction: "horizontal" | "vertical", first: LayoutNode, second: LayoutNode): LayoutNode => ({ type: "split", id, direction, ratio: 0.5, first, second });

describe("dropRegion", () => {
  it("maps the outer quarter of each side to that side and the middle to center", () => {
    expect(dropRegion(box, 300, 150)).toBe("center");
    expect(dropRegion(box, 110, 150)).toBe("left");
    expect(dropRegion(box, 490, 150)).toBe("right");
    expect(dropRegion(box, 300, 55)).toBe("top");
    expect(dropRegion(box, 300, 245)).toBe("bottom");
  });
  it("picks the nearer edge in a corner", () => {
    expect(dropRegion(box, 105, 90)).toBe("left");
    expect(dropRegion(box, 180, 52)).toBe("top");
    expect(dropRegion(box, 495, 248)).toBe("bottom");
  });
  it("treats points outside the box as edges and survives an empty box", () => {
    expect(dropRegion(box, 0, 150)).toBe("left");
    expect(dropRegion(box, 300, 900)).toBe("bottom");
    expect(dropRegion({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toBe("center");
  });
});

describe("stickyRegion", () => {
  it("starts from the plain region and records the point", () => {
    expect(stickyRegion(box, 110, 150, null)).toEqual({ place: "left", x: 110, y: 150 });
  });
  it("holds the region while the pointer stays inside the slack", () => {
    const last = stickyRegion(box, 198, 150, null);
    expect(last.place).toBe("left");
    expect(stickyRegion(box, 202, 150, last)).toBe(last);
    expect(stickyRegion(box, 198, 158, last)).toBe(last);
  });
  it("holds a center that the pointer has just left, and gives way when the pointer clears the slack", () => {
    const inside = stickyRegion(box, 205, 150, null);
    expect(inside.place).toBe("center");
    expect(stickyRegion(box, 199, 150, inside)).toBe(inside);
    expect(stickyRegion(box, 193, 150, inside)).toEqual({ place: "left", x: 193, y: 150 });
  });
});

describe("reorder", () => {
  it("moves one id and clamps the position", () => {
    expect(reorder(["a", "b", "c", "d"], "c", 1)).toEqual(["a", "c", "b", "d"]);
    expect(reorder(["a", "b", "c", "d"], "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(reorder(["a", "b", "c", "d"], "d", -3)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });
  it("renumbers tab positions", () => {
    const tabs = ["Claude", "shell", "App", "Sampler"].map((title, i) => ({ id: title, title, position: i * 10, worktree_id: "w", layout: leaf(title), active_pane_id: title, is_active: i === 0 }) satisfies Tab);
    const next = reorderTabs(tabs, "App", 1);
    expect(next.map((t) => t.title)).toEqual(["Claude", "App", "shell", "Sampler"]);
    expect(next.map((t) => t.position)).toEqual([0, 1, 2, 3]);
    expect(tabs[2].position).toBe(20);
  });
});

describe("insertionSide", () => {
  it("shows the line after a tab to the right and before a tab to the left", () => {
    expect(insertionSide(0, 3)).toBe("after");
    expect(insertionSide(3, 1)).toBe("before");
    expect(insertionSide(2, 2)).toBeNull();
    expect(insertionSide(-1, 2)).toBeNull();
  });
});

describe("movePane", () => {
  const root = split("s1", "horizontal", leaf("a"), split("s2", "vertical", leaf("b"), leaf("c")));
  it("splits the target on each side and collapses the old parent", () => {
    expect(movePane(root, "c", "a", "left", "n")).toEqual(split("s1", "horizontal", split("n", "horizontal", leaf("c"), leaf("a")), leaf("b")));
    expect(movePane(root, "a", "c", "bottom", "n")).toEqual(split("s2", "vertical", leaf("b"), split("n", "vertical", leaf("c"), leaf("a"))));
    expect(movePane(root, "b", "a", "top", "n")).toEqual(split("s1", "horizontal", split("n", "vertical", leaf("b"), leaf("a")), leaf("c")));
    expect(movePane(root, "a", "b", "right", "n")).toEqual(split("s2", "vertical", split("n", "horizontal", leaf("b"), leaf("a")), leaf("c")));
  });
  it("swaps on center and ignores self and stale ids", () => {
    expect(leafIds(movePane(root, "a", "c", "center", "n")!)).toEqual(["c", "b", "a"]);
    expect(movePane(root, "a", "a", "left", "n")).toBeNull();
    expect(movePane(root, "x", "a", "left", "n")).toBeNull();
    expect(movePane(leaf("a"), "a", "b", "left", "n")).toBeNull();
  });
  it("keeps the pane set through many random moves", () => {
    let tree = root;
    const places = ["center", "left", "right", "top", "bottom"] as const;
    for (let i = 0; i < 300; i++) {
      const ids = leafIds(tree);
      const next = movePane(tree, ids[(i * 7) % ids.length], ids[(i * 3 + 1) % ids.length], places[i % 5], `m${i}`);
      if (next) tree = next;
      expect([...leafIds(tree)].sort()).toEqual(["a", "b", "c"]);
    }
  });
});

const area = { left: 0, top: 0, width: 408, height: 208 };
const nested = split("s1", "horizontal", leaf("a"), split("s2", "vertical", leaf("b"), leaf("c")));

describe("paneBoxes", () => {
  it("gives the whole box to a single pane", () => {
    expect(paneBoxes(leaf("a"), area, 8).get("a")).toEqual(area);
  });
  it("splits by ratio and keeps the gap for the divider", () => {
    const boxes = paneBoxes(split("s", "horizontal", leaf("a"), leaf("b")), area, 8);
    expect(boxes.get("a")).toEqual({ left: 0, top: 0, width: 200, height: 208 });
    expect(boxes.get("b")).toEqual({ left: 208, top: 0, width: 200, height: 208 });
  });
  it("nests, so a child splits only its own box", () => {
    const boxes = paneBoxes(nested, area, 8);
    expect(boxes.get("a")).toEqual({ left: 0, top: 0, width: 200, height: 208 });
    expect(boxes.get("b")).toEqual({ left: 208, top: 0, width: 200, height: 100 });
    expect(boxes.get("c")).toEqual({ left: 208, top: 108, width: 200, height: 100 });
  });
  it("follows a ratio that is not one half", () => {
    const node: LayoutNode = { type: "split", id: "s", direction: "horizontal", ratio: 0.25, first: leaf("a"), second: leaf("b") };
    const boxes = paneBoxes(node, area, 8);
    expect(boxes.get("a")).toEqual({ left: 0, top: 0, width: 100, height: 208 });
    expect(boxes.get("b")).toEqual({ left: 108, top: 0, width: 300, height: 208 });
  });
  it("stays at zero in a box smaller than the gap", () => {
    const boxes = paneBoxes(split("s", "horizontal", leaf("a"), leaf("b")), { left: 0, top: 0, width: 4, height: 4 }, 8);
    expect(boxes.get("a")!.width).toBe(0);
    expect(boxes.get("b")!.width).toBe(0);
  });
});

describe("moveBoxes", () => {
  it("shows half of the target and the reflow the move makes elsewhere", () => {
    const now = paneBoxes(nested, area, 8);
    const after = moveBoxes(nested, "c", "a", "left", area, 8)!;
    expect(after.get("c")).toEqual({ left: 0, top: 0, width: 96, height: 208 });
    expect(after.get("a")).toEqual({ left: 104, top: 0, width: 96, height: 208 });
    expect(now.get("b")).toEqual({ left: 208, top: 0, width: 200, height: 100 });
    expect(after.get("b")).toEqual({ left: 208, top: 0, width: 200, height: 208 });
  });
  it("swaps the two boxes on center and leaves the rest alone", () => {
    const now = paneBoxes(nested, area, 8);
    const after = moveBoxes(nested, "a", "c", "center", area, 8)!;
    expect(after.get("a")).toEqual(now.get("c"));
    expect(after.get("c")).toEqual(now.get("a"));
    expect(after.get("b")).toEqual(now.get("b"));
  });
  it("has nothing to draw for a drop on the pane itself or a stale id", () => {
    expect(moveBoxes(nested, "a", "a", "left", area, 8)).toBeNull();
    expect(moveBoxes(nested, "zz", "a", "left", area, 8)).toBeNull();
    expect(moveBoxes(leaf("a"), "a", "b", "left", area, 8)).toBeNull();
  });
  it("keeps every preview inside the layout box for every region", () => {
    for (const place of ["center", "left", "right", "top", "bottom"] as const) {
      for (const b of moveBoxes(nested, "c", "a", place, area, 8)!.values()) {
        expect(b.width).toBeGreaterThanOrEqual(0);
        expect(b.height).toBeGreaterThanOrEqual(0);
        expect(b.left).toBeGreaterThanOrEqual(area.left);
        expect(b.top).toBeGreaterThanOrEqual(area.top);
        expect(b.left + b.width).toBeLessThanOrEqual(area.left + area.width);
        expect(b.top + b.height).toBeLessThanOrEqual(area.top + area.height);
      }
    }
  });
});
