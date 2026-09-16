import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuEntry, MenuItem } from "../../components/ui";
import type { ActionSet, AttentionItem, Pane, Snapshot, Tab, Worktree } from "../../generated";
import type { Frame } from "../../types";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => true }) }));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { rpc } = await import("../../api");
const { WorktreeHeader } = await import("../../WorktreeHeader");
const { overflowMenu } = await import("../../menus");
const { paletteEntries } = await import("../../Palette");
const { ShortcutReference } = await import("../../ShortcutReference");
const { runAction } = await import("../../actions");
const store = await import("../../store");

const worktree = { id: "w1", name: "aogashima", repo_id: "r1", path: "/src/aogashima", branch: "feat/x", head: "abc1234", detached: false, exists: true, archived_at_ms: null, archiving: false, is_main: false, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const tab = { id: "t1", worktree_id: "w1", title: "one", position: 0, is_active: true, active_pane_id: "p2", layout: { type: "leaf", pane_id: "p2" } } as unknown as Tab;
const serveSource = { kind: "action", id: "serve", label: "Serve" };
const servePane = { id: "p1", tab_id: "t1", worktree_id: "w1", title: "Serve", user_title: "Serve", live: true, exit_code: null, agent: null, kind: "terminal", url: null, action_id: "serve", source: serveSource } as unknown as Pane;
const set: ActionSet = {
  worktree_id: "w1",
  actions: [
    { id: "serve", label: "Serve", command: "pnpm dev", mode: "pane", show: "topbar", shortcut: "mod+shift+s" },
    { id: "lint", label: "Lint", command: "pnpm lint", mode: "pane", show: "topbar", shortcut: null },
    { id: "quick", label: "quick", command: "true", mode: "pane", show: "menu", shortcut: null },
  ],
  error: "/src/aogashima/.tomo.toml: actions[3] id is required",
  from_repo: false,
};

const labels = (items: MenuItem[]) => items.map((it) => ("separator" in it ? "—" : it.label));
const entry = (items: MenuItem[], label: string) => items.find((it): it is MenuEntry => !("separator" in it) && it.label === label)!;
const flush = () => new Promise((r) => setTimeout(r, 0));
const rpcCalls = () => vi.mocked(rpc).mock.calls.filter(([method]) => String(method).startsWith("action_"));

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
    config: { keybindings: {}, editor_command: ["zed", "{path}"], states: [], notifications: { desktop: false, sounds: false } } as never,
    ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1", paletteRecent: [] },
  });
  store.applyFrame({ event: "actions_changed", data: { set } } as unknown as Frame);
});
afterEach(cleanup);

describe("actions topbar", () => {
  it("renders topbar actions before the editor button, a dot on the running one, and the file warning after the editor", () => {
    render(<WorktreeHeader worktree={worktree} />);
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons).toEqual(["Serve", "Lint", "Zed", "Reveal in Finder", "Actions config problem", "More actions"]);
    expect(screen.getByRole("button", { name: "Serve" }).querySelector(".state-working")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Lint" }).querySelector(".state-working")).toBeNull();
  });

  it("runs an action on click and offers focus, restart, and stop on a right click of a running one", async () => {
    render(<WorktreeHeader worktree={worktree} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Lint" }));
    expect(rpcCalls()).toEqual([["action_run", { worktree_id: "w1", action_id: "lint" }]]);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Serve" }));
    expect(labels(store.getState().menu!.items)).toEqual(["focus logs", "restart", "stop"]);
    act(() => store.setState({ menu: null }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Lint" }));
    expect(store.getState().menu).toBeNull();
  });

  it("fills the topbar from the subscribe snapshot", () => {
    store.applyFrame({ event: "actions_changed", data: { set: { worktree_id: "w1", actions: [], error: null } } } as unknown as Frame);
    const snap = { status: null, config: store.getState().config, repos: [], worktrees: [worktree], tabs: [tab], panes: [servePane], agents: [], attention: [], resources: [], actions: [set], endpoints: [], usage: [], ui_state: null } as unknown as Snapshot;
    act(() => store.applySnapshot(snap));
    render(<WorktreeHeader worktree={worktree} />);
    expect(screen.getByRole("button", { name: "Serve" })).toBeInTheDocument();
  });
});

describe("actions menus", () => {
  it("puts running and menu actions first in the overflow menu", () => {
    const menu = overflowMenu(worktree, store.getState());
    expect(labels(menu).slice(0, 4)).toEqual(["Serve", "quick", "—", "split right"]);
    expect(labels(entry(menu, "Serve").submenu!)).toEqual(["focus logs", "restart", "stop"]);
    expect(entry(menu, "Serve").shortcut).toBe("⇧⌘S");
    entry(menu, "quick").run!();
    expect(rpcCalls()).toEqual([["action_run", { worktree_id: "w1", action_id: "quick" }]]);
  });

});

describe("actions palette and shortcuts", () => {
  it("lists start for idle actions and focus, restart, stop for running ones", () => {
    const context = paletteEntries(store.getState()).filter((e) => e.key.startsWith("action:")).map((e) => e.label);
    expect(context).toEqual(["focus Serve logs", "restart Serve", "stop Serve", "start Lint", "start quick"]);
  });

  it("binds an action shortcut in its open worktree and runs it", () => {
    expect(store.keyBindings(store.getState())["action:serve"]).toBe("mod+shift+s");
    expect(store.keyBindings({ ...store.getState(), ui: { ...store.getState().ui, view: "home" } })["action:serve"]).toBeUndefined();
    runAction("action:serve");
    expect(rpcCalls()).toEqual([["action_run", { worktree_id: "w1", action_id: "serve" }]]);
  });

  it("shows a bound action in the shortcut reference", () => {
    act(() => store.setState({ shortcutsOpen: true }));
    render(<ShortcutReference />);
    expect(screen.getByText("run Serve")).toBeInTheDocument();
    expect(screen.queryByText("run Lint")).toBeNull();
  });
});

describe("actions crash toast", () => {
  const crash: AttentionItem = { id: "a1", worktree_id: "w1", pane_id: "p1", level: "attention", message: "Serve exited with code 1", created_at_ms: 0, viewed_at_ms: null, kind: "crash", url: null, agent_kind: null, resolved_at_ms: null };

  it("names the action and restarts it", async () => {
    store.setState({ ui: { ...store.getState().ui, view: "home" } });
    store.applyFrame({ event: "attention_added", data: { item: crash } } as unknown as Frame);
    await flush();
    const [t] = store.getState().toasts;
    expect(t).toMatchObject({ level: "error", title: "Serve crashed", detail: "exit code 1 · aogashima" });
    expect(t.actions?.map((a) => a.label)).toEqual(["Logs", "Restart"]);
    t.actions![1].run();
    await flush();
    await flush();
    expect(rpcCalls()).toEqual([["action_restart", { worktree_id: "w1", action_id: "serve" }]]);
  });
});
