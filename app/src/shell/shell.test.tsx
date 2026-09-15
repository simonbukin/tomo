import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../store";
import type { AgentPresence, AttentionItem, Repo, Worktree } from "../types";
import { defaultUi } from "../uiState";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { LeftRail } = await import("./LeftRail");
const { RightRail } = await import("./RightRail");
const { TopLeft } = await import("./TopStrip");

const repo = { id: "r1", name: "holly", path: "/src/holly", exists: true, github: null } as unknown as Repo;
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
    expect(screen.getByRole("button", { name: "Activity, 1 need you" })).toHaveTextContent("1");
  });
});

describe("minimal right rail", () => {
  it("shows section markers with text and opens the inspector at a section", async () => {
    const dirty = { ...wt("w3", "kamakura"), git: { dirty: true } } as unknown as Worktree;
    setState({ resources: { w3: { process_count: 2 } } as never });
    render(<RightRail worktree={dirty} />);
    expect(screen.getByRole("button", { name: "Git, dirty" })).toHaveTextContent("*");
    expect(screen.getByRole("button", { name: "Processes, 2 running" })).toHaveTextContent("●");
    await userEvent.setup().click(screen.getByRole("button", { name: "Files" }));
    expect(getState().ui).toMatchObject({ rightMode: "open", rightSection: "files" });
  });
});

describe("top-left chrome", () => {
  it("goes Home from the mark and cycles the sidebar from the toggle", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TopLeft mode="open" />);
    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(getState().ui.view).toBe("home");
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    await user.click(toggle);
    expect(getState().ui.leftMode).toBe("minimal");
    act(() => rerender(<TopLeft mode={getState().ui.leftMode} />));
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toHaveAttribute("data-mode", "minimal");
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(getState().ui.leftMode).toBe("closed");
  });

  it("is reachable from the keyboard", async () => {
    const user = userEvent.setup();
    setState({ ui: { ...getState().ui, leftMode: "closed" } });
    render(<TopLeft mode="closed" />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Home" })).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(getState().ui.leftMode).toBe("open");
  });
});
