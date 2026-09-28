import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()), revealItemInDir: vi.fn(() => Promise.resolve()) }));
vi.mock("../api", async (importOriginal) => (await import("../test-api")).mockApi(await importOriginal<typeof import("../api")>(), vi.fn(() => Promise.resolve(null))));

const { rpc } = await import("../api");
const { closePane, closeTab } = await import("../actions");
const { worktreeRelative } = await import("./editor");
const { forgetSession, putSession } = await import("./sessions");
const { edited, loaded } = await import("./model");
const { aPane } = await import("../test-fixtures");
const store = await import("../store");

const tab = { id: "t1", worktree_id: "w1", title: "main.rs", position: 0, is_active: true, active_pane_id: "e1", layout: { type: "leaf" as const, pane_id: "e1" } };

function withEditor(dirty: boolean) {
  store.setState({ panes: { e1: aPane({ id: "e1", kind: "editor", editor: { path: "src/main.rs", line: 1, col: 1 } }) }, tabs: { w1: [tab] }, dialog: null });
  putSession({ paneId: "e1", worktreeId: "w1", path: "src/main.rs", doc: edited(loaded("v1"), dirty), state: null, view: null, show: null, saved: null, scroll: null, queue: Promise.resolve(), comparing: false });
}

afterEach(() => {
  forgetSession("e1");
  vi.mocked(rpc).mockClear();
});

describe("editor entry points", () => {
  it("a path inside the worktree becomes relative; one outside is refused", () => {
    expect(worktreeRelative("/w/kobe", "/w/kobe/src/a.rs")).toBe("src/a.rs");
    expect(worktreeRelative("/w/kobe", "src/a.rs")).toBe("src/a.rs");
    expect(worktreeRelative("/w/kobe", "/w/kobe-2/a.rs")).toBeNull();
    expect(worktreeRelative("/w/kobe", "/etc/hosts")).toBeNull();
  });

  it("closing a pane with unsaved edits asks first and closes only on confirm", async () => {
    withEditor(true);
    closePane("e1");
    const dialog = store.getState().dialog;
    expect(dialog).toMatchObject({ kind: "confirm", confirmLabel: "Discard and close" });
    expect(rpc).not.toHaveBeenCalledWith("pane_close", expect.anything());
    if (dialog?.kind === "confirm") dialog.onConfirm(false);
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledWith("pane_close", { pane_id: "e1", force: false });
  });

  it("a clean editor and a tab without edits close at once", () => {
    withEditor(false);
    closePane("e1");
    closeTab("t1");
    expect(store.getState().dialog).toBeNull();
    expect(rpc).toHaveBeenCalledWith("pane_close", { pane_id: "e1", force: false });
    expect(rpc).toHaveBeenCalledWith("tab_close", { tab_id: "t1", force: false });
  });

  it("closing a tab with an unsaved editor asks first", () => {
    withEditor(true);
    closeTab("t1");
    expect(store.getState().dialog).toMatchObject({ kind: "confirm", title: "Close tab with unsaved edits?" });
    expect(rpc).not.toHaveBeenCalledWith("tab_close", expect.anything());
  });
});
