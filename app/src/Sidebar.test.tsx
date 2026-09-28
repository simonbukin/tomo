import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPresence, Worktree } from "./types";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { WorktreeRow } = await import("./Sidebar");
const { getState, setState } = await import("./store");
const { WorktreePreview, subagentsOf } = await import("./WorktreePreview");

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

/** One slot for each part of the row. The fixed grid needs every one of them, whatever the row holds. */
const SLOTS = ["wt-row", "wt-name-line", "wt-meta", "wt-sub", "wt-branch", "wt-foot", "wt-agents", "wt-signals", "wt-tags"] as const;
const slotCounts = (c: HTMLElement) => SLOTS.map((slot) => c.querySelectorAll(`.${slot}`).length);

describe("worktree row height contract", () => {
  const cases: [string, Worktree, AgentPresence[]][] = [
    ["quiet", worktree({ branch: null, detached: true }), []],
    ["loud", worktree({ is_main: true, git: { dirty: true } as unknown as Worktree["git"], metadata: { ...base.metadata, tags: ["lr", "ui", "exploring"] } }), [agent("p1", "waiting"), agent("p2", "working")]],
    ["archived", worktree({ archived_at_ms: 1 }), [agent("p1", "working")]],
    ["archiving", worktree({ archiving: true }), []],
  ];

  it.each(cases)("renders the same slots for a %s row", (_name, w, agents) => {
    expect(slotCounts(renderRow(w, agents))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it.each(cases)("puts the status dot first on a %s row", (_name, w, agents) => {
    const row = renderRow(w, agents).querySelector(".wt-row")!;
    expect(row.firstElementChild?.className).toMatch(/\bstate\b/);
  });

  it.each(cases)("keeps the signal area to one line on a %s row", (_name, w, agents) => {
    const area = renderRow(w, agents).querySelector(".wt-signals")!;
    expect(area.children.length).toBeLessThanOrEqual(1);
  });

  it("draws the agents under the branch, not beside it", () => {
    const [, loud, agents] = cases[1];
    const row = renderRow(loud, agents);
    expect(row.querySelectorAll(".wt-agents .proc-icon")).toHaveLength(agents.length);
    expect(row.querySelector(".wt-sub")!.contains(row.querySelector(".wt-agents"))).toBe(false);
    expect(row.querySelector(".wt-foot")!.contains(row.querySelector(".wt-agents"))).toBe(true);
  });

  it("leaves the agents out of the signal line, which they used to share", () => {
    const [, loud, agents] = cases[1];
    const area = renderRow(loud, agents).querySelector(".wt-signals")!;
    expect(area.querySelectorAll(".agent-line")).toHaveLength(0);
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

describe("worktree hover preview", () => {
  it("lists the branch, the git state, each agent with its state, and the last activity", () => {
    const w = worktree({ git: { dirty: true, files_changed: 2, untracked: 0, conflicts: 0, insertions: 5, deletions: 1, ahead: 1, behind: 0, upstream: "origin/feat/kobe" } as Worktree["git"], last_active_ms: Date.now() });
    setState({ worktrees: [w], agents: { p1: agent("p1", "working"), p2: { ...agent("p2", "waiting"), kind: "codex" } } });
    const { container } = render(<WorktreePreview w={w} />);
    expect(screen.getByText("feat/kobe")).toBeInTheDocument();
    expect(screen.getByText("2 files changed")).toBeInTheDocument();
    const agents = [...container.querySelectorAll(".wt-preview-agent")].map((row) => row.textContent);
    expect(agents).toEqual([expect.stringContaining("Claudeworking"), expect.stringContaining("Codexneeds you")]);
    expect(screen.getByText(/^active/)).toBeInTheDocument();
  });
});

describe("subagents in the row", () => {
  const sub = (id: string, state: AgentPresence["state"], started: number) => ({ id, label: "Explore", description: `task ${id}`, state, started_at_ms: started , updated_at_ms: started });
  const withSubs = (subs: ReturnType<typeof sub>[]): AgentPresence => ({ ...agent("p1", "working"), subagents: subs });

  it("draws nothing for an agent without subagents, so a quiet row keeps its two units", () => {
    expect(renderRow(worktree(), [agent("p1", "working")]).querySelector(".subagents")).toBeNull();
  });

  it("nests one line per subagent under the row, each with its own state mark", () => {
    const row = renderRow(worktree(), [withSubs([sub("a", "working", 1), sub("b", "exited", 2)])]);
    const lines = [...row.querySelectorAll(".wt-row .subagents .subagent")];
    expect(lines.map((l) => l.querySelector(".subagent-desc")!.textContent)).toEqual(["task a", "task b"]);
    expect(lines[0].querySelector(".state")).toHaveClass("state-working");
    expect(lines[1].querySelector(".state")).toHaveClass("state-done");
    expect(lines[1].querySelector(".state")).toHaveAttribute("title", "done");
  });

  it("caps the row at three lines and counts the rest", () => {
    const row = renderRow(worktree(), [withSubs(["a", "b", "c", "d", "e"].map((id, i) => sub(id, "working", i)))]);
    const lines = [...row.querySelectorAll(".subagent")];
    expect(lines).toHaveLength(3);
    expect(lines[2]).toHaveTextContent("+3 more");
  });

  it("hides the subagents of an archived worktree", () => {
    expect(renderRow(worktree({ archived_at_ms: 1 }), [withSubs([sub("a", "working", 1)])]).querySelector(".subagents")).toBeNull();
  });

  it("orders the subagents that need you first, then the oldest", () => {
    const order = subagentsOf([withSubs([sub("done", "exited", 0), sub("late", "working", 9), sub("early", "working", 1)]), withSubs([sub("asks", "waiting", 5)])]).map((s) => s.id);
    expect(order).toEqual(["asks", "early", "late", "done"]);
  });
});
