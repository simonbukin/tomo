import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "./components/ui";
import type { FsEntry, Worktree } from "./types";

vi.mock("./api", async (importOriginal) => (await import("./test-api")).mockApi(await importOriginal<typeof import("./api")>(), vi.fn(() => Promise.resolve(null))));

const { rpc } = await import("./api");
const { RightSidebar, ago, sortEntries } = await import("./RightSidebar");
const { getState, setState } = await import("./store");
const { defaultUi } = await import("./uiState");

const wt = { id: "w1", name: "kobe", repo_id: "r1", path: "/src/kobe", branch: "feat/kobe", head: "abc1234", detached: false, exists: true, archived_at_ms: null, git: null, metadata: { state: null, tags: [], project: null, display_name: null } } as unknown as Worktree;

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true, worktrees: [wt], ui: { ...defaultUi, view: "worktree", activeWorktreeId: "w1" } }));
afterEach(cleanup);

const now = Date.now();
const entries: FsEntry[] = [
  { name: "README.md", rel_path: "README.md", is_dir: false, size: 120, modified_ms: now - 2 * 86_400_000 },
  { name: "src", rel_path: "src", is_dir: true, size: 0, modified_ms: now - 3 * 3_600_000 },
  { name: "report.html", rel_path: "report.html", is_dir: false, size: 4096, modified_ms: now - 30_000 },
];
const labels = (items: MenuItem[]) => items.map((it) => ("separator" in it ? "—" : it.label));
const mocked = rpc as unknown as ReturnType<typeof vi.fn>;

describe("open inspector headings", () => {
  it("shows the section icon before the lowercase label of every section", () => {
    const { container } = render(<RightSidebar worktree={wt} />);
    const sections = [...container.querySelectorAll(".side-section")];
    expect(sections.map((s) => s.getAttribute("data-section"))).toEqual(expect.arrayContaining(["worktree", "git", "processes", "sessions", "files"]));
    for (const section of sections) expect(section.querySelector(".section-fold")?.children[1]?.tagName).toBe("svg");
    expect(container.querySelector('[data-section="git"] .section-fold')?.textContent).toMatch(/^git/);
    expect(container.querySelector('[data-section="processes"] .section-fold')?.textContent).toMatch(/^processes/);
  });
});

describe("files by recency", () => {
  afterEach(() => mocked.mockImplementation(() => Promise.resolve(null)));

  it("sorts newest first and keeps the daemon order under name", () => {
    expect(sortEntries(entries, "recent").map((e) => e.name)).toEqual(["report.html", "src", "README.md"]);
    expect(sortEntries(entries, "name")).toBe(entries);
  });

  it("writes a short age per entry", () => {
    expect(ago(now - 30_000)).toBe("now");
    expect(ago(now - 12 * 60_000)).toBe("12m");
    expect(ago(now - 3 * 3_600_000)).toBe("3h");
    expect(ago(now - 2 * 86_400_000)).toBe("2d");
  });

  it("puts the newest file first and gives a row open, reveal, and copy", async () => {
    mocked.mockImplementation((method: string) => Promise.resolve(method === "fs_list" ? entries : null));
    const { container } = render(<RightSidebar worktree={wt} />);
    await screen.findByText("report.html");
    expect([...container.querySelectorAll(".file-tree .file-name")].map((n) => n.textContent)).toEqual(["report.html", "src", "README.md"]);
    expect(container.querySelector(".file-row .file-age")?.textContent).toBe("now");
    fireEvent.contextMenu(screen.getByText("report.html"));
    expect(labels(getState().menu!.items)).toEqual(expect.arrayContaining(["open in editor", "reveal in finder", "copy path"]));
  });
});
