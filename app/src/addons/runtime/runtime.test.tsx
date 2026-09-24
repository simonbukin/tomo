import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuEntry, MenuItem } from "../../components/ui";
import type { ActivityEvent, AttentionItem, Pane, RuntimeEndpoint, Snapshot, Tab, Worktree } from "../../generated";
import type { Frame } from "../../types";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => true }) }));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { WorktreeHeader, CheckpointBanner } = await import("../../WorktreeHeader");
const { overflowMenu } = await import("../../menus");
const { paletteEntries, worktreeChildren } = await import("../../Palette");
const { Signals, signalsFor } = await import("../../Signals");
const { signalText } = await import("../../shell/LeftRail");
const { activityView } = await import("../../activityKinds");
const store = await import("../../store");

const worktree = { id: "w1", name: "aogashima", repo_id: "r1", path: "/src/aogashima", branch: "feat/x", head: "abc1234", detached: false, exists: true, archived_at_ms: null, archiving: false, is_main: false, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const tab = { id: "t1", worktree_id: "w1", title: "one", position: 0, is_active: true, active_pane_id: "p1", layout: { type: "leaf", pane_id: "p1" } } as unknown as Tab;
const shell = { id: "p1", tab_id: "t1", worktree_id: "w1", title: "shell", user_title: null, live: true, exit_code: null, agent: null, kind: "terminal", url: null, action_id: null, source: null } as unknown as Pane;
const endpoint = (extra: Partial<RuntimeEndpoint>) => ({ id: "10:3000", worktree_id: "w1", pane_id: "p1", action_id: null, source: null, pid: 10, process: "node", protocol: "http", host: "localhost", port: 3000, label: null, discovered_at_ms: 0, ...extra }) as RuntimeEndpoint;
const app = endpoint({});
const db = endpoint({ id: "11:5432", pid: 11, process: "postgres", protocol: "tcp", port: 5432 });
const checkpoint = (url: string | null): AttentionItem => ({ id: "cp", worktree_id: "w1", pane_id: null, level: "attention", message: "look", created_at_ms: 1, viewed_at_ms: null, kind: "checkpoint", url, agent_kind: "claude", resolved_at_ms: null });

const labels = (items: MenuItem[]) => items.map((it) => ("separator" in it ? "—" : it.label));
const entry = (items: MenuItem[], label: string) => items.find((it): it is MenuEntry => !("separator" in it) && it.label === label)!;
const changed = (endpoints: RuntimeEndpoint[]) => act(() => store.applyFrame({ event: "endpoints_changed", data: { worktree_id: "w1", endpoints } } as unknown as Frame));
const snapshot = (endpoints: RuntimeEndpoint[]) =>
  ({ status: null, config: store.getState().config, repos: [], worktrees: [worktree], tabs: [tab], panes: [shell], agents: [], attention: [], resources: [], actions: [], endpoints, usage: [], ui_state: null }) as unknown as Snapshot;

const initial = store.getState();
beforeEach(() => {
  act(() => store.applySnapshot(snapshot([])));
  store.setState({
    ...initial,
    loaded: true,
    worktrees: [worktree],
    tabs: { w1: [tab] },
    panes: { p1: shell },
    toasts: [],
    attention: [],
    resources: {},
    config: { keybindings: {}, editor_command: ["zed", "{path}"], states: [], notifications: { desktop: false, sounds: false }, resource_warning_bytes: 1000 } as never,
    ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1", paletteRecent: [] },
  });
});
afterEach(cleanup);

describe("runtime header popover", () => {
  it("appears from the snapshot after the editor button, lists each endpoint, and goes away when the list empties", async () => {
    act(() => store.applySnapshot(snapshot([app, db])));
    render(<WorktreeHeader worktree={worktree} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Zed", "Reveal in Finder", "Runtime endpoints", "More actions"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Runtime endpoints" }));
    await screen.findByText("runtime");
    const rows = [...document.querySelectorAll(".runtime-row")];
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ["node", "localhost:3000", "shell · 10", "open"],
      ["postgres", "localhost:5432", "shell · 11", "open"],
    ]);
    fireEvent.contextMenu(rows[0]);
    expect(labels(store.getState().menu!.items)).toEqual(["open", "focus logs", "—", "copy"]);
    expect(labels(entry(store.getState().menu!.items, "copy").submenu!)).toEqual(["url", "port"]);
    fireEvent.contextMenu(rows[1]);
    const tcp = store.getState().menu!.items;
    expect(entry(tcp, "open").disabled).toBe(true);
    expect(labels(entry(tcp, "copy").submenu!)).toEqual(["port"]);
    changed([]);
    expect(screen.queryByRole("button", { name: "Runtime endpoints" })).toBeNull();
  });
});

describe("runtime NOW signal", () => {
  it("shows the first HTTP endpoint with an arrow, before the memory warning", () => {
    changed([db, app]);
    expect(signalsFor(store.getState(), "w1").map(signalText)).toEqual(["node :3000"]);
    act(() => store.setState({ resources: { w1: { worktree_id: "w1", rss_bytes: 5000, cpu_percent: 0, process_count: 1 } } as never }));
    expect(signalsFor(store.getState(), "w1").map(signalText)).toEqual(["node :3000", "⚠ 5 KB"]);
    render(<Signals worktreeId="w1" />);
    const line = document.querySelector(".signal-runtime")!;
    expect(line.textContent).toBe("node  :3000");
    expect(line.querySelector("svg")).not.toBeNull();
    changed([db]);
    expect(signalsFor(store.getState(), "w1").map(signalText)).toEqual(["⚠ 5 KB"]);
  });
});

describe("runtime palette and menus", () => {
  it("offers open for each HTTP endpoint in the palette context and the worktree sub-list", () => {
    changed([app, db]);
    const context = paletteEntries(store.getState()).filter((e) => e.key.startsWith("endpoint:"));
    expect(context.map((e) => [e.key, e.label, e.hint, e.context])).toEqual([["endpoint:w1:3000", "open node :3000", "aogashima · runtime", true]]);
    expect(worktreeChildren(store.getState(), worktree).filter((e) => e.key.startsWith("endpoint:")).map((e) => [e.label, e.context])).toEqual([["open node :3000", false]]);
  });

  it("lists endpoints that no pane source owns at the top of the overflow menu", () => {
    changed([app, db]);
    const menu = overflowMenu(worktree, store.getState());
    expect(labels(menu).slice(0, 4)).toEqual(["runtime", "open :3000 · node", "—", "split right"]);
    expect(entry(menu, "runtime").disabled).toBe(true);
    changed([]);
    expect(labels(overflowMenu(worktree, store.getState()))[0]).toBe("split right");
  });
});

describe("runtime app link", () => {
  it("gives the checkpoint banner the first HTTP endpoint when the item has no url", () => {
    act(() => store.setState({ attention: [checkpoint(null)] }));
    const { rerender } = render(<CheckpointBanner worktree={worktree} />);
    expect(screen.queryByRole("button", { name: "Open App" })).toBeNull();
    changed([db, app]);
    rerender(<CheckpointBanner worktree={worktree} />);
    expect(screen.getByRole("button", { name: "Open App" })).toBeInTheDocument();
    changed([db]);
    act(() => store.setState({ attention: [checkpoint("http://localhost:9000")] }));
    rerender(<CheckpointBanner worktree={worktree} />);
    expect(screen.getByRole("button", { name: "Open App" })).toBeInTheDocument();
  });

  it("gives the checkpoint and endpoint Activity rows the same link", () => {
    const row = (kind: string) => ({ id: kind, kind, worktree_id: "w1", pane_id: null, payload: {} }) as unknown as ActivityEvent;
    expect(activityView("checkpoint_created").url!(row("checkpoint_created"), store.getState())).toBeNull();
    changed([db, app]);
    expect(activityView("checkpoint_created").url!(row("checkpoint_created"), store.getState())).toBe("http://localhost:3000");
    expect(activityView("endpoint_discovered").url!(row("endpoint_discovered"), store.getState())).toBe("http://localhost:3000");
  });
});
