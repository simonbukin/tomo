import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPresence, Pane, Tab } from "../../types";

const handlers: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { invoke } = await import("@tauri-apps/api/core");
const { rpc } = await import("../../api");
const { BrowserPane } = await import("../../browser/BrowserPane");
const store = await import("../../store");

const browser = { id: "b1", tab_id: "t1", worktree_id: "w1", title: "", user_title: null, live: true, pid: null, agent: null, kind: "browser", url: "http://localhost:1420/" } as unknown as Pane;
const tab = { id: "t1", worktree_id: "w1", title: "Browser", position: 0, is_active: true, active_pane_id: "b1", layout: { type: "leaf", pane_id: "b1" } } as unknown as Tab;
const claude = { pane_id: "a1", worktree_id: "w1", kind: "claude", state: "idle", session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null } as AgentPresence;
const elsewhere = { ...claude, pane_id: "a2", worktree_id: "w2", kind: "codex" } as AgentPresence;

const writeText = vi.fn((_: string) => Promise.resolve());
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command).map(([, args]) => args);
const rpcCalls = (method: string) => vi.mocked(rpc).mock.calls.filter(([m]) => m === method).map(([, params]) => params);
const setupUser = () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return user;
};
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const report = (payload: Record<string, unknown>) => act(() => handlers["browser://feedback"]({ payload: { pane_id: "b1", kind: "change", count: 0, markdown: "", ...payload } }));
const navigated = (url: string) => act(() => handlers["browser://state"]({ payload: { pane_id: "b1", url } }));
const count = () => document.querySelector(".browser-count")?.textContent ?? null;

const initial = store.getState();
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  writeText.mockClear();
  vi.mocked(invoke).mockClear();
  vi.mocked(rpc).mockClear();
  store.setState({
    ...initial,
    panes: { b1: browser },
    tabs: { w1: [tab] },
    agents: { a1: claude, a2: elsewhere },
    ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1" },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agentation in a browser pane", () => {
  it("shows the note count that its own page reports", () => {
    render(<BrowserPane paneId="b1" active />);
    expect(count()).toBeNull();
    report({ count: 2, markdown: "## notes" });
    expect(count()).toBe("2");
    report({ pane_id: "other", count: 5 });
    expect(count()).toBe("2");
    report({ count: 0 });
    expect(count()).toBeNull();
  });

  it("copies the feedback markdown from the toolbar and from the page copy button", async () => {
    const user = setupUser();
    render(<BrowserPane paneId="b1" active />);
    report({ count: 2, markdown: "## notes" });
    await user.click(screen.getByRole("button", { name: "Copy feedback" }));
    report({ kind: "copy", count: 2, markdown: "page markdown" });
    await vi.waitFor(() => expect(writeText.mock.calls).toEqual([["## notes"], ["page markdown"]]));
  });

  it("sends the feedback to a live agent of its worktree, then clears the page", async () => {
    const user = setupUser();
    render(<BrowserPane paneId="b1" active />);
    report({ count: 3, markdown: "## notes" });
    report({ kind: "submit", count: 3, markdown: "page output" });
    expect(calls("browser_set_visible").at(-1)).toEqual({ paneId: "b1", visible: false });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Claude — idle", "Copy as markdown"]);
    await user.click(screen.getByRole("menuitem", { name: "Claude — idle" }));
    await flush();
    expect(rpcCalls("annotations_send")).toEqual([
      {
        pane_id: "a1",
        bundle: { source: "browser feedback", worktree_id: "w1", url: "http://localhost:1420/", action_id: null, annotations: [], instruction: "Review and address this feedback.", markdown: "## notes", note_count: 3 },
      },
    ]);
    expect(calls("browser_clear_annotations")).toEqual([{ paneId: "b1" }]);
    expect(count()).toBeNull();
    expect(store.getState().statusMessage?.text).toBe("Sent 3 notes to Claude");
    expect(calls("browser_set_visible").at(-1)).toEqual({ paneId: "b1", visible: true });
  });

  it("resets the count when the page goes to another url", () => {
    render(<BrowserPane paneId="b1" active />);
    report({ count: 2, markdown: "## notes" });
    navigated("http://localhost:1420/next");
    expect(count()).toBeNull();
  });

  it("asks the host for annotate only on a toggle, never on mount", async () => {
    const user = setupUser();
    render(<BrowserPane paneId="b1" active />);
    await flush();
    expect(calls("browser_set_annotate")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Annotate" }));
    await user.click(screen.getByRole("button", { name: "Stop annotating" }));
    expect(calls("browser_set_annotate")).toEqual([
      { paneId: "b1", enabled: true },
      { paneId: "b1", enabled: false },
    ]);
  });

  it("turns annotate on and off, and closes the webview on unmount", async () => {
    const user = setupUser();
    const { unmount } = render(<BrowserPane paneId="b1" active />);
    await user.click(screen.getByRole("button", { name: "Annotate" }));
    expect(calls("browser_set_annotate").at(-1)).toEqual({ paneId: "b1", enabled: true });
    expect(screen.getByRole("button", { name: "Stop annotating" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Stop annotating" }));
    expect(calls("browser_set_annotate").at(-1)).toEqual({ paneId: "b1", enabled: false });
    unmount();
    expect(calls("browser_close")).toEqual([{ paneId: "b1" }]);
  });
});
