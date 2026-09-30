import { describe, expect, it } from "vitest";
import { agentLines, aboutDetails, leadLine, branchFlags, branchText, gitDetails, homePath, hoverAgentLines, problemLines, question, rowGroups, shortSession, type RowInput } from "./rowModel";
import type { AgentPresence, AttentionItem, GitSummary, Subagent, Worktree } from "./types";

const worktree = (over: Partial<Worktree> = {}): Worktree => ({
  id: "w1",
  repo_id: "r1",
  path: "/Users/you/tomo/worktrees/tomo/kobe",
  name: "kobe",
  branch: "fix/login-redirect",
  head: "abc1234",
  detached: false,
  is_main: false,
  exists: true,
  git: null,
  metadata: { display_name: null, tags: [] },
  last_active_ms: null,
  first_seen_ms: null,
  archived_at_ms: null,
  archiving: false,
  tab_count: 0,
  pane_count: 0,
  ...over,
});

const agent = (pane: string, state: AgentPresence["state"], over: Partial<AgentPresence> = {}): AgentPresence => ({
  pane_id: pane,
  worktree_id: "w1",
  kind: "claude",
  state,
  session_ref: null,
  authority: "report",
  updated_at_ms: 0,
  pid: null,
  estimated: false,
  seen: false,
  ...over,
});

const sub = (id: string, state: AgentPresence["state"], description: string | null = `task ${id}`): Subagent => ({ id, label: "Explore", description, state, started_at_ms: 0, updated_at_ms: 0 });

const attention = (over: Partial<AttentionItem>): AttentionItem => ({ id: "a1", worktree_id: "w1", pane_id: "p1", level: "attention", message: "Claude is waiting for you", created_at_ms: 1, viewed_at_ms: null, kind: "waiting", url: null, agent_kind: "claude", resolved_at_ms: null, ...over });

const input = (over: Partial<RowInput> = {}): RowInput => ({ worktree: worktree(), agents: [], attention: [], exitCodes: {}, rssBytes: null, warnBytes: 2 * GB, rowError: null, apps: [], ...over });

const GB = 1024 ** 3;

const texts = (lines: { label?: string; text?: string }[]) => lines.map((l) => [l.label, l.text].filter(Boolean).join(" "));

describe("agent lines on the row", () => {
  it("draws no line for an idle, sleeping, or exited agent: the row mark says it", () => {
    const agents = [agent("p1", "idle"), agent("p2", "done", { sleep: "asleep" }), agent("p3", "idle", { sleep: "asleep" })];
    expect(agentLines(input({ agents }))).toEqual([]);
  });

  it("draws the kind alone for a working agent and a done one, with no state words", () => {
    const lines = agentLines(input({ agents: [agent("p1", "working"), agent("p2", "done", { kind: "codex" })] }));
    expect(texts(lines)).toEqual(["claude", "codex"]);
    expect(lines.map((l) => l.mark)).toEqual(["working", "done"]);
  });

  it("says the question when an agent needs you, and nothing when the only words are Tomo's own", () => {
    const needs = agent("p1", "waiting");
    expect(texts(agentLines(input({ agents: [needs], attention: [attention({})] })))).toEqual(["claude"]);
    const asked = attention({ id: "a2", message: "allow Bash: pnpm test --filter auth?", created_at_ms: 2 });
    const lines = agentLines(input({ agents: [needs], attention: [attention({}), asked] }));
    expect(texts(lines)).toEqual(["claude allow Bash: pnpm test --filter auth?"]);
    expect(lines[0].tone).toBe("warn");
    expect(question(needs, [{ ...asked, resolved_at_ms: 3 }])).toBeNull();
  });

  it("says the exit code of an agent that died, in red", () => {
    const lines = agentLines(input({ agents: [agent("p1", "dead")], exitCodes: { p1: 1 } }));
    expect(texts(lines)).toEqual(["claude exited 1"]);
    expect(lines[0]).toMatchObject({ mark: "failed", tone: "bad" });
    expect(texts(agentLines(input({ agents: [agent("p1", "dead")] })))).toEqual(["claude exited"]);
  });

  it("says no signal and waking, where the mark alone is not enough", () => {
    const lines = agentLines(input({ agents: [agent("p1", "unknown", { kind: "pi" }), agent("p2", "idle", { sleep: "waking" })] }));
    expect(texts(lines)).toEqual(["pi no signal", "claude waking"]);
    expect(lines[1]).toMatchObject({ mark: "archiving", title: "waking" });
  });

  it("puts every subagent one level in under its agent, in its own order, with no count of the rest", () => {
    const subs = ["a", "b", "c", "d", "e", "f"].map((id, i) => sub(id, i === 2 ? "waiting" : i === 3 ? "exited" : i === 4 ? "dead" : "working"));
    const lines = agentLines(input({ agents: [agent("p1", "working", { subagents: subs }), agent("p2", "working", { kind: "codex" })] }));
    expect(texts(lines)).toEqual(["claude", "task a", "task b", "task c", "task d", "task e", "task f", "codex"]);
    expect(lines.map((l) => !!l.sub)).toEqual([false, true, true, true, true, true, true, false]);
    expect(lines.slice(1, 7).map((l) => l.mark)).toEqual(["working", "working", "needs", "done", "failed", "working"]);
    expect(lines.slice(1, 7).map((l) => l.tone)).toEqual([undefined, undefined, "warn", undefined, "bad", undefined]);
  });

  it("keeps the line of a quiet agent that still holds subagents, and names a subagent with no task by its kind", () => {
    expect(texts(agentLines(input({ agents: [agent("p1", "idle", { subagents: [sub("a", "exited", null)] })] })))).toEqual(["claude", "Explore"]);
  });
});

describe("problem lines", () => {
  it("lists a failed operation, memory over the warning, a review request, and a missing folder, in that order", () => {
    const lines = problemLines(
      input({
        worktree: worktree({ exists: false }),
        rowError: { op: "archive", message: "a pane still writes to the folder" },
        rssBytes: 2.1 * GB,
        attention: [attention({ id: "cp", kind: "checkpoint", message: "a checkpoint asks for a review", pane_id: null })],
      }),
    );
    expect(texts(lines)).toEqual(["archive failed a pane still writes to the folder", "memory 2.1 GB, over the 2 GB warning", "review a checkpoint asks for a review", "folder missing not found on disk"]);
    expect(lines.map((l) => l.mark)).toEqual(["failed", "needs", "needs", "unknown"]);
  });

  it("warns on memory only at the threshold", () => {
    expect(problemLines(input({ rssBytes: 2 * GB - 1 }))).toEqual([]);
    expect(texts(problemLines(input({ rssBytes: 2 * GB })))).toHaveLength(1);
  });

  it("shows an archive in progress with the gray twinkle", () => {
    expect(problemLines(input({ worktree: worktree({ archiving: true }) }))).toEqual([{ key: "archiving", mark: "archiving", label: "archiving" }]);
  });
});

describe("the groups of a row", () => {
  it("keeps problems, agents, and apps apart, in that order", () => {
    const groups = rowGroups(
      input({
        agents: [agent("p1", "working")],
        rssBytes: 5 * GB,
        apps: [{ id: "web", mark: "working", label: "web", detail: ":3003" }, { id: "crash", mark: "failed", label: "Storybook", detail: "exited -1", bad: true }],
      }),
    );
    expect(texts(groups.problems)).toEqual(["memory 5 GB, over the 2 GB warning"]);
    expect(texts(groups.agents)).toEqual(["claude"]);
    expect(texts(groups.apps)).toEqual(["web :3003", "Storybook exited -1"]);
    expect(groups.apps.map((l) => l.tone)).toEqual(["mute", "bad"]);
  });

  it("draws no line on an archived row", () => {
    const groups = rowGroups(input({ worktree: worktree({ archived_at_ms: 1 }), agents: [agent("p1", "working")], rowError: { op: "restore", message: "x" }, apps: [{ id: "web", mark: "working", label: "web", detail: ":1" }] }));
    expect(groups).toEqual({ problems: [], agents: [], apps: [] });
  });
});

describe("the row mark", () => {
  const web = { id: "web", mark: "working" as const, label: "web", detail: ":3003" };

  it("shows a problem before every agent, the lead agent before an app, and an app only with no agent", () => {
    const needsMemory = rowGroups(input({ agents: [agent("p1", "working")], rssBytes: 3 * GB }));
    expect(leadLine(needsMemory, true)?.mark).toBe("needs");
    expect(leadLine(rowGroups(input({ agents: [agent("p1", "working")], apps: [web] })), true)).toBeNull();
    expect(leadLine(rowGroups(input({ apps: [web] })), false)?.mark).toBe("working");
    expect(leadLine(rowGroups(input({ worktree: worktree({ exists: false }) })), false)?.mark).toBe("unknown");
    expect(leadLine(rowGroups(input()), false)).toBeNull();
  });
});

describe("the branch line", () => {
  const git = (over: Partial<GitSummary>): GitSummary => ({ branch: "b", head: "h", detached: false, dirty: false, files_changed: 0, untracked: 0, conflicts: 0, insertions: 0, deletions: 0, ahead: 3, behind: 1, upstream: "origin/b", ...over });

  it("shows * for changes and !2 in red for conflicts, and never ahead or behind", () => {
    expect(branchFlags(worktree({ git: git({ dirty: true, conflicts: 2 }) }))).toEqual([{ text: "*" }, { text: "!2", bad: true }]);
    expect(branchFlags(worktree({ git: git({}) }))).toEqual([]);
  });

  it("names a detached head and an archived worktree", () => {
    expect(branchText(worktree({ detached: true, branch: null }))).toBe("detached abc1234");
    expect(branchText(worktree({ archived_at_ms: 1, branch: "feat/old-sync" }))).toBe("archived · feat/old-sync");
  });
});

describe("the hover card", () => {
  it("shows every agent with its session, its state in words, and its run time; subagents with their kind and age", () => {
    const now = 4 * 60_000;
    const lines = hoverAgentLines(
      input({ agents: [agent("p1", "working", { session_ref: "a5a5b6b6c7c7d8d812cc", subagents: [sub("a", "working")] }), agent("p2", "idle", { kind: "codex" }), agent("p3", "done", { kind: "pi", seen: false })] }),
      now,
    );
    expect(lines.map((l) => [l.label ?? "", l.kind ?? "", l.text, l.meta])).toEqual([
      ["claude", "session a5a5…12cc", "working", "4 min"],
      ["", "Explore", "task a", "4 min"],
      ["codex", "", "idle", "4 min"],
      ["pi", "", "done, not seen yet", "4 min"],
    ]);
  });

  it("gives git the branch, the upstream with ahead and behind, the changes, and the conflicts", () => {
    const g: GitSummary = { branch: "b", head: "h", detached: false, dirty: true, files_changed: 12, untracked: 2, conflicts: 2, insertions: 340, deletions: 56, ahead: 3, behind: 0, upstream: "origin/b" };
    const rows = gitDetails(worktree({ git: g }));
    expect(rows.map((r) => [r.key, r.facts.map((f) => f.text).join(" ")])).toEqual([
      ["branch", "fix/login-redirect"],
      ["upstream", "origin/b ↑3 ↓0"],
      ["changes", "12 files +340 −56 · 2 untracked"],
      ["conflicts", "2 files"],
    ]);
    const clean = gitDetails(worktree({ git: { ...g, dirty: false, files_changed: 0, untracked: 0, conflicts: 0, insertions: 0, deletions: 0, ahead: 0 } }));
    expect(clean.map((r) => r.facts.map((f) => f.text).join(" "))).toEqual(["fix/login-redirect", "origin/b up to date", "clean"]);
  });

  it("ends with the tags and the age of the worktree", () => {
    const now = 2 * 86_400_000;
    expect(aboutDetails(worktree({ metadata: { display_name: null, tags: ["design-system"] }, first_seen_ms: 0 }), now).map((r) => r.facts[0].text)).toEqual(["#design-system", "created 2 d ago"]);
    expect(aboutDetails(worktree({ is_main: true }), now).map((r) => r.facts[0].text)).toEqual(["the main worktree"]);
  });

  it("shortens a session and a home path", () => {
    expect(shortSession("7e21aaaabbbb09f1")).toBe("7e21…09f1");
    expect(shortSession("short")).toBe("short");
    expect(homePath("/Users/you/tomo/worktrees/tomo/kobe")).toBe("~/tomo/worktrees/tomo/kobe");
    expect(homePath("/opt/src")).toBe("/opt/src");
  });
});
