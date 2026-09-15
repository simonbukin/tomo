import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Tab } from "../types";

const handlers: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), rpc: vi.fn(() => Promise.resolve({ pane: { id: "b2" } })) }));

const { invoke } = await import("@tauri-apps/api/core");
const { openUrl } = await import("@tauri-apps/plugin-opener");
const { rpc } = await import("../api");
const { BrowserPane } = await import("./BrowserPane");
const { normalizeUrl, openInBrowser } = await import("./browser");
const { TabLayout } = await import("../Layout");
const { openEndpoint } = await import("../actions");
const { browserMenu } = await import("../menus");
const store = await import("../store");

const browser = { id: "b1", tab_id: "t1", worktree_id: "w1", title: "", user_title: null, live: true, pid: null, agent: null, kind: "browser", url: "http://localhost:1420/" } as unknown as Pane;
const tab = { id: "t1", worktree_id: "w1", title: "Browser", position: 0, is_active: true, active_pane_id: "b1", layout: { type: "leaf", pane_id: "b1" } } as unknown as Tab;

let rect = { left: 10, top: 20, width: 300, height: 200 };
let frames: FrameRequestCallback[] = [];
const runFrame = () => act(() => frames[frames.length - 1](0));
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === command).map(([, args]) => args);
const flush = () => new Promise((r) => setTimeout(r, 0));

const initial = store.getState();
beforeEach(() => {
  rect = { left: 10, top: 20, width: 300, height: 200 };
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => ({}) }) as DOMRect);
  vi.mocked(invoke).mockClear();
  vi.mocked(rpc).mockClear();
  vi.mocked(openUrl).mockClear();
  store.setState({
    ...initial,
    panes: { b1: browser },
    tabs: { w1: [tab] },
    ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1", appearance: { zoom: 1.25 } },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeUrl", () => {
  it("adds http to a bare host and keeps a scheme", () => {
    expect(normalizeUrl("  ")).toBe("about:blank");
    expect(normalizeUrl("example.com/x")).toBe("http://example.com/x");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });

  it("adds http to a host with a port and keeps a real scheme", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("localhost:3000/a?b=1")).toBe("http://localhost:3000/a?b=1");
    expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("example.com:8443/x")).toBe("http://example.com:8443/x");
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
    expect(normalizeUrl("data:text/html,hi")).toBe("data:text/html,hi");
  });
});

describe("BrowserPane", () => {
  it("creates the child webview at the zoomed bounds of the host box", () => {
    render(<BrowserPane paneId="b1" active />);
    expect(calls("browser_create")).toEqual([{ paneId: "b1", url: "http://localhost:1420/", x: 12.5, y: 25, width: 375, height: 250 }]);
  });

  it("follows the host box on every frame and sends only a change", () => {
    render(<BrowserPane paneId="b1" active />);
    runFrame();
    expect(calls("browser_set_bounds")).toEqual([]);
    rect = { left: 40, top: 20, width: 300, height: 200 };
    runFrame();
    runFrame();
    expect(calls("browser_set_bounds")).toEqual([{ paneId: "b1", x: 50, y: 25, width: 375, height: 250 }]);
    expect(frames.length).toBe(4);
  });

  it("hides the webview while a menu, a dialog, or the palette covers it", () => {
    render(<BrowserPane paneId="b1" active />);
    expect(calls("browser_set_visible")).toEqual([{ paneId: "b1", visible: true }]);
    act(() => store.setState({ paletteOpen: true }));
    expect(calls("browser_set_visible").at(-1)).toEqual({ paneId: "b1", visible: false });
  });

  it("persists a page navigation of its own pane only", () => {
    render(<BrowserPane paneId="b1" active />);
    act(() => handlers["browser://state"]({ payload: { pane_id: "other", url: "http://x/" } }));
    act(() => handlers["browser://state"]({ payload: { pane_id: "b1", url: "http://localhost:1420/next" } }));
    expect(vi.mocked(rpc).mock.calls).toEqual([["browser_navigate", { pane_id: "b1", url: "http://localhost:1420/next" }]]);
  });

  it("stops following and closes the webview on unmount", () => {
    const { unmount } = render(<BrowserPane paneId="b1" active />);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(calls("browser_close")).toEqual([{ paneId: "b1" }]);
  });

  it("is what the layout renders for a browser leaf", () => {
    const { container } = render(<TabLayout tab={tab} />);
    expect(container.querySelector(".pane-browser .browser-host")).not.toBeNull();
  });
});

describe("open a URL in Tomo", () => {
  it("navigates and focuses the live browser pane of the worktree", async () => {
    await openInBrowser("w1", "http://localhost:3000/");
    expect(vi.mocked(rpc).mock.calls).toEqual([
      ["browser_navigate", { pane_id: "b1", url: "http://localhost:3000/" }],
      ["pane_focus", { pane_id: "b1" }],
    ]);
  });

  it("opens a browser pane when the worktree has none", async () => {
    store.setState({ panes: {} });
    await openInBrowser("w1", "http://localhost:3000/");
    expect(vi.mocked(rpc).mock.calls).toEqual([["browser_open", { worktree_id: "w1", url: "http://localhost:3000/", tab_id: null }]]);
  });

  it("opens the system browser without a worktree", async () => {
    openEndpoint("http://localhost:3000/");
    await flush();
    expect(openUrl).toHaveBeenCalledWith("http://localhost:3000/");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("gives a browser pane its own menu", () => {
    const labels = browserMenu("b1").map((it) => ("separator" in it ? "—" : it.label));
    expect(labels).toEqual(["back", "forward", "reload", "—", "open in external browser", "copy", "—", "send to", "—", "close"]);
  });
});
