import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityEmptyText, homeEmpty } from "./emptyStates";
import { EmptyState } from "./states";
import { getState, setState, type State } from "./store";
import type { Tab, Worktree } from "./types";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve([])) }));

const { Activity } = await import("./Activity");
const { Home } = await import("./Home");
const { paneToRestore } = await import("./windowChrome");

const initial: State = getState();

beforeEach(() => setState(initial));
afterEach(cleanup);

describe("empty states", () => {
  it("picks the Home empty state", () => {
    expect(homeEmpty(0, 0, 0)).toBe("no-repos");
    expect(homeEmpty(1, 0, 0)).toBe("no-worktrees");
    expect(homeEmpty(1, 3, 0)).toBe("no-matches");
    expect(homeEmpty(1, 0, 2)).toBeNull();
    expect(homeEmpty(1, 3, 3)).toBeNull();
  });

  it("uses short copy", () => {
    expect(activityEmptyText("needs_me")).toBe("Nothing needs you.");
  });

  it("renders a title, a detail, and one action", () => {
    render(<EmptyState title="No active worktrees." detail="calm" action={<button>New worktree</button>} />);
    expect(screen.getByText("No active worktrees.")).toBeInTheDocument();
    expect(screen.getByText("calm")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New worktree" })).toBeInTheDocument();
  });

  it("Home with no repositories offers to add one", () => {
    setState({ loaded: true });
    render(<Home />);
    expect(screen.getByText("No repositories yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeInTheDocument();
  });

  it("Home with only archived worktrees says none are active", () => {
    const archived = { id: "w1", repo_id: "r1", path: "/r/w1", name: "w1", branch: "b", head: "h", detached: false, is_main: false, exists: false, git: null, metadata: { display_name: null, project: null, priority: null, tags: [], state: null }, last_active_ms: null, first_seen_ms: null, archived_at_ms: 5, archiving: false, tab_count: 0, pane_count: 0 } as unknown as Worktree;
    setState({ loaded: true, repos: [{ id: "r1", path: "/r", name: "r", exists: true, remote_url: null }], worktrees: [archived] });
    render(<Home />);
    expect(screen.getByText("No active worktrees.")).toBeInTheDocument();
  });

  it("Activity shows a skeleton while it loads, then calm empty copy per filter", async () => {
    const user = userEvent.setup();
    render(<Activity />);
    expect(screen.getByRole("status", { name: "loading activity" })).toBeInTheDocument();
    expect(await screen.findByText("No activity yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Needs me" }));
    expect(screen.getByText("Nothing needs you.")).toBeInTheDocument();
  });
});

describe("window focus", () => {
  const tab = { id: "t1", worktree_id: "w1", title: "t", position: 0, layout: { type: "leaf", pane_id: "p1" }, active_pane_id: "p1", is_active: true } as unknown as Tab;
  const worktreeView = (): State => ({ ...initial, tabs: { w1: [tab] }, ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1" } });

  it("restores the active pane only when nothing else holds focus", () => {
    expect(paneToRestore(worktreeView(), document.body)).toBe("p1");
    expect(paneToRestore(worktreeView(), null)).toBe("p1");
    const input = document.createElement("input");
    expect(paneToRestore(worktreeView(), input)).toBeNull();
    expect(paneToRestore({ ...worktreeView(), paletteOpen: true }, document.body)).toBeNull();
    expect(paneToRestore(initial, document.body)).toBeNull();
  });
});
