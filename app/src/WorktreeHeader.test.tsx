import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "./types";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { rpc } = await import("./api");
const { WorktreeHeader } = await import("./WorktreeHeader");
const { getState, setState } = await import("./store");
const { defaultUi } = await import("./uiState");

const wt = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "feat/kobe", head: "abc1234", detached: false, exists: true, archived_at_ms: null, is_main: false, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;

const initial = getState();
beforeEach(() => {
  vi.mocked(rpc).mockClear();
  setState({
    ...initial,
    loaded: true,
    worktrees: [wt],
    config: { keybindings: { reveal_finder: "mod+shift+f" }, editor_command: ["zed", "{path}"], notifications: { desktop: false, sounds: false } } as never,
    ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w1" },
  });
});
afterEach(cleanup);

describe("worktree header buttons", () => {
  it("opens Finder from a button beside the editor button", async () => {
    const { container } = render(<WorktreeHeader worktree={wt} />);
    const buttons = [...container.querySelectorAll(".actionbar button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons).toEqual(["Zed", "Reveal in Finder", "More actions"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reveal in Finder" }));
    expect(vi.mocked(rpc).mock.calls).toContainEqual(["open_external", { worktree_id: "w1", rel_path: "", target: "finder" }]);
  });
});
