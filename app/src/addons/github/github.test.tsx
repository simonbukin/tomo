import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "../../generated";
import type { ActivityEvent, AgentPresence, Frame, Repo, Worktree } from "../../types";

const replies = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../../api", async (importOriginal) => (await import("../../test-api")).mockApi(await importOriginal<typeof import("../../api")>(), vi.fn((method: string) => Promise.resolve(replies[method] ?? null))));

const { rpc } = await import("../../api");
const { applyFrame, getState, setState } = await import("../../store");
const { RightSidebar } = await import("../../RightSidebar");
const { RightRail } = await import("../../shell/RightRail");
const { Signals, signalsFor } = await import("../../Signals");
const { signalText } = await import("../../shell/LeftRail");
const { RepoAvatar } = await import("../../Sidebar");
const { defaultUi } = await import("../../uiState");

const wt = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "feat/kobe", head: "abc1234", detached: false, exists: true, archived_at_ms: null, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const pr = (patch: Partial<PullRequest> = {}): PullRequest => ({ number: 12, title: "Add kobe", url: "https://github.com/acme/holly/pull/12", state: "open", draft: false, review_decision: null, mergeable: null, checks_passed: 0, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1, ...patch });
const prChanged = (value: PullRequest | null) => act(() => applyFrame({ event: "pr_changed", data: { worktree_id: "w1", pr: value } } as Frame));
const prCalls = () => vi.mocked(rpc).mock.calls.filter(([method]) => method === "pr_status");
const section = () => document.querySelector('[data-section="git"]');
const agent = (pane: string): AgentPresence => ({ pane_id: pane, worktree_id: "w1", kind: "claude", state: "working", session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null }) as AgentPresence;

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true, worktrees: [wt], prs: {}, ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w1" } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(rpc).mockClear();
  Object.keys(replies).forEach((k) => delete replies[k]);
});

describe("GitHub pull request rows inside the git section", () => {
  it("asks pr_status when it mounts and every 120 s while it stays mounted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { unmount } = render(<RightSidebar worktree={wt} />);
    expect(prCalls()).toEqual([["pr_status", { worktree_id: "w1" }]]);
    await act(async () => vi.advanceTimersByTime(119_999));
    expect(prCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(prCalls()).toHaveLength(2);
    unmount();
    vi.advanceTimersByTime(240_000);
    expect(prCalls()).toHaveLength(2);
  });

  it("does not ask for a worktree whose directory is missing", () => {
    render(<RightSidebar worktree={{ ...wt, exists: false }} />);
    expect(prCalls()).toEqual([]);
  });

  it("shows the number, title, state, draft, review, checks, and a merge problem", async () => {
    replies.pr_status = { available: true, reason: null, pr: pr({ draft: true, review_decision: "changes_requested", mergeable: "conflicting", checks_passed: 1, checks_failed: 1, checks_pending: 1 }) };
    render(<RightSidebar worktree={wt} />);
    await screen.findByText("Add kobe");
    expect(section()).toHaveTextContent("#12");
    expect(section()).toHaveTextContent("open, draft, changes requested");
    expect(section()).toHaveTextContent("1 passed, 1 failed, 1 pending");
    expect(section()).toHaveTextContent("mergeconflicting");
    expect(section()?.querySelector(".state.pr-open")).not.toBeNull();
    expect(section()?.querySelector(".state.check-failed")).not.toBeNull();
  });

  it("hides the merge row for a mergeable pull request and says none without checks", async () => {
    replies.pr_status = { available: true, reason: null, pr: pr({ mergeable: "mergeable" }) };
    render(<RightSidebar worktree={wt} />);
    await screen.findByText("Add kobe");
    expect(section()).not.toHaveTextContent("merge");
    expect(section()).toHaveTextContent(/checks\s*none/);
  });

  it("shows the gh reason when pull requests are unavailable", async () => {
    replies.pr_status = { available: false, reason: "gh is not installed", pr: null };
    render(<RightSidebar worktree={wt} />);
    expect(await screen.findByText("gh is not installed")).toBeInTheDocument();
  });

  it("says when the branch has no pull request", async () => {
    replies.pr_status = { available: true, reason: null, pr: null };
    render(<RightSidebar worktree={wt} />);
    expect(await screen.findByText("none")).toBeInTheDocument();
  });

  it("replaces the pull request on screen when pr_changed arrives", async () => {
    replies.pr_status = { available: true, reason: null, pr: pr() };
    render(<RightSidebar worktree={wt} />);
    await screen.findByText("Add kobe");
    prChanged(pr({ state: "merged" }));
    expect(section()?.querySelector(".state.pr-merged")).not.toBeNull();
  });
});

describe("GitHub marks outside the inspector", () => {
  it("marks failed checks before a merge on the right rail", () => {
    render(<RightRail worktree={wt} />);
    expect(screen.getByRole("button", { name: "Git" })).toBeInTheDocument();
    prChanged(pr({ state: "merged", checks_failed: 1 }));
    expect(screen.getByRole("button", { name: "Git, checks failed" })).toBeInTheDocument();
    prChanged(pr({ state: "merged" }));
    expect(screen.getByRole("button", { name: "Git, merged" })).toBeInTheDocument();
  });

  it("shows a merged pull request or failed checks as the last NOW signal", () => {
    prChanged(pr({ state: "merged" }));
    const { container } = render(<Signals worktreeId="w1" />);
    expect(container.querySelector(".signal-pr-merged")).toHaveTextContent("merged");
    expect(container.querySelector(".signal-pr-merged .state.pr-merged")).not.toBeNull();
    expect(signalsFor(getState(), "w1").map(signalText)).toEqual(["✓ merged"]);
    prChanged(pr({ checks_failed: 2 }));
    expect(container.querySelector(".signal-pr-failed .state.check-failed")).not.toBeNull();
    expect(signalsFor(getState(), "w1").map(signalText)).toEqual(["× checks failed"]);
    act(() => setState({ agents: { p1: agent("p1"), p2: agent("p2") } }));
    expect(signalsFor(getState(), "w1").map(signalText)).toEqual(["● Claude", "● Claude", "× checks failed"]);
    act(() => setState({ agents: { p1: agent("p1"), p2: agent("p2"), p3: agent("p3") } }));
    expect(signalsFor(getState(), "w1").map(signalText)).toEqual(["● Claude", "● Claude", "● Claude"]);
  });

  it("shows the owner avatar for a GitHub remote only", () => {
    const repo = (remote_url: string | null): Repo => ({ id: "r1", name: "holly", path: "/r", exists: true, remote_url });
    const { container, rerender } = render(<RepoAvatar repo={repo("git@github.com:acme/holly.git")} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://github.com/acme.png?size=64");
    rerender(<RepoAvatar repo={repo("https://gitlab.com/acme/holly")} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<RepoAvatar repo={repo(null)} />);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("GitHub activity", () => {
  it("renders a pr_merged row as complete with the pull request link", async () => {
    replies.activity_list = [];
    const { Activity } = await import("../../Activity");
    const merged = { id: "e1", kind: "pr_merged", occurred_at_ms: Date.now(), worktree_id: "w1", pane_id: null, agent_kind: null, title: "PR #12 merged", detail: "Add kobe", payload: { number: 12, url: "https://github.com/acme/holly/pull/12" }, attention_id: null } as ActivityEvent;
    act(() => setState({ activity: [merged], ui: { ...defaultUi, view: "activity", activeWorktreeId: "w1" } }));
    await act(async () => {
      render(<Activity />);
    });
    const row = screen.getByText("PR #12 merged", { selector: ".activity-title-text" }).closest(".activity-row") as HTMLElement;
    expect(row.querySelector(".activity-who .glyph")).toHaveAttribute("aria-label", "complete");
    expect(row.querySelector(".activity-who")).toHaveTextContent("kobe");
    expect([...row.querySelectorAll(".activity-actions button")].map((b) => b.textContent)).toEqual(["Open App"]);
  });
});

describe("GitHub remote owner", () => {
  it("reads the owner from the remote forms that the daemon parsed before", async () => {
    const { githubOwner } = await import("./model");
    expect(githubOwner("git@github.com:acme/holly.git")).toBe("acme");
    expect(githubOwner("https://github.com/acme/holly")).toBe("acme");
    expect(githubOwner("http://github.com/acme/holly.git/")).toBe("acme");
    expect(githubOwner("ssh://git@github.com/acme/holly.git")).toBe("acme");
    expect(githubOwner("https://gitlab.com/acme/holly")).toBeNull();
    expect(githubOwner("https://github.com/acme")).toBeNull();
    expect(githubOwner("https://github.com/acme/holly/tree/main")).toBeNull();
    expect(githubOwner("git@github.com:/holly")).toBeNull();
    expect(githubOwner(null)).toBeNull();
  });
});
