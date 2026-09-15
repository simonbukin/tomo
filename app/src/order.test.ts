import { describe, expect, it } from "vitest";
import { byManualOrder, mainFirst, moveId } from "./order";

describe("moveId", () => {
  it("moves before and after a target", () => {
    expect(moveId(["a", "b", "c", "d"], "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveId(["a", "b", "c", "d"], "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveId(["a", "b", "c"], "c", "c", "before")).toEqual(["a", "b", "c"]);
  });
  it("ignores unknown ids", () => {
    expect(moveId(["a", "b"], "x", "a", "before")).toEqual(["a", "b"]);
    expect(moveId(["a", "b"], "a", "x", "after")).toEqual(["a", "b"]);
  });
});

describe("byManualOrder", () => {
  it("puts known ids in order and keeps new ones after, in input order", () => {
    const items = ["n1", "b", "a", "n2"].map((id) => ({ id }));
    expect(byManualOrder(items, ["a", "b"], (x) => x.id).map((x) => x.id)).toEqual(["a", "b", "n1", "n2"]);
  });
});

describe("mainFirst", () => {
  it("pins the main worktree", () => {
    const list = [{ id: "x", is_main: false }, { id: "m", is_main: true }, { id: "y", is_main: false }];
    expect(mainFirst(list).map((w) => w.id)).toEqual(["m", "x", "y"]);
  });
});
