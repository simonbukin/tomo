import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPresence, Worktree } from "./types";
import styles from "./WorktreeRow.module.css";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve(null)) }));

const { WorktreeRow } = await import("./Sidebar");
const { getState, setState } = await import("./store");

const nodeFsWithoutNodeTypes = "node:fs";
const { readFileSync } = await import(/* @vite-ignore */ nodeFsWithoutNodeTypes);
const moduleCss: string = readFileSync("src/WorktreeRow.module.css", "utf8");
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
  metadata: { display_name: null, project: null, state: null, tags: [] },
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
const SLOTS = ["row", "nameLine", "meta", "sub", "branch", "signalArea"] as const;
const slotCounts = (c: HTMLElement) => SLOTS.map((slot) => c.querySelectorAll(`.${styles[slot]}`).length);

describe("worktree row height contract", () => {
  const cases: [string, Worktree, AgentPresence[]][] = [
    ["quiet", worktree({ branch: null, detached: true }), []],
    ["loud", worktree({ is_main: true, git: { dirty: true } as unknown as Worktree["git"], metadata: { ...base.metadata, state: "exploring", tags: ["lr", "ui"] } }), [agent("p1", "waiting"), agent("p2", "working")]],
    ["archived", worktree({ archived_at_ms: 1 }), [agent("p1", "working")]],
    ["archiving", worktree({ archiving: true }), []],
  ];

  it.each(cases)("renders the same slots for a %s row", (_name, w, agents) => {
    expect(slotCounts(renderRow(w, agents))).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it.each(cases)("puts the status dot first on a %s row", (_name, w, agents) => {
    const row = renderRow(w, agents).querySelector(`.${styles.row}`)!;
    expect(row.firstElementChild?.className).toMatch(/\bstate\b/);
  });

  it("keeps the signal area to one line", () => {
    const [, loud, agents] = cases[1];
    const area = renderRow(loud, agents).querySelector(`.${styles.signalArea}`)!;
    expect(area.children).toHaveLength(1);
    expect(area.firstElementChild).toHaveClass("signals");
  });
});

describe("the module reads tokens only", () => {
  const declarations = [...moduleCss.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].map(([, prop, value]) => ({ prop, value: value.trim() }));
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
    const used = [...new Set([...moduleCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) expect(tokensCss, token).toContain(`${token}:`);
  });
});
