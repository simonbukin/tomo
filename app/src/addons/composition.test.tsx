import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuEntry, MenuItem } from "../components/ui";
import type { ActionSet, Pane, RuntimeEndpoint, Tab, Worktree } from "../generated";
import type { Frame } from "../types";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => true }) }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { rpc } = await import("../api");
const { WorktreeHeader } = await import("../WorktreeHeader");
const { overflowMenu } = await import("../menus");
const { paletteEntries } = await import("../Palette");
const store = await import("../store");

const worktree = { id: "w1", name: "aogashima", repo_id: "r1", path: "/src/aogashima", branch: "feat/x", head: "abc1234", detached: false, exists: true, archived_at_ms: null, archiving: false, is_main: false, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const tab = { id: "t1", worktree_id: "w1", title: "one", position: 0, is_active: true, active_pane_id: "p1", layout: { type: "leaf", pane_id: "p1" } } as unknown as Tab;
const serveSource = { kind: "action", id: "serve", label: "Serve" };
const servePane = { id: "p1", tab_id: "t1", worktree_id: "w1", title: "Serve", user_title: "Serve", live: true, exit_code: null, agent: null, kind: "terminal", url: null, action_id: "serve", source: serveSource } as unknown as Pane;
const set: ActionSet = {
  worktree_id: "w1",
  actions: [
    { id: "serve", label: "Serve", command: "pnpm dev", mode: "pane", show: "topbar", shortcut: null },
    { id: "lint", label: "Lint", command: "pnpm lint", mode: "pane", show: "topbar", shortcut: null },
  ],
  error: null,
  from_repo: false,
};
const served = (extra: Partial<RuntimeEndpoint> = {}) => ({ id: "1:3000", worktree_id: "w1", pane_id: "p1", action_id: "serve", source: serveSource, pid: 1, process: "node", protocol: "http", host: "localhost", port: 3000, label: "Serve", discovered_at_ms: 0, ...extra }) as RuntimeEndpoint;

const labels = (items: MenuItem[]) => items.map((it) => ("separator" in it ? "—" : it.label));
const entry = (items: MenuItem[], label: string) => items.find((it): it is MenuEntry => !("separator" in it) && it.label === label)!;
const frame = (event: string, data: unknown) => act(() => store.applyFrame({ event, data } as unknown as Frame));

const initial = store.getState();
beforeEach(() => {
  vi.mocked(rpc).mockClear();
  store.setState({
    ...initial,
    loaded: true,
    worktrees: [worktree],
    tabs: { w1: [tab] },
    panes: { p1: servePane },
    toasts: [],
    menu: null,
    config: { keybindings: {}, editor_command: ["zed", "{path}"], states: [], notifications: { desktop: false, sounds: false } } as never,
    ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1", paletteRecent: [] },
  });
  frame("actions_changed", { set });
  frame("endpoints_changed", { worktree_id: "w1", endpoints: [served()] });
});
afterEach(cleanup);

describe("Actions and Runtime through pane sources", () => {
  it("marks the Action button whose pane serves HTTP", () => {
    render(<WorktreeHeader worktree={worktree} />);
    expect(screen.getByRole("button", { name: "Serve" }).querySelector(".action-live")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Lint" }).querySelector(".action-live")).toBeNull();
    frame("endpoints_changed", { worktree_id: "w1", endpoints: [served({ protocol: "tcp" })] });
    expect(screen.getByRole("button", { name: "Serve" }).querySelector(".action-live")).toBeNull();
  });

  it("puts open first and copy last in the running Action submenu", () => {
    const serve = entry(overflowMenu(worktree, store.getState()), "Serve").submenu!;
    expect(labels(serve)).toEqual(["open", "focus logs", "restart", "stop", "—", "copy"]);
    expect(labels(entry(serve, "copy").submenu!)).toEqual(["url", "port"]);
    render(<WorktreeHeader worktree={worktree} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Serve" }));
    expect(labels(store.getState().menu!.items)).toEqual(["open", "focus logs", "restart", "stop", "—", "copy"]);
  });

  it("does not list an Action endpoint as a loose runtime entry", () => {
    expect(labels(overflowMenu(worktree, store.getState())).slice(0, 3)).toEqual(["Serve", "—", "split right"]);
  });

  it("offers restart and stop in the menu of an Action endpoint", async () => {
    render(<WorktreeHeader worktree={worktree} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Runtime endpoints" }));
    await screen.findByText("runtime");
    fireEvent.contextMenu(document.querySelector(".runtime-row")!);
    const menu = store.getState().menu!.items;
    expect(labels(menu)).toEqual(["open", "focus logs", "restart", "stop", "—", "copy"]);
    entry(menu, "stop").run!();
    expect(vi.mocked(rpc).mock.calls.filter(([m]) => String(m).startsWith("action_"))).toEqual([["action_stop", { worktree_id: "w1", action_id: "serve" }]]);
  });

  it("lists Action palette entries before endpoint entries", () => {
    const keys = paletteEntries(store.getState()).map((e) => e.key).filter((k) => k.startsWith("action:") || k.startsWith("endpoint:"));
    expect(keys).toEqual(["action:w1:serve:logs", "action:w1:serve:restart", "action:w1:serve:stop", "action:w1:lint", "endpoint:w1:3000"]);
  });
});
