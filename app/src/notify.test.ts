import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFocused: async () => true }) }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), rpc: vi.fn(async () => null) }));

import { copyText } from "./actions";
import { applyFrame, dismissToast, getState, setState } from "./store";
import type { AttentionItem, Frame, Tab } from "./types";

const flush = () => new Promise((r) => setTimeout(r, 0));

const crash: AttentionItem = {
  id: "a1",
  worktree_id: "w1",
  pane_id: "p1",
  level: "attention",
  message: "Sampler exited with code 1",
  created_at_ms: 0,
  viewed_at_ms: null,
  kind: "crash",
  url: null,
  agent_kind: null,
  resolved_at_ms: null,
};

const added = (item: AttentionItem) => ({ event: "attention_added", data: { item } }) as unknown as Frame;
const tab = { id: "t1", worktree_id: "w1", is_active: true, active_pane_id: "p1" } as Tab;

beforeEach(() => {
  setState({ toasts: [], attention: [], statusMessage: null, tabs: { w1: [tab] }, ui: { ...getState().ui, view: "home", activeWorktreeId: null } });
});

describe("scenario C: quiet confirmation", () => {
  it("copying shows a status message and no toast", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    copyText("feat/labor-relations", "Branch");
    await flush();
    expect(getState().statusMessage?.text).toBe("Copied branch");
    expect(getState().toasts).toEqual([]);
  });
});

describe("scenario D: crash", () => {
  it("toasts elsewhere, and dismissing the toast leaves the attention item", async () => {
    applyFrame(added(crash));
    await flush();
    const [t] = getState().toasts;
    expect(t).toMatchObject({ level: "error", title: "Action crashed", detail: "exit code 1", key: "attention:a1" });
    expect(t.actions?.map((a) => a.label)).toEqual(["Logs"]);
    dismissToast(t.id);
    expect(getState().toasts).toEqual([]);
    expect(getState().attention.map((a) => a.id)).toEqual(["a1"]);
  });

  it("resolving the attention item removes its toast", async () => {
    applyFrame(added(crash));
    await flush();
    applyFrame({ event: "attention_resolved", data: { id: "a1" } } as unknown as Frame);
    expect(getState().toasts).toEqual([]);
  });
});

describe("scenario E: direct context", () => {
  it("a crash on the focused pane adds attention and no toast", async () => {
    setState({ ui: { ...getState().ui, view: "worktree", activeWorktreeId: "w1" } });
    applyFrame(added(crash));
    await flush();
    expect(getState().toasts).toEqual([]);
    expect(getState().attention).toHaveLength(1);
  });
});
