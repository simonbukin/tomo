import { describe, expect, it } from "vitest";
import type { MenuEntry, MenuItem } from "./components/ui";
import { editorName, endpointMenu, paneMenu, tabMenu, toggledTag, worktreeMenu } from "./menus";
import { getState, type State } from "./store";
import type { Pane, RuntimeEndpoint, Tab, Worktree } from "./types";

const labels = (items: MenuItem[]) => items.map((it) => ("separator" in it ? "—" : it.label));
const entry = (items: MenuItem[], label: string) => items.find((it): it is MenuEntry => !("separator" in it) && it.label === label)!;

const leaf = (pane_id: string) => ({ type: "leaf", pane_id });
const worktree = { id: "w1", name: "aogashima", repo_id: "r1", path: "/src/aogashima", branch: "feat/x", exists: true, archived_at_ms: null, archiving: false, is_main: false, metadata: { state: null, tags: ["ui"], project: null, display_name: null } } as unknown as Worktree;
const tabs = [
  { id: "t1", worktree_id: "w1", title: "one", position: 0, is_active: true, active_pane_id: "p1", layout: { type: "split", id: "s1", direction: "horizontal", ratio: 0.5, first: leaf("p1"), second: leaf("p2") } },
  { id: "t2", worktree_id: "w1", title: "two", position: 1, is_active: false, active_pane_id: "p3", layout: leaf("p3") },
] as unknown as Tab[];
const pane = (id: string, tab_id: string, extra: Partial<Pane> = {}) => ({ id, tab_id, worktree_id: "w1", title: id, cwd: `/src/aogashima/${id}`, agent: null, kind: "terminal", url: null, ...extra }) as unknown as Pane;
const endpoint = (extra: Partial<RuntimeEndpoint>) => ({ id: "e1", worktree_id: "w1", pane_id: "p2", action_id: "app", pid: 1, process: "node", protocol: "http", host: "localhost", port: 3000, label: null, discovered_at_ms: 0, ...extra }) as RuntimeEndpoint;

const base = getState();
const state = {
  ...base,
  worktrees: [worktree],
  tabs: { w1: tabs },
  panes: {
    p1: pane("p1", "t1", { agent: { session_ref: "sess-1", state: "idle", kind: "claude" } as Pane["agent"] }),
    p2: pane("p2", "t1"),
    p3: pane("p3", "t2"),
  },
  endpoints: { w1: [endpoint({})] },
  config: { keybindings: { new_terminal: "mod+d", close_pane: "mod+w" }, editor_command: ["zed", "{path}"], states: [] },
  ui: { ...base.ui, view: "worktree", activeWorktreeId: "w1" },
} as unknown as State;

describe("worktree menu", () => {
  it("follows the PRD order", () => {
    expect(labels(worktreeMenu(worktree, state))).toEqual(["open", "new tab", "new terminal", "new claude", "new codex", "new pi", "—", "state", "tags", "set project…", "rename…", "—", "open in zed", "reveal in finder", "copy", "—", "archive…"]);
  });

  it("copies path, branch, and worktree id, and skips a missing branch", () => {
    expect(labels(entry(worktreeMenu(worktree, state), "copy").submenu!)).toEqual(["path", "branch", "worktree id"]);
    expect(labels(entry(worktreeMenu({ ...worktree, branch: null }, state), "copy").submenu!)).toEqual(["path", "worktree id"]);
  });

  it("lists known tags as checks with an edit item", () => {
    const tags = entry(worktreeMenu(worktree, state), "tags").submenu!;
    expect(labels(tags)).toEqual(["ui", "—", "edit tags…"]);
    expect(entry(tags, "ui").checked).toBe(true);
  });
});

describe("tab menu", () => {
  it("has rename, move, and close, with move disabled at the edges", () => {
    const first = tabMenu(tabs[0], () => {}, state);
    expect(labels(first)).toEqual(["rename", "—", "move left", "move right", "—", "close", "close others"]);
    expect(entry(first, "move left").disabled).toBe(true);
    expect(entry(first, "move right").disabled).toBe(false);
    expect(entry(tabMenu(tabs[1], () => {}, state), "move right").disabled).toBe(true);
  });
});

describe("pane menu", () => {
  it("has the PRD items, send to other tabs, and copy for cwd and session id", () => {
    const menu = paneMenu("p1", state);
    expect(labels(menu)).toEqual(["split right", "split down", "zoom", "equalize", "rotate", "swap with", "—", "send to", "—", "rename pane…", "copy", "—", "kill process tree", "close"]);
    expect(labels(entry(menu, "send to").submenu!)).toEqual(["two"]);
    expect(labels(entry(menu, "copy").submenu!)).toEqual(["cwd", "session id"]);
  });

  it("shows shortcuts only on the focused pane", () => {
    expect(entry(paneMenu("p1", state), "split right").shortcut).toBe("⌘D");
    expect(entry(paneMenu("p1", state), "close").shortcut).toBe("⌘W");
    expect(entry(paneMenu("p2", state), "split right").shortcut).toBeUndefined();
  });

  it("disables send to when the worktree has one tab", () => {
    const single = { ...state, tabs: { w1: [tabs[0]] } } as State;
    expect(entry(paneMenu("p1", single), "send to").disabled).toBe(true);
  });
});

describe("runtime menus", () => {
  it("an endpoint row menu disables open for tcp and keeps the port copy", () => {
    const menu = endpointMenu("w1", endpoint({ protocol: "tcp", action_id: null }), state);
    expect(labels(menu)).toEqual(["open", "focus logs", "—", "copy"]);
    expect(entry(menu, "open").disabled).toBe(true);
    expect(labels(entry(menu, "copy").submenu!)).toEqual(["port"]);
  });
});

describe("helpers", () => {
  it("names the editor from the command", () => {
    expect(editorName(["zed", "{path}"])).toBe("zed");
    expect(editorName(["open", "-a", "Visual Studio Code"])).toBe("Visual Studio Code");
    expect(editorName(["/usr/local/bin/cursor", "--wait"])).toBe("cursor");
    expect(editorName([])).toBe("editor");
  });

  it("toggles a tag without changing the input", () => {
    const tags = ["a", "b"];
    expect(toggledTag(tags, "a")).toEqual(["b"]);
    expect(toggledTag(tags, "c")).toEqual(["a", "b", "c"]);
    expect(tags).toEqual(["a", "b"]);
  });
});
