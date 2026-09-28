import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearIssue, LinearStatus } from "../../generated";
import type { Frame, Snapshot, Worktree } from "../../types";

vi.mock("../../api", async (importOriginal) => (await import("../../test-api")).mockApi(await importOriginal<typeof import("../../api")>(), vi.fn(() => Promise.resolve(null))));

const { applyFrame, getState, setState } = await import("../../store");
const { RightSidebar } = await import("../../RightSidebar");
const { Signals, signalsFor } = await import("../../Signals");
const { defaultUi } = await import("../../uiState");
const { linear } = await import("./index");

const wt = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "simon/eng-2611-fix-login", head: "abc1234", detached: false, exists: true, archived_at_ms: null, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const issue: LinearIssue = { identifier: "ENG-2611", title: "Fix login", url: "https://linear.app/x/issue/ENG-2611", state: { name: "In Review", kind: "started", color: "#0f783c" }, assignee: "Simon", priority: "High" };
const status = (links: LinearStatus["links"]): LinearStatus => ({ available: true, reason: null, links, fetched_at_ms: 1 });
const changed = (value: LinearStatus) => act(() => applyFrame({ event: "linear_changed", data: { status: value } } as Frame));

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true, worktrees: [wt], linear: undefined, ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w1" } }));
afterEach(cleanup);

describe("Linear issue of a branch", () => {
  it("shows the identifier and state on the signal line, tinted with the team's state colour", () => {
    linear.onSnapshot?.({ linear: status([{ worktree_id: "w1", issue }]) } as Snapshot);
    render(<Signals worktreeId="w1" />);
    expect(screen.getByText(/ENG-2611 In Review/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Linear In Review" }).getAttribute("style")).toContain("color-mix(in srgb, #0f783c 70%, var(--fg))");
  });

  it("has no signal for a worktree without an issue, and drops it when the daemon clears the link", () => {
    changed(status([{ worktree_id: "w2", issue }]));
    expect(signalsFor(getState(), "w1")).toEqual([]);
    changed(status([{ worktree_id: "w1", issue }]));
    expect(signalsFor(getState(), "w1")).toHaveLength(1);
    changed({ available: false, reason: "Linear did not answer", links: [], fetched_at_ms: 2 });
    expect(signalsFor(getState(), "w1")).toEqual([]);
  });

  it("puts the title, state, priority, and assignee in the git section", () => {
    changed(status([{ worktree_id: "w1", issue }]));
    render(<RightSidebar worktree={wt} />);
    const git = document.querySelector('[data-section="git"]');
    expect(git).toHaveTextContent("ENG-2611 Fix login");
    expect(git).toHaveTextContent("In Review · High · Simon");
  });

  it("offers to open the issue from the palette", () => {
    changed(status([{ worktree_id: "w1", issue: { ...issue, assignee: null } }]));
    const entries = linear.paletteEntries?.(getState(), wt, true) ?? [];
    expect(entries.map((e) => e.label)).toEqual(["open ENG-2611 in Linear"]);
    expect(linear.paletteEntries?.(getState(), { ...wt, id: "w2" }, true)).toEqual([]);
  });
});
