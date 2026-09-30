import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPresence, Worktree } from "./types";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { WorktreeRow } = await import("./Sidebar");
const { getState, setState } = await import("./store");
const { WorktreePreview } = await import("./WorktreePreview");

const nodeFsWithoutNodeTypes = "node:fs";
const { readFileSync } = await import(/* @vite-ignore */ nodeFsWithoutNodeTypes);
const rowCss: string = readFileSync("src/WorktreeRow.css", "utf8");
const tokensCss: string = readFileSync("src/styles/tokens.css", "utf8");

const base = {
  id: "w1",
  repo_id: "r1",
  path: "/src/kobe",
  name: "kobe",
  branch: "feat/kobe",
  head: "abc1234",
  detached: false,
  is_main: false,
  exists: true,
  git: null,
  metadata: { display_name: null, tags: [] },
  last_active_ms: null,
  first_seen_ms: null,
  archived_at_ms: null,
  archiving: false,
  tab_count: 0,
  pane_count: 0,
} satisfies Worktree;

const worktree = (over: Partial<Worktree> = {}): Worktree => ({ ...base, ...over });

const agent = (paneId: string, state: AgentPresence["state"]): AgentPresence => ({
  pane_id: paneId,
  worktree_id: "w1",
  kind: "claude",
  state,
  session_ref: null,
  authority: "report",
  updated_at_ms: 0,
  pid: null,
  estimated: false,
  seen: false,
});

const initial = getState();
beforeEach(() => setState({ ...initial, loaded: true }));
afterEach(cleanup);

function renderRow(w: Worktree, agents: AgentPresence[] = []) {
  setState({ worktrees: [w], agents: Object.fromEntries(agents.map((a) => [a.pane_id, a])) });
  return render(
    <DndContext>
      <SortableContext items={[w.id]}>
        <WorktreeRow w={w} active={false} />
      </SortableContext>
    </DndContext>,
  ).container;
}

const lineTexts = (c: HTMLElement, group: string) => [...c.querySelectorAll(`.wt-group-${group} .wt-line-text`)].map((l) => l.textContent);

describe("the worktree row", () => {
  it("draws a quiet row as the name line and the branch line, with the mark first", () => {
    const row = renderRow(worktree()).querySelector(".wt-row")!;
    expect(row.firstElementChild?.querySelector(".state")).not.toBeNull();
    expect(row.querySelector(".wt-name")).toHaveTextContent("kobe");
    expect(row.querySelector(".wt-branch")).toHaveTextContent("feat/kobe");
    expect(row.querySelectorAll(".wt-group")).toHaveLength(0);
  });

  it("puts * and a red !2 after the branch, and no ahead or behind", () => {
    const git = { dirty: true, conflicts: 2, ahead: 3, behind: 1 } as unknown as Worktree["git"];
    const branch = renderRow(worktree({ git })).querySelector(".wt-branch")!;
    expect(branch.textContent).toBe("feat/kobe*!2");
    expect(branch.querySelector(".wt-flag-bad")).toHaveTextContent("!2");
    expect(branch.textContent).not.toMatch(/[↑↓]/);
  });

  it("draws a line for a working agent but none for an idle one, and no state words", () => {
    const row = renderRow(worktree(), [agent("p1", "working"), { ...agent("p2", "idle"), kind: "codex" }]);
    expect(lineTexts(row, "agents")).toEqual(["claude"]);
    expect(row).not.toHaveTextContent(/working|idle|done, not seen/);
  });

  it("orders the groups problems, agents, apps", () => {
    setState({ rowErrors: { w1: { op: "rename", message: "the name is taken" } } });
    const row = renderRow(worktree({ exists: false }), [agent("p1", "dead")]);
    expect([...row.querySelectorAll(".wt-group")].map((g) => g.className)).toEqual(["wt-group wt-group-problems", "wt-group wt-group-agents"]);
    expect(lineTexts(row, "problems")).toEqual(["rename failedthe name is taken", "folder missingnot found on disk"]);
    expect(lineTexts(row, "agents")).toEqual(["claudeexited"]);
  });

  it("dismisses a failed operation on a click, and does not open the worktree", () => {
    setState({ rowErrors: { w1: { op: "archive", message: "a pane still writes to the folder" } } });
    const row = renderRow(worktree());
    fireEvent.click(row.querySelector('.wt-group-problems [role="button"]')!);
    expect(getState().rowErrors.w1).toBeUndefined();
    expect(getState().ui.activeWorktreeId).toBeNull();
  });

  it("draws an archived row with no mark, no lines, and archived before the branch", () => {
    const row = renderRow(worktree({ archived_at_ms: 1 }), [agent("p1", "working")]);
    expect(row.querySelector(".wt-mcell .state")).toBeNull();
    expect(row.querySelectorAll(".wt-group")).toHaveLength(0);
    expect(row.querySelector(".wt-branch")).toHaveTextContent("archived · feat/kobe");
  });

  it("draws the archive in progress as a line with the gray twinkle", () => {
    const row = renderRow(worktree({ archiving: true }));
    expect(lineTexts(row, "problems")).toEqual(["archiving"]);
    expect(row.querySelector(".wt-group-problems .state")).toHaveAttribute("data-mark", "archiving");
  });
});

describe("nothing on the row is cut off", () => {
  it("wraps the text of the row and never draws an ellipsis", () => {
    expect(rowCss).not.toMatch(/text-overflow/);
    expect(rowCss).toMatch(/\.wt-branch \{[^}]*overflow-wrap: anywhere/);
    expect(rowCss).toMatch(/\.wt-line-text \{[^}]*overflow-wrap: anywhere/);
    expect(rowCss).toMatch(/\.wt-name \{[^}]*overflow-wrap: anywhere/);
  });

  it("keeps a long branch and a long question whole in the DOM", () => {
    const branch = "feat/checkout-with-a-rather-long-branch-name-that-goes-on-and-on";
    const question = "allow Bash: pnpm test --filter auth --reporter verbose --run the-whole-suite?";
    setState({ attention: [{ id: "a1", worktree_id: "w1", pane_id: "p1", level: "attention", message: question, created_at_ms: 1, viewed_at_ms: null, kind: "waiting", url: null, agent_kind: "claude", resolved_at_ms: null }] });
    const row = renderRow(worktree({ branch }), [agent("p1", "waiting")]);
    expect(row.querySelector(".wt-branch")!.textContent).toBe(branch);
    expect(lineTexts(row, "agents")).toEqual([`claude${question}`]);
  });
});

describe("the row CSS reads tokens only", () => {
  const declarations = [...rowCss.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].map(([, prop, value]) => ({ prop, value: value.trim() }));
  const TOKEN_ONLY = /^(color|background|background-color|border-color|border-left-color|box-shadow|fill|stroke|font-family|font-size|transition|transition-duration|animation|animation-duration)$/;
  const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab)\(|\b\d+(?:\.\d+)?m?s\b|\b(?:red|green|blue|white|black|gray|grey|orange|yellow|purple|pink)\b/i;

  it("finds the declarations", () => {
    expect(declarations.length).toBeGreaterThan(20);
  });

  it("holds no color, no typeface, and no duration", () => {
    for (const { prop, value } of declarations) {
      if (TOKEN_ONLY.test(prop)) expect(value, `${prop}: ${value}`).toMatch(/var\(--/);
      expect(value, `${prop}: ${value}`).not.toMatch(LITERAL);
    }
  });

  it("reads tokens that the theme defines, so a theme change restyles the row", () => {
    const used = [...new Set([...rowCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) expect(tokensCss, token).toContain(`${token}:`);
  });
});

describe("worktree hover card", () => {
  it("shows every agent with its state in words, the git state, and the last activity", () => {
    const w = worktree({ git: { dirty: true, files_changed: 2, untracked: 0, conflicts: 0, insertions: 5, deletions: 1, ahead: 1, behind: 0, upstream: "origin/feat/kobe" } as Worktree["git"], last_active_ms: Date.now() });
    setState({ worktrees: [w], agents: { p1: agent("p1", "working"), p2: { ...agent("p2", "waiting"), kind: "codex" } } });
    const { container } = render(<WorktreePreview w={w} />);
    expect(screen.getAllByText("feat/kobe")).toHaveLength(1);
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("↑1 ↓0")).toBeInTheDocument();
    const agents = [...container.querySelectorAll(".wt-hover-line")].map((row) => row.querySelector(".wt-line-text")!.textContent);
    expect(agents).toEqual(["claudeworking", "codexneeds you"]);
    expect(container.querySelector(".wt-hover-when")!.textContent).toMatch(/ago$/);
    expect([...container.querySelectorAll(".wt-hover-title")].map((t) => t.textContent)).toEqual(["agents", "git"]);
  });

  it("puts each subagent one level in, with its kind, its task, and its age", () => {
    const withSubs = { ...agent("p1", "working"), subagents: [{ id: "a", label: "Explore", description: "find every eslint-disable", state: "exited" as const, started_at_ms: 0, updated_at_ms: 0 }] };
    setState({ agents: { p1: withSubs } });
    const { container } = render(<WorktreePreview w={worktree()} />);
    const sub = container.querySelector(".wt-line-sub")!;
    expect(sub.querySelector(".state-small")).toHaveAttribute("data-mark", "done");
    expect(sub.querySelector(".wt-line-text")!.textContent).toBe("Explorefind every eslint-disable");
    expect(sub.querySelector(".wt-line-meta")!.textContent).toMatch(/ d$/);
  });
});
