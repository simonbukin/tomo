import { describe, expect, it } from "vitest";
import { activityStatus } from "./activityKinds";
import { agentStatus, agentTitle, dotClass, effectiveState, GLYPH, STATUS_LABEL, subagentStatus } from "./glyphs";
import type { AgentPresence } from "./types";
import { durationLabel, gitLines } from "./previewModel";
import type { GitSummary } from "./types";

describe("status glyphs", () => {
  it("gives every status its own glyph", () => {
    expect(new Set(Object.values(GLYPH)).size).toBe(Object.keys(GLYPH).length);
    expect(GLYPH).toEqual({ working: "●", needs: "◉", idle: "○", done: "■", complete: "✓", failed: "×", unknown: "?" });
  });

  it("gives each agent state its own mark: done is not complete, dead is failed", () => {
    const marks = (["working", "waiting", "done", "idle", "dead", "unknown"] as const).map((state) => dotClass(agentStatus(state)));
    expect(marks).toEqual(["state state-working", "state state-waiting", "state state-done", "state state-idle", "state state-fail", "state state-unknown"]);
    expect(agentStatus("exited")).toBe("complete");
    expect(subagentStatus("exited")).toBe("done");
    expect(STATUS_LABEL.unknown).toBe("no signal");
  });

  it("shows a done or idle agent with a running subagent as working", () => {
    const sub = (state: AgentPresence["state"]) => [{ id: "s", label: "Explore", description: null, state, started_at_ms: 0, updated_at_ms: 0 }];
    expect(effectiveState({ state: "done", subagents: sub("working") })).toBe("working");
    expect(effectiveState({ state: "idle", subagents: sub("waiting") })).toBe("working");
    expect(effectiveState({ state: "idle", subagents: sub("exited") })).toBe("idle");
    expect(effectiveState({ state: "dead", subagents: sub("working") })).toBe("dead");
    expect(effectiveState({ state: "waiting", subagents: sub("working") })).toBe("waiting");
  });

  it("says what a mark means in its tooltip", () => {
    const now = 10 * 60_000;
    const title = (state: AgentPresence["state"], estimated = false) => agentTitle({ state, updated_at_ms: now - 3 * 60_000, estimated }, now);
    expect(title("working")).toBe("working · 3 min");
    expect(title("done")).toBe("done · finished 3 min ago");
    expect(title("waiting")).toBe("needs you");
    expect(title("idle")).toBe("idle");
    expect(title("dead")).toBe("dead · exited");
    expect(title("unknown")).toBe("no signal · run `tomo integrations install`");
    expect(title("working", true)).toBe("working · 3 min (estimated from CPU)");
    expect(title("unknown", true)).toBe("no signal · run `tomo integrations install`");
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
