import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearIssue, LinearLink, LinearStatus } from "../../generated";
import type { Frame, Snapshot, Worktree } from "../../types";

vi.mock("../../api", async (importOriginal) => (await import("../../test-api")).mockApi(await importOriginal<typeof import("../../api")>(), vi.fn(() => Promise.resolve(null))));

const { applyFrame, getState, setState } = await import("../../store");
const { RightSidebar } = await import("../../RightSidebar");
const { WorktreeLinks } = await import("../../WorktreeLines");
const { WorktreePreview } = await import("../../WorktreePreview");
const { defaultUi } = await import("../../uiState");
const { linear } = await import("./index");

const wt = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "simon/eng-2611-fix-login", head: "abc1234", detached: false, exists: true, archived_at_ms: null, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const issue: LinearIssue = { identifier: "ENG-2611", title: "Fix login", url: "https://linear.app/x/issue/ENG-2611", state: { name: "In Review", kind: "started", color: "#0f783c" }, assignee: "Simon", priority: "High", updated_at_ms: 0 };
const link = (worktree_id: string, patch: Partial<LinearLink> = {}): LinearLink => ({ worktree_id, issue, touched_ms: 100, current: true, why: "branch simon/eng-2611-fix-login", ...patch });
const status = (links: LinearStatus["links"]): LinearStatus => ({ available: true, reason: null, links, fetched_at_ms: 1 });
const changed = (value: LinearStatus) => act(() => applyFrame({ event: "linear_changed", data: { status: value } } as Frame));

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true, worktrees: [wt], linear: undefined, ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w1" } }));
afterEach(cleanup);

describe("Linear issue of a branch", () => {
  it("puts the identifier on the name line, its icon tinted with the team's state colour", () => {
    linear.onSnapshot?.({ linear: status([link("w1")]) } as Snapshot);
    const { container } = render(<WorktreeLinks w={wt} />);
    expect(container.textContent).toBe("ENG-2611");
    expect(container.querySelector(".wt-link-icon")!.getAttribute("style")).toContain("color-mix(in srgb, #0f783c 70%, var(--fg))");
  });

  it("puts the identifier, title, state, and assignee in the worktree hover card", () => {
    changed(status([link("w1")]));
    const { container } = render(<WorktreePreview w={wt} />);
    expect(container.querySelector(".link-line")).toHaveTextContent("ENG-2611Fix login · In Review · Simonthis branch");
    expect(container.querySelector(".link-line")).toHaveAttribute("href", "https://linear.app/x/issue/ENG-2611");
  });

  it("has no link for a worktree without an issue, and drops it when the daemon clears the link", () => {
    changed(status([link("w2")]));
    const { container } = render(<WorktreeLinks w={wt} />);
    expect(container.textContent).toBe("");
    changed(status([link("w1")]));
    expect(container.textContent).toBe("ENG-2611");
    changed({ available: false, reason: "Linear did not answer", links: [], fetched_at_ms: 2 });
    expect(container.textContent).toBe("");
  });

  it("puts the title, state, priority, and assignee in the git section", () => {
    changed(status([link("w1")]));
    render(<RightSidebar worktree={wt} />);
    const git = document.querySelector('[data-section="git"]');
    expect(git).toHaveTextContent("ENG-2611 Fix login");
    expect(git).toHaveTextContent("In Review · High · Simon");
  });

  it("offers to open the issue from the palette", () => {
    changed(status([link("w1", { issue: { ...issue, assignee: null } }), link("w1", { issue: { ...issue, identifier: "ENG-7" }, current: false })]));
    const entries = linear.paletteEntries?.(getState(), wt, true) ?? [];
    expect(entries.map((e) => e.label)).toEqual(["open ENG-2611 in Linear", "open ENG-7 in Linear"]);
    expect(linear.paletteEntries?.(getState(), { ...wt, id: "w2" }, true)).toEqual([]);
  });

  it("stacks every issue of the worktree, the newest first, and puts a pull request under the issue that its branch names", () => {
    const older = { ...issue, identifier: "ENG-7", title: "Older", url: "https://linear.app/x/issue/ENG-7" };
    changed(status([link("w1", { touched_ms: 300 }), link("w1", { issue: older, touched_ms: 100, current: false, why: "named in a commit on simon/eng-2611-fix-login" })]));
    const pr = { number: 9, title: "Older work", url: "https://github.com/acme/acme/pull/9", state: "merged", draft: false, review_decision: null, mergeable: null, checks_passed: 0, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1, head: "simon/eng-7-older", updated_at_ms: 0, touched_ms: 50 };
    act(() => applyFrame({ event: "pr_changed", data: { worktree_id: "w1", pr: null, prs: [pr] } } as Frame));
    const row = render(<WorktreeLinks w={wt} />).container;
    expect(row.textContent).toBe("ENG-2611+1");
    const card = render(<WorktreePreview w={wt} />).container;
    expect([...card.querySelectorAll(".link-line")].map((l) => [l.className, l.querySelector(".link-id")!.textContent])).toEqual([
      ["link-line", "ENG-2611"],
      ["link-line", "ENG-7"],
      ["link-line link-sub", "#9"],
    ]);
  });
});
