import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../store";
import type { AgentPresence, AttentionItem, Repo, Worktree } from "../types";
import { defaultUi } from "../uiState";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { LeftRail } = await import("./LeftRail");
const { RightRail } = await import("./RightRail");
const { CenterHead, SidebarHead } = await import("./TopStrip");

const repo = { id: "r1", name: "acme", path: "/src/acme", exists: true, remote_url: null } as Repo;
const wt = (id: string, name: string): Worktree => ({ id, name, repo_id: "r1", path: `/src/${name}`, branch: `feat/${name}`, head: "abc1234", detached: false, exists: true, archived_at_ms: null, archiving: false, is_main: false, git: null, metadata: { state: null, tags: [], project: null, display_name: null } }) as unknown as Worktree;
const waiting = { id: "a1", kind: "claude", state: "waiting", worktree_id: "w1", pane_id: "p1", updated_at_ms: 1 } as unknown as AgentPresence;
const crash = { id: "c1", kind: "crash", worktree_id: "w2", message: "Sampler crashed", created_at_ms: 1, resolved_at_ms: null, viewed_at_ms: null } as unknown as AttentionItem;

const initial = getState();
beforeEach(() =>
  setState({
    ...initial,
    loaded: true,
    repos: [repo],
    worktrees: [wt("w1", "aogashima"), wt("w2", "setagaya"), wt("w3", "kamakura")],
    agents: { a1: waiting },
    attention: [crash],
    ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w3" },
  }),
);
afterEach(cleanup);

describe("minimal left rail", () => {
  it("marks attention and crashes with glyphs and text labels, not color alone", () => {
    render(<LeftRail />);
    const needs = screen.getByRole("button", { name: "aogashima, needs input" });
    expect(needs.querySelector(".state-waiting")).not.toBeNull();
    const crashed = screen.getByRole("button", { name: "setagaya, crashed" });
    expect(crashed.querySelector(".state-fail")).not.toBeNull();
    expect(screen.getByRole("button", { name: "kamakura" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Activity, 1 need you" })).toBeInTheDocument();
  });
});

describe("minimal right rail", () => {
  it("names section markers in the label and opens the inspector at a section", async () => {
    const dirty = { ...wt("w3", "kamakura"), git: { dirty: true } } as unknown as Worktree;
    setState({ resources: { w3: { process_count: 2 } } as never });
    render(<RightRail worktree={dirty} />);
    expect(screen.getByRole("button", { name: "Git, dirty" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Processes, 2 running" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Files" }));
    expect(getState().ui).toMatchObject({ rightMode: "open", rightSection: "files" });
  });
});

describe("column heads", () => {
  it("goes Home from the mark and cycles the sidebar from the toggle", async () => {
    const user = userEvent.setup();
    render(<SidebarHead />);
    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(getState().ui.view).toBe("home");
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(getState().ui.leftMode).toBe("minimal");
  });

  it("carries the sidebar control in the center head when the sidebar is a rail", async () => {
    const user = userEvent.setup();
    setState({ ui: { ...getState().ui, view: "home", leftMode: "minimal" } });
    const { rerender } = render(<CenterHead worktree={null} layout={{ left: "minimal", right: "closed", leftCol: 28, rightCol: 0 }} />);
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toHaveAttribute("data-mode", "minimal");
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(getState().ui.leftMode).toBe("closed");
    act(() => rerender(<CenterHead worktree={null} layout={{ left: "open", right: "closed", leftCol: 260, rightCol: 0 }} />));
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
  });
});
