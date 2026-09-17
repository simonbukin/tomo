import { describe, expect, it } from "vitest";
import { addressLabel, appsOfWorktree, mergeApps, sortApps, type AppRow } from "./appsModel";

const app = (over: Partial<AppRow> & { id: string }): AppRow => ({
  worktreeId: "w1",
  paneId: null,
  label: over.id,
  url: null,
  port: null,
  detail: null,
  source: null,
  ...over,
});

describe("sortApps", () => {
  it("orders by label", () => {
    expect(sortApps([app({ id: "c", label: "Storybook" }), app({ id: "a", label: "API" })]).map((r) => r.label)).toEqual(["API", "Storybook"]);
  });

  it("orders two apps of one label by port", () => {
    const rows = sortApps([app({ id: "b", label: "web", port: 4000 }), app({ id: "a", label: "web", port: 3000 })]);
    expect(rows.map((r) => r.port)).toEqual([3000, 4000]);
  });

  it("does not change the caller's list", () => {
    const rows = [app({ id: "b", label: "b" }), app({ id: "a", label: "a" })];
    sortApps(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("sorts nothing into nothing", () => {
    expect(sortApps([])).toEqual([]);
  });
});

describe("mergeApps", () => {
  it("joins the rows of every contributor", () => {
    const merged = mergeApps([[app({ id: "a", label: "api" })], [app({ id: "b", label: "web" })]]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps the first row of a repeated id", () => {
    const merged = mergeApps([[app({ id: "a", label: "first" })], [app({ id: "a", label: "second" })]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe("first");
  });

  it("handles a contributor with no rows", () => {
    expect(mergeApps([[], []])).toEqual([]);
  });
});

describe("addressLabel", () => {
  it("prefers the port", () => {
    expect(addressLabel(app({ id: "a", port: 3000, url: "http://localhost:3000" }))).toBe(":3000");
  });

  it("falls back to the address", () => {
    expect(addressLabel(app({ id: "a", url: "http://example.test" }))).toBe("http://example.test");
  });

  it("shows a dash when the app serves nothing", () => {
    expect(addressLabel(app({ id: "a" }))).toBe("—");
  });

  it("keeps port zero", () => {
    expect(addressLabel(app({ id: "a", port: 0 }))).toBe(":0");
  });
});

describe("appsOfWorktree", () => {
  it("keeps only the rows of one worktree", () => {
    const rows = [app({ id: "a", worktreeId: "w1" }), app({ id: "b", worktreeId: "w2" })];
    expect(appsOfWorktree(rows, "w1").map((r) => r.id)).toEqual(["a"]);
  });

  it("returns nothing for a worktree with no app", () => {
    expect(appsOfWorktree([app({ id: "a", worktreeId: "w1" })], "w9")).toEqual([]);
  });
});
