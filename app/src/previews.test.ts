import { describe, expect, it } from "vitest";
import { activityStatus } from "./activityKinds";
import { agentStatus, dotClass, GLYPH } from "./glyphs";
import { durationLabel, gitLines } from "./previewModel";
import type { GitSummary } from "./types";

describe("status glyphs", () => {
  it("gives every status its own glyph", () => {
    expect(new Set(Object.values(GLYPH)).size).toBe(Object.keys(GLYPH).length);
    expect(GLYPH).toEqual({ working: "●", needs: "◉", idle: "○", complete: "✓", failed: "×", unknown: "?" });
  });

  it("maps agents and activity onto the same vocabulary", () => {
    expect(agentStatus("waiting")).toBe("needs");
    expect(agentStatus("none")).toBeNull();
    expect(activityStatus("hook_failed")).toBe("failed");
    expect(activityStatus("checkpoint_created")).toBe(agentStatus("waiting"));
    expect(activityStatus("state_changed")).toBeNull();
    expect(dotClass("needs")).toBe("state state-waiting");
    expect(dotClass(null)).toBe("state state-none");
  });
});

describe("preview text", () => {
  it("formats short durations", () => {
    const now = 10 * 24 * 3600_000;
    expect(durationLabel(now - 20_000, now)).toBe("<1 min");
    expect(durationLabel(now - 12 * 60_000, now)).toBe("12 min");
    expect(durationLabel(now - 5 * 3600_000, now)).toBe("5 h");
    expect(durationLabel(now - 3 * 24 * 3600_000, now)).toBe("3 d");
    expect(durationLabel(now + 5000, now)).toBe("<1 min");
  });

  it("summarizes git state", () => {
    const g: GitSummary = { branch: "feat", head: "abc", detached: false, dirty: true, files_changed: 3, untracked: 1, conflicts: 0, insertions: 48, deletions: 12, ahead: 2, behind: null, upstream: "origin/feat" };
    expect(gitLines(g)).toEqual(["+48 −12", "3 files changed · 1 untracked", "↑2 ↓0 origin/feat"]);
    expect(gitLines({ ...g, files_changed: 0, untracked: 0, conflicts: 2, upstream: null })).toEqual(["+48 −12", "clean", "2 conflicts", "no upstream"]);
  });
});
