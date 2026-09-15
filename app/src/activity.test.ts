import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, mergeActivity, needsMeItem, needsMeItems, nowSignals, resetsIn, sparkCells, truncate, type SignalInput } from "./activityModel";
import type { ActivityEvent, AgentPresence, AttentionItem, RuntimeEndpoint } from "./types";

const attention = (extra: Partial<AttentionItem>): AttentionItem => ({ id: "a", worktree_id: "w", pane_id: null, level: "attention", message: "m", created_at_ms: 1, viewed_at_ms: null, kind: "waiting", url: null, agent_kind: "claude", resolved_at_ms: null, ...extra });
const agent = (state: AgentPresence["state"], kind: AgentPresence["kind"] = "claude"): AgentPresence => ({ pane_id: `p-${kind}`, worktree_id: "w", kind, state, session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null });
const endpoint = (extra: Partial<RuntimeEndpoint> = {}): RuntimeEndpoint => ({ id: "e", worktree_id: "w", pane_id: null, action_id: "dev", pid: 1, process: "node", protocol: "http", host: "localhost", port: 3000, label: null, discovered_at_ms: 0, source: null, ...extra });
const event = (id: string, occurred_at_ms: number): ActivityEvent => ({ id, kind: "agent_started", occurred_at_ms, worktree_id: "w", pane_id: null, agent_kind: "claude", title: "t", detail: null, payload: null, attention_id: null });
const quiet: SignalInput = { attention: [], agents: [], endpoints: [], rssBytes: null, warnBytes: 1000, addon: [] };

describe("needsMeItems", () => {
  it("keeps unresolved checkpoints and crashes even after a view, drops viewed waiting items", () => {
    const list = [
      attention({ id: "viewed-wait", viewed_at_ms: 5 }),
      attention({ id: "wait", pane_id: "p-claude" }),
      attention({ id: "cp", kind: "checkpoint", viewed_at_ms: 9 }),
      attention({ id: "done", kind: "crash", resolved_at_ms: 3 }),
    ];
    expect(needsMeItems(list, [agent("waiting")]).map((a) => a.id)).toEqual(["wait", "cp"]);
  });
  it("puts the least recently viewed item first so next_attention cycles", () => {
    const list = [attention({ id: "b", kind: "crash", viewed_at_ms: 20 }), attention({ id: "a", kind: "checkpoint", viewed_at_ms: 10 })];
    expect(needsMeItems(list, []).map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("needsMeItem cases", () => {
  const onPane = (extra: Partial<AttentionItem>) => attention({ pane_id: "p-claude", ...extra });
  const cases: [string, AttentionItem, AgentPresence[], boolean][] = [
    ["waiting, agent waits", onPane({}), [agent("waiting")], true],
    ["waiting, agent moved on", onPane({}), [agent("working")], false],
    ["waiting, no agent in the pane", onPane({}), [], false],
    ["waiting, viewed", onPane({ viewed_at_ms: 2 }), [agent("waiting")], false],
    ["waiting, resolved", onPane({ resolved_at_ms: 2 }), [agent("waiting")], false],
    ["checkpoint, viewed, agent working", onPane({ kind: "checkpoint", viewed_at_ms: 2 }), [agent("working")], true],
    ["checkpoint, resolved", onPane({ kind: "checkpoint", resolved_at_ms: 2 }), [], false],
    ["crash, viewed, no agent", onPane({ kind: "crash", viewed_at_ms: 2 }), [], true],
    ["crash, resolved", onPane({ kind: "crash", resolved_at_ms: 2 }), [], false],
  ];
  it.each(cases)("%s", (_, item, agents, expected) => {
    expect(needsMeItem(item, agents)).toBe(expected);
  });
});

describe("day grouping", () => {
  const now = new Date(2026, 8, 14, 15, 0).getTime();
  it("labels today, yesterday, and older days", () => {
    expect(dayLabel(now - 60_000, now)).toBe("today");
    expect(dayLabel(new Date(2026, 8, 13, 23, 59).getTime(), now)).toBe("yesterday");
    expect(dayLabel(new Date(2026, 8, 7, 9, 0).getTime(), now)).toBe("Mon 7 Sep");
  });
  it("groups consecutive events by day, newest first", () => {
    const groups = groupByDay([event("1", now - 1000), event("2", now - 2000), event("3", new Date(2026, 8, 13, 8, 0).getTime())], now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([["today", 2], ["yesterday", 1]]);
  });
});

describe("mergeActivity", () => {
  it("dedupes by id, sorts newest first, and caps", () => {
    const merged = mergeActivity([event("a", 1), event("b", 2)], [event("b", 2), event("c", 3)], 2);
    expect(merged.map((e) => e.id)).toEqual(["c", "b"]);
  });
});

describe("nowSignals", () => {
  it("shows nothing for a quiet worktree", () => {
    expect(nowSignals(quiet)).toEqual([]);
  });
  it("shows the agent and the primary runtime for a healthy busy worktree", () => {
    const out = nowSignals({ ...quiet, agents: [agent("working")], endpoints: [endpoint({ label: "App" })] });
    expect(out).toEqual([
      { kind: "agent", agent: "claude", state: "working" },
      { kind: "runtime", label: "App", port: 3000, url: "http://localhost:3000" },
    ]);
  });
  it("puts a checkpoint first, then the waiting agent itself, then a crash, and caps at three", () => {
    const out = nowSignals({
      ...quiet,
      agents: [agent("working", "codex"), agent("waiting")],
      attention: [attention({ id: "cp", kind: "checkpoint" }), attention({ id: "cr", kind: "crash", message: "Sampler crashed" })],
      endpoints: [endpoint()],
      rssBytes: 5000,
    });
    expect(out).toEqual([
      { kind: "attention", text: "review requested" },
      { kind: "agent", agent: "claude", state: "waiting" },
      { kind: "crash", text: "Sampler crashed" },
    ]);
  });
  it("shows a waiting agent once, as the agent line, not as a separate item", () => {
    expect(nowSignals({ ...quiet, agents: [agent("waiting")], attention: [attention({ pane_id: "p-claude" })] })).toEqual([{ kind: "agent", agent: "claude", state: "waiting" }]);
  });
  it("drops a stale waiting item once the agent is no longer waiting", () => {
    const stale = attention({ pane_id: "p-claude" });
    expect(needsMeItem(stale, [agent("working")])).toBe(false);
    expect(needsMeItem(stale, [agent("waiting")])).toBe(true);
    expect(nowSignals({ ...quiet, agents: [agent("working")], attention: [stale] })).toEqual([{ kind: "agent", agent: "claude", state: "working" }]);
  });
  it("warns on memory only at the threshold, and puts addon signals last", () => {
    expect(nowSignals({ ...quiet, rssBytes: 999 })).toEqual([]);
    expect(nowSignals({ ...quiet, rssBytes: 1000 })).toEqual([{ kind: "warn", bytes: 1000 }]);
    const note = { kind: "addon", text: "note", glyph: "✓", className: "signal-note", dot: "state-ok" } as const;
    expect(nowSignals({ ...quiet, rssBytes: 1000, addon: [note] })).toEqual([{ kind: "warn", bytes: 1000 }, note]);
    expect(nowSignals({ ...quiet, agents: [agent("working"), agent("idle", "codex")], rssBytes: 1000, addon: [note] })).toHaveLength(3);
    expect(nowSignals({ ...quiet, agents: [agent("working"), agent("idle", "codex")], rssBytes: 1000, addon: [note] })).not.toContainEqual(note);
  });
});

describe("text helpers", () => {
  it("truncates long messages at 80 chars", () => {
    expect(truncate("x".repeat(80))).toHaveLength(80);
    expect(truncate("x".repeat(81))).toHaveLength(80);
    expect(truncate("x".repeat(81)).endsWith("…")).toBe(true);
  });
  it("draws usage sparks", () => {
    expect(sparkCells(0.48)).toEqual({ filled: 5, empty: 5 });
    expect(sparkCells(1.2)).toEqual({ filled: 10, empty: 0 });
    expect(sparkCells(null)).toEqual({ filled: 0, empty: 10 });
    expect(sparkCells(0.04)).toEqual({ filled: 0, empty: 10 });
  });
  it("formats reset times", () => {
    expect(resetsIn(2 * 3_600_000, 0)).toBe("resets in 2h");
    expect(resetsIn(5 * 60_000, 0)).toBe("resets in 5m");
    expect(resetsIn(null, 0)).toBeNull();
  });
});
