import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame, Repo, Worktree } from "./types";
import type { SearchHit, SearchSource } from "./generated";

const sinks = vi.hoisted(() => new Set<(f: Frame) => void>());
vi.mock("./api", async (importOriginal) => ({
  ...(await import("./test-api")).mockApi(await importOriginal<typeof import("./api")>(), vi.fn(() => Promise.resolve(null))),
  onFrame: (sink: (f: Frame) => void) => {
    sinks.add(sink);
    return () => sinks.delete(sink);
  },
}));

const { rpc } = await import("./api");
const { Palette } = await import("./Palette");
const { getState, setState } = await import("./store");

const mocked = rpc as unknown as ReturnType<typeof vi.fn>;
const worktree = { id: "w1", name: "aogashima", repo_id: "r1", path: "/src/aogashima", branch: "feat/login", exists: true, archived_at_ms: null, archiving: false, is_main: false, metadata: { state: null, tags: ["ready"], project: null, display_name: null } } as unknown as Worktree;
const repo = { id: "r1", name: "tomo", path: "/src/tomo" } as unknown as Repo;
const initial = getState();

const searches = () => mocked.mock.calls.filter(([m, p]) => m === "search" && (p as { query: string }).query !== "").map(([, p]) => p as { query_id: number; query: string; sources: SearchSource[]; limit: number });
const lastSearch = () => searches()[searches().length - 1];
const send = (query_id: number, source: SearchSource, hits: SearchHit[], total = hits.length, done = true) =>
  act(() => sinks.forEach((s) => s({ seq: 0, event: "search_results", data: { query_id, source, hits, total, done } })));
const hit = (key: string, label: string, snippet: string | null, target: SearchHit["target"]): SearchHit => ({ key, label, snippet, worktree_id: "w1", at_ms: Date.now() - 120_000, target });
const headers = () => [...document.querySelectorAll(".palette-group")].map((g) => g.firstElementChild?.textContent);
const activeLabel = () => document.querySelector(".palette-active .palette-label")?.textContent;

async function openPalette() {
  const user = userEvent.setup();
  render(<Palette />);
  act(() => setState({ paletteOpen: true }));
  const input = await screen.findByRole("textbox", { name: "Search commands" });
  return { user, input };
}

beforeEach(() => {
  mocked.mockClear();
  setState({ ...initial, loaded: true, worktrees: [worktree], repos: [repo], ui: { ...initial.ui, paletteRecent: [] } });
});
afterEach(cleanup);

describe("palette search", () => {
  it("fills the daemon caches on open, then searches every source after the typing pauses", async () => {
    const { user, input } = await openPalette();
    expect(mocked).toHaveBeenCalledWith("search", expect.objectContaining({ query: "", sources: ["file", "session", "terminal", "activity"] }));
    await user.type(input, "login");
    await waitFor(() => expect(lastSearch()?.query).toBe("login"));
    expect(searches().map((s) => s.query)).toEqual(["login"]);
    expect(lastSearch().sources).toEqual(["file", "session", "terminal", "activity"]);
  });

  it("shows streamed hits in groups with the snippet, ignores an older query, and keeps the cursor on its row", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "login");
    await waitFor(() => expect(lastSearch()).toBeDefined());
    const id = lastSearch().query_id;
    send(id - 1, "file", [hit("file:old", "old.ts", null, { kind: "file", worktree_id: "w1", path: "old.ts", line: null })]);
    send(id, "session", [hit("session:claude:s1", "Login fix", "…the login redirect loops…", { kind: "session", agent: "claude", session_id: "s1", worktree_id: "w1", pane_id: null })], 3, false);
    expect(headers()).toEqual(["Worktrees", "Sessions"]);
    expect(screen.queryByText("old.ts")).toBeNull();
    expect(document.querySelector(".palette-snippet mark")?.textContent).toBe("login");
    expect(document.querySelector(".palette-hit .palette-hint")?.textContent).toBe("aogashima · 2m");
    expect(document.querySelector(".palette-group-count")?.textContent).toBe("");

    await user.keyboard("{Tab}");
    expect(activeLabel()).toBe("Login fix");
    send(id, "file", [hit("file:w1:src/login.ts", "src/login.ts", null, { kind: "file", worktree_id: "w1", path: "src/login.ts", line: null })]);
    expect(headers()).toEqual(["Worktrees", "Files", "Sessions"]);
    expect(activeLabel()).toBe("Login fix");

    await user.keyboard("{Enter}");
    expect(mocked).toHaveBeenCalledWith("agent_spawn", expect.objectContaining({ kind: "claude", worktree_id: "w1", resume: "s1", new_tab: true }));
    expect(getState().paletteOpen).toBe(false);
    expect(getState().ui.paletteRecent).toEqual([]);
  });

  it("narrows to one source with a prefix, and the more row narrows the same way", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "log");
    await waitFor(() => expect(lastSearch()).toBeDefined());
    send(lastSearch().query_id, "terminal", [hit("term:p1:0", "zsh", "git log", { kind: "pane", pane_id: "p1" })], 40);
    expect(screen.getByText("+39 more in terminal")).toBeTruthy();
    await user.keyboard("{Shift>}{Tab}{/Shift}{ArrowDown}");
    expect(activeLabel()).toBe("+39 more in terminal");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("$log");
    await waitFor(() => expect(lastSearch().query).toBe("log"));
    await waitFor(() => expect(lastSearch().sources).toEqual(["terminal"]));
    expect(lastSearch().query).toBe("log");
    expect(lastSearch().limit).toBe(50);
  });

  it("asks for three characters before the terminal scope searches", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "$ab");
    expect(screen.getByText("type 3 or more characters")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 120));
    expect(searches()).toEqual([]);
  });

  it("lists tags with #, and a tag opens the worktrees that carry it", async () => {
    const { user, input } = await openPalette();
    await user.type(input, "#rea");
    expect(headers()).toEqual(["Tags"]);
    expect(activeLabel()).toBe("#ready");
    await user.keyboard("{Enter}");
    expect([...document.querySelectorAll(".palette-label")].map((l) => l.textContent)).toEqual(["aogashima"]);
  });

  it("names every prefix in the footer", async () => {
    await openPalette();
    expect(screen.getByLabelText("Search prefixes").textContent).toBe("> commands/ files# tags@ sessions$ terminal");
  });
});
