import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Palette } from "./Palette";
import { getState, setState } from "./store";
import type { Repo, Worktree } from "./types";

const worktree = { id: "w1", name: "aogashima", repo_id: "r1", path: "/src/aogashima", branch: "feat/x", exists: true, archived_at_ms: null, archiving: false, is_main: false, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;
const repo = { id: "r1", name: "tomo", path: "/src/tomo" } as unknown as Repo;
const initial = getState();

const optionLabels = () => screen.queryAllByRole("option").map((o) => o.querySelector(".palette-label")?.textContent);
const crumbs = () => [...document.querySelectorAll(".palette-crumb")].map((c) => c.textContent);

async function openPalette() {
  const user = userEvent.setup();
  render(<Palette />);
  act(() => setState({ paletteOpen: true }));
  const input = await screen.findByRole("textbox", { name: "Search commands" });
  return { user, input };
}

beforeEach(() => setState({ ...initial, loaded: true, worktrees: [worktree], repos: [repo], ui: { ...initial.ui, paletteRecent: [] } }));
afterEach(cleanup);

describe("palette nested actions", () => {
  it("opens a worktree's actions with a breadcrumb and goes back with Backspace", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "aoga");
    expect(optionLabels()[0]).toBe("aogashima");

    await user.keyboard("{Enter}");
    expect(crumbs()).toEqual(["aogashima"]);
    expect(input).toHaveValue("");
    expect(optionLabels()).toEqual(expect.arrayContaining(["open", "new terminal", "new claude", "copy", "archive…"]));

    await user.keyboard("{Backspace}");
    expect(crumbs()).toEqual([]);
    expect(optionLabels()[0]).toBe("aogashima");
    expect(getState().ui.paletteRecent[0]).toBe("wt:w1");
  });

  it("goes two levels deep into a submenu", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "aogashima");
    await user.keyboard("{Enter}");
    await user.type(input, "copy");
    await user.keyboard("{Enter}");
    expect(crumbs()).toEqual(["aogashima", "copy"]);
    expect(optionLabels()).toEqual(["path", "branch", "worktree id"]);
    await user.keyboard("{Backspace}");
    expect(crumbs()).toEqual(["aogashima"]);
  });

  it("Backspace with text in the query edits the text and stays in the sub-list", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "aogashima");
    await user.keyboard("{Enter}");
    await user.type(input, "op");
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("o");
    expect(crumbs()).toEqual(["aogashima"]);
  });

  it("Cmd+Enter runs the first action of a nested entry at once", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "aogashima");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(getState().paletteOpen).toBe(false);
    expect(getState().ui.activeWorktreeId).toBe("w1");
    expect(getState().ui.view).toBe("worktree");
  });
});
