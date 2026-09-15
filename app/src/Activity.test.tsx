import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { getState, setState } from "./store";
import type { ActionSet, ActivityEvent, AgentPresence, AttentionItem, Pane, RuntimeEndpoint, Worktree } from "./types";
import { defaultUi } from "./uiState";

vi.mock("./api", async (importOriginal) => {
  const replies: Record<string, unknown> = { activity_list: [], worktree_restore: { id: "w1" }, worktree_open: { tabs: [] } };
  return { ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn((method: string) => Promise.resolve(replies[method] ?? null)) };
});

const { Activity } = await import("./Activity");

const worktree = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "feat/kobe", archived_at_ms: 5, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const pane = { id: "p1", worktree_id: "w1", tab_id: "t1", live: true } as unknown as Pane;
const agent = (state: AgentPresence["state"]) => ({ pane_id: "p1", worktree_id: "w1", kind: "claude", state, session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null }) as AgentPresence;
const attention = (id: string, kind: AttentionItem["kind"]): AttentionItem => ({ id, worktree_id: "w1", pane_id: "p1", level: "attention", message: id, created_at_ms: 1, viewed_at_ms: null, kind, url: null, agent_kind: null, resolved_at_ms: null });
const serve: ActionSet = { worktree_id: "w1", actions: [{ id: "serve", label: "Serve", command: "sleep 30", mode: "pane", show: "topbar", shortcut: null }], error: null };
const endpoint: RuntimeEndpoint = { id: "e", worktree_id: "w1", pane_id: "p1", action_id: "serve", pid: 1, process: "node", protocol: "http", host: "localhost", port: 3000, label: null, discovered_at_ms: 0 };

const claude = { agent_kind: "claude", pane_id: "p1" } as const;
const EVENTS: [string, Partial<ActivityEvent>][] = [
  ["agent_started", { ...claude, payload: { session_ref: null } }],
  ["agent_waiting", { ...claude, attention_id: "att-wait" }],
  ["agent_exited", claude],
  ["checkpoint_created", { ...claude, payload: { url: null }, attention_id: "att-chk" }],
  ["checkpoint_resolved", { ...claude, payload: { kind: "checkpoint", url: null }, attention_id: "att-gone" }],
  ["action_started", { payload: { action_id: "serve", pane_id: null } }],
  ["action_stopped", { pane_id: "p1", payload: { action_id: "serve", pane_id: "p1" } }],
  ["action_completed", { pane_id: "p1", payload: { action_id: "serve", pane_id: "p1" } }],
  ["action_crashed", { pane_id: "p1", detail: "exit code 2", payload: { action_id: "serve", exit_code: 2, pane_id: "p1" }, attention_id: "att-crash" }],
  ["endpoint_discovered", { pane_id: "p1", payload: { port: 3000, host: "localhost", pid: 1, action_id: "serve", endpoint_id: "e" } }],
  ["annotations_sent", { ...claude, detail: "http://localhost:3000/a", payload: { source: "browser feedback", worktree_id: "w1", url: "http://localhost:3000/a", action_id: null, annotations: [], instruction: "i" } }],
  ["state_changed", { detail: "kobe", payload: { state: "active", previous_state: null } }],
  ["archived", { payload: { branch: "feat/kobe", checkpoint_commit: null, head: "abc" } }],
  ["restored", { payload: { branch: "feat/kobe" } }],
  ["hook_failed", { worktree_id: null, detail: "notify.sh", payload: { command: "notify.sh", exit_code: 1, output_tail: "" } }],
  ["pr_merged", { detail: "Add kobe", payload: { number: 12, url: "https://github.com/o/r/pull/12" } }],
  ["future.thing", { payload: { note: "from a newer build" } }],
];

const now = Date.now();
const events: ActivityEvent[] = EVENTS.map(([kind, extra], i) => ({ id: kind, kind, occurred_at_ms: now - i * 1000, worktree_id: "w1", pane_id: null, agent_kind: null, title: kind, detail: null, payload: null, attention_id: null, ...extra }) as ActivityEvent);

const initial = getState();
beforeEach(() => {
  vi.mocked(rpc).mockClear();
  setState({
    ...initial,
    loaded: true,
    worktrees: [worktree],
    panes: { p1: pane },
    agents: { p1: agent("waiting") },
    actions: { w1: serve },
    endpoints: { w1: [endpoint] },
    attention: [attention("att-wait", "waiting"), attention("att-chk", "checkpoint"), attention("att-crash", "crash")],
    activity: events,
    ui: { ...defaultUi, view: "activity", activeWorktreeId: "w1" },
  });
});
afterEach(cleanup);

async function show() {
  await act(async () => {
    render(<Activity />);
  });
}

const rowOf = (title: string) => screen.getByText(title, { selector: ".activity-title-text" }).closest(".activity-row") as HTMLElement;
const titles = () => [...document.querySelectorAll(".activity-title-text")].map((n) => n.textContent);

function describeRow(title: string) {
  const row = rowOf(title);
  const glyph = row.querySelector(".activity-who .glyph");
  const who = (row.querySelector(".activity-who")?.textContent ?? "").replace(glyph?.textContent ?? "", "");
  const buttons = [...row.querySelectorAll(".activity-actions button")].map((b) => b.textContent);
  return [title, glyph?.getAttribute("aria-label") ?? null, who, buttons];
}

describe("Activity view", () => {
  it("renders every kind with its status glyph, actor, and row actions", async () => {
    await show();
    expect(EVENTS.map(([kind]) => describeRow(kind))).toEqual([
      ["agent_started", "working", "Claude · kobe", ["Go to Claude"]],
      ["agent_waiting", "needs", "Claude · kobe", ["Go to Claude", "Resolve"]],
      ["agent_exited", "idle", "Claude · kobe", ["Go to Claude"]],
      ["checkpoint_created", "needs", "Claude · kobe", ["Open App", "Go to Claude", "Resolve"]],
      ["checkpoint_resolved", "complete", "Claude · kobe", []],
      ["action_started", "working", "Serve · kobe", []],
      ["action_stopped", "idle", "Serve · kobe", ["Restart"]],
      ["action_completed", "complete", "Serve · kobe", []],
      ["action_crashed", "failed", "Serve · kobe", ["Logs", "Restart", "Resolve"]],
      ["endpoint_discovered", null, "Serve · kobe", ["Open App"]],
      ["annotations_sent", null, "Claude · kobe", ["Open App"]],
      ["state_changed", null, "You · kobe", []],
      ["archived", null, "You · kobe", ["Restore"]],
      ["restored", null, "You · kobe", []],
      ["hook_failed", "failed", "", []],
      ["pr_merged", "complete", "kobe", ["Open App"]],
      ["future.thing", null, "kobe", []],
    ]);
  });

  it("keeps the stream newest first under one day label", async () => {
    await show();
    expect(titles()).toEqual(EVENTS.map(([kind]) => kind));
    expect([...document.querySelectorAll(".activity-day .section-label")].map((n) => n.textContent)).toEqual(["today"]);
  });

  it("filters by Needs me and by This worktree", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Needs me" }));
    expect(titles()).toEqual(["agent_waiting", "checkpoint_created", "action_crashed"]);
    await user.click(screen.getByRole("button", { name: "This worktree" }));
    expect(titles()).toEqual(EVENTS.map(([kind]) => kind).filter((k) => k !== "hook_failed"));
  });

  it("drops a waiting row from Needs me once its agent moves on, but that row still offers Resolve", async () => {
    setState({ agents: { p1: agent("working") } });
    const user = userEvent.setup();
    await show();
    expect(describeRow("agent_waiting")[3]).toEqual(["Go to Claude", "Resolve"]);
    await user.click(screen.getByRole("button", { name: "Needs me" }));
    expect(titles()).toEqual(["checkpoint_created", "action_crashed"]);
  });

  it("row actions call the daemon", async () => {
    const user = userEvent.setup();
    await show();
    const click = (title: string, label: string) => user.click(rowOf(title).querySelector(`.activity-actions button:nth-child(${[...rowOf(title).querySelectorAll(".activity-actions button")].findIndex((b) => b.textContent === label) + 1})`)!);
    await click("action_crashed", "Restart");
    await click("checkpoint_created", "Resolve");
    await click("archived", "Restore");
    await click("action_crashed", "Logs");
    const calls = vi.mocked(rpc).mock.calls.filter(([method]) => method !== "activity_list");
    expect(calls.slice(0, 4)).toEqual([
      ["action_restart", { worktree_id: "w1", action_id: "serve" }],
      ["checkpoint_resolve", { id: "att-chk" }],
      ["worktree_restore", { worktree_id: "w1" }],
      ["worktree_open", { worktree_id: "w1" }],
    ]);
  });
});
