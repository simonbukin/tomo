import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "./types";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { RightSidebar } = await import("./RightSidebar");
const { getState, setState } = await import("./store");
const { defaultUi } = await import("./uiState");

const wt = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "feat/kobe", head: "abc1234", detached: false, exists: true, archived_at_ms: null, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true, worktrees: [wt], ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w1" } }));
afterEach(cleanup);

describe("open inspector headings", () => {
  it("shows the section icon before the lowercase label of every section", () => {
    const { container } = render(<RightSidebar worktree={wt} />);
    const sections = [...container.querySelectorAll(".side-section")];
    expect(sections.map((s) => s.getAttribute("data-section"))).toEqual(expect.arrayContaining(["worktree", "git", "processes", "sessions", "files"]));
    for (const section of sections) expect(section.querySelector(".section-label")?.firstElementChild?.tagName).toBe("svg");
    expect(container.querySelector('[data-section="git"] .section-label')?.textContent).toMatch(/^git/);
    expect(container.querySelector('[data-section="processes"] .section-label')?.textContent).toMatch(/^processes/);
  });
});
