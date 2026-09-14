import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, mergeActivity, needsMeItems, nowSignals, resetsIn, truncate, usageSummary, type SignalInput } from "./activityModel";
import type { ActivityEvent, AgentPresence, AttentionItem, RuntimeEndpoint } from "./types";

const attention = (extra: Partial<AttentionItem>): AttentionItem => ({ id: "a", worktree_id: "w", pane_id: null, level: "attention", message: "m", created_at_ms: 1, viewed_at_ms: null, kind: "waiting", url: null, agent_kind: "claude", resolved_at_ms: null, ...extra });
const agent = (state: AgentPresence["state"], kind: AgentPresence["kind"] = "claude"): AgentPresence => ({ pane_id: `p-${kind}`, worktree_id: "w", kind, state, session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null });
const endpoint = (extra: Partial<RuntimeEndpoint> = {}): RuntimeEndpoint => ({ id: "e", worktree_id: "w", pane_id: null, action_id: "dev", pid: 1, process: "node", protocol: "http", host: "localhost", port: 3000, label: null, discovered_at_ms: 0, ...extra });
const event = (id: string, occurred_at_ms: number): ActivityEvent => ({ id, kind: "agent_started", occurred_at_ms, worktree_id: "w", pane_id: null, agent_kind: "claude", title: "t", detail: null, payload: null, attention_id: null });
const quiet: SignalInput = { attention: [], agents: [], endpoints: [], actions: [], rssBytes: null, warnBytes: 1000, pr: null };

describe("needsMeItems", () => {
  it("keeps unresolved checkpoints and crashes even after a view, drops viewed waiting items", () => {
    const list = [
      attention({ id: "viewed-wait", viewed_at_ms: 5 }),
      attention({ id: "wait" }),
      attention({ id: "cp", kind: "checkpoint", viewed_at_ms: 9 }),
      attention({ id: "done", kind: "crash", resolved_at_ms: 3 }),
    ];
    expect(needsMeItems(list).map((a) => a.id)).toEqual(["wait", "cp"]);
  });
  it("puts the least recently viewed item first so next_attention cycles", () => {
    const list = [attention({ id: "b", kind: "crash", viewed_at_ms: 20 }), attention({ id: "a", kind: "checkpoint", viewed_at_ms: 10 })];
    expect(needsMeItems(list).map((a) => a.id)).toEqual(["a", "b"]);
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
    const out = nowSignals({ ...quiet, agents: [agent("working")], endpoints: [endpoint()], actions: [{ id: "dev", label: "App", command: "pnpm dev", mode: "pane", show: "topbar", shortcut: null }] });
    expect(out).toEqual([
      { kind: "agent", agent: "claude", state: "working" },
      { kind: "runtime", label: "App", port: 3000, url: "http://localhost:3000" },
    ]);
  });
  it("puts attention first, then crash, and caps at three", () => {
    const out = nowSignals({
      ...quiet,
      agents: [agent("waiting"), agent("working", "codex")],
      attention: [attention({ id: "cp", kind: "checkpoint" }), attention({ id: "cr", kind: "crash", message: "Sampler crashed" })],
      endpoints: [endpoint()],
      rssBytes: 5000,
    });
    expect(out).toEqual([
      { kind: "attention", text: "Claude needs input" },
      { kind: "attention", text: "review requested" },
      { kind: "crash", text: "Sampler crashed" },
    ]);
  });
  it("does not repeat a waiting agent as an active agent", () => {
    expect(nowSignals({ ...quiet, agents: [agent("waiting")] })).toEqual([{ kind: "attention", text: "Claude needs input" }]);
  });
  it("warns on memory only at the threshold, and reports a merged pr", () => {
    expect(nowSignals({ ...quiet, rssBytes: 999 })).toEqual([]);
    expect(nowSignals({ ...quiet, rssBytes: 1000 })).toEqual([{ kind: "warn", bytes: 1000 }]);
    const pr = { number: 1, title: "t", url: "u", state: "merged", draft: false, review_decision: null, mergeable: null, checks_passed: 0, checks_failed: 0, checks_pending: 0, fetched_at_ms: 0 };
    expect(nowSignals({ ...quiet, pr })).toEqual([{ kind: "pr", text: "merged", tone: "merged" }]);
  });
});

describe("text helpers", () => {
  it("truncates long messages at 80 chars", () => {
    expect(truncate("x".repeat(80))).toHaveLength(80);
    expect(truncate("x".repeat(81))).toHaveLength(80);
    expect(truncate("x".repeat(81)).endsWith("…")).toBe(true);
  });
  it("summarizes usage buckets", () => {
    expect(usageSummary({ provider: "claude", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "5h", fraction_used: 0.48, resets_at_ms: null, detail: null }, { label: "wk", fraction_used: 0.83, resets_at_ms: null, detail: null }] })).toBe("claude 48% 5h · 83% wk");
  });
  it("formats reset times", () => {
    expect(resetsIn(2 * 3_600_000, 0)).toBe("resets in 2h");
    expect(resetsIn(5 * 60_000, 0)).toBe("resets in 5m");
    expect(resetsIn(null, 0)).toBeNull();
  });
});
