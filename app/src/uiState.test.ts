import { describe, expect, it } from "vitest";
import { defaultUi, sanitizeUi } from "./uiState";
import type { UiState } from "./types";

describe("sanitizeUi", () => {
  it("falls back to defaults for missing or malformed state", () => {
    expect(sanitizeUi(null, [])).toEqual(defaultUi);
    expect(sanitizeUi("nope", [])).toEqual(defaultUi);
    expect(sanitizeUi([1, 2], [])).toEqual(defaultUi);
  });

  it("keeps a valid arrangement exactly", () => {
    const saved: UiState = {
      ...defaultUi,
      view: "worktree",
      activeWorktreeId: "w1",
      leftOpen: false,
      rightOpen: true,
      leftWidth: 300,
      rightWidth: 420,
      sidebarSort: "manual",
      collapsedRepos: ["r1"],
      home: { query: "labor", filters: [{ kind: "state", value: "active" }], view: "board", sort: "recent", group: "repo", showArchived: true },
      manualOrder: { r1: ["w2", "w1"] },
      repoOrder: ["r2", "r1"],
    };
    expect(sanitizeUi(JSON.parse(JSON.stringify(saved)), ["w1", "w2"])).toEqual(saved);
  });

  it("clamps sidebar widths and rejects non-numbers", () => {
    const ui = sanitizeUi({ leftWidth: 9999, rightWidth: "wide" }, []);
    expect(ui.leftWidth).toBe(480);
    expect(ui.rightWidth).toBe(defaultUi.rightWidth);
    expect(sanitizeUi({ leftWidth: 12.4, rightWidth: Number.NaN }, []).leftWidth).toBe(180);
  });

  it("goes home when the active worktree is not in the snapshot, but keeps its id", () => {
    const ui = sanitizeUi({ view: "worktree", activeWorktreeId: "late" }, ["w1"]);
    expect(ui.view).toBe("home");
    expect(ui.activeWorktreeId).toBe("late");
    expect(sanitizeUi({ view: "worktree", activeWorktreeId: 7 }, []).activeWorktreeId).toBeNull();
    expect(sanitizeUi({ view: "settings" }, []).view).toBe("home");
  });

  it("drops bad Home filters, lists, and enum values", () => {
    const ui = sanitizeUi(
      { home: { query: 3, filters: [{ kind: "priority", value: "1" }, { kind: "tag", value: "x" }, "junk"], view: "grid", sort: "size" }, collapsedRepos: ["r1", 2], manualOrder: { r1: ["a", null], r2: "b" }, sidebarSort: "random" },
      [],
    );
    expect(ui.home).toEqual({ ...defaultUi.home, filters: [{ kind: "tag", value: "x" }] });
    expect(ui.collapsedRepos).toEqual(["r1"]);
    expect(ui.manualOrder).toEqual({ r1: ["a"] });
    expect(ui.sidebarSort).toBe("name");
  });

  it("passes unknown keys through for fields added later", () => {
    expect((sanitizeUi({ futureField: { a: 1 } }, []) as unknown as Record<string, unknown>).futureField).toEqual({ a: 1 });
  });
});
