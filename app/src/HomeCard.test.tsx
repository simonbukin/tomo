import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPresence, AttentionItem, Worktree } from "./types";

vi.mock("./api", async (importOriginal) => (await import("./test-api")).mockApi(await importOriginal<typeof import("./api")>(), vi.fn(() => Promise.resolve(null))));

const { getState, setState } = await import("./store");
const { WorktreeCard } = await import("./Home");

const wt = { id: "w1", name: "storybook", repo_id: "r1", path: "/src/w1", branch: "feat", head: "abc1234", detached: false, exists: true, archived_at_ms: null, git: null, metadata: { display_name: null, tags: [] } } as unknown as Worktree;
const crash: AttentionItem = { id: "a1", worktree_id: "w1", pane_id: "p9", level: "attention", message: "storybook exited 1", created_at_ms: 1, viewed_at_ms: null, kind: "crash", url: null, agent_kind: null, resolved_at_ms: null };
const asking: AgentPresence = { pane_id: "p1", worktree_id: "w1", kind: "claude", state: "waiting", session_ref: null, authority: "lifecycle", updated_at_ms: 1, pid: null, estimated: false, seen: false };

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true, worktrees: [wt], agents: {}, attention: [] }));
afterEach(cleanup);

const card = () => document.querySelector(".card");

describe("the amber edge of a worktree card", () => {
  it("does not show for a crash of a pane that is not an agent, such as an Action", () => {
    setState({ attention: [crash] });
    render(<WorktreeCard w={wt} />);
    expect(card()?.classList.contains("card-attention")).toBe(false);
  });

  it("shows when an agent needs you", () => {
    setState({ agents: { p1: asking } });
    render(<WorktreeCard w={wt} />);
    expect(card()?.classList.contains("card-attention")).toBe(true);
  });
});
