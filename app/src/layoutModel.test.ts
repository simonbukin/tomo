import { describe, expect, it } from "vitest";
import { dropRegion, insertionSide, leafIds, movePane, reorder, reorderTabs } from "./layoutModel";
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
