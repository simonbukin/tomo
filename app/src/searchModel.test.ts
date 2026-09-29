import { describe, expect, it } from "vitest";
import type { PaletteEntry } from "./paletteModel";
import { groupJump, groupsFor, highlight, parseQuery, pendingFor, rowsOf, type LocalGroup, type Results } from "./searchModel";
import type { SearchHit } from "./generated";

const e = (key: string, label: string): PaletteEntry => ({ key, label, run: () => {} });
const hit = (key: string, label: string, snippet: string | null = null): SearchHit => ({ key, label, snippet, worktree_id: "w1", at_ms: 1, target: { kind: "pane", pane_id: "p1" } });
const toEntry = (h: SearchHit): PaletteEntry => ({ key: h.key, label: h.label, snippet: h.snippet ?? undefined });
const ids = (groups: { id: string }[]) => groups.map((g) => g.id);

describe("parseQuery", () => {
  it("reads a prefix as a scope and trims the rest", () => {
    expect(parseQuery("  login ")).toEqual({ scope: "all", text: "login" });
    expect(parseQuery(">split")).toEqual({ scope: "commands", text: "split" });
    expect(parseQuery("/ main.rs:12")).toEqual({ scope: "files", text: "main.rs:12" });
    expect(parseQuery("#ready")).toEqual({ scope: "tags", text: "ready" });
    expect(parseQuery("@login fix")).toEqual({ scope: "sessions", text: "login fix" });
    expect(parseQuery("$cargo")).toEqual({ scope: "terminal", text: "cargo" });
    expect(parseQuery("a>b")).toEqual({ scope: "all", text: "a>b" });
  });
});

describe("groupsFor", () => {
  const local: LocalGroup[] = [
    { id: "commands", label: "Commands", entries: [e("c1", "open login page"), e("c2", "split"), e("c3", "login again")], scope: "commands" },
    { id: "worktrees", label: "Worktrees", entries: [e("w1", "login"), e("w2", "kobe")] },
    { id: "linear", label: "Linear", entries: [e("l1", "ENG-1 nothing here")] },
  ];

  it("puts the local group with the best match first, then the daemon sources in a fixed order", () => {
    const results: Results = {
      terminal: { hits: [hit("t1", "zsh", "login ok")], total: 4, done: true },
      file: { hits: [hit("f1", "src/login.ts")], total: 1, done: false },
      activity: { hits: [], total: 0, done: true },
    };
    const groups = groupsFor(local, results, "login", [], 5, toEntry);
    expect(ids(groups)).toEqual(["worktrees", "commands", "file", "terminal"]);
    expect(groups[1].entries.map((x) => x.key)).toEqual(["c1", "c3"]);
    expect(groups.find((g) => g.id === "file")?.pending).toBe(true);
    expect(groups.find((g) => g.id === "terminal")?.more).toBe(3);
  });

  it("caps each local group and counts the rest", () => {
    const groups = groupsFor(local, {}, "l", [], 1, toEntry);
    const commands = groups.find((g) => g.id === "commands")!;
    expect(commands.entries).toHaveLength(1);
    expect(commands.more).toBe(2);
  });

  it("keeps a daemon source that has not answered yet, so its header shows that it searches", () => {
    const groups = groupsFor([], { session: { hits: [], total: 0, done: false } }, "x", [], 5, toEntry);
    expect(groups.map((g) => [g.id, g.pending, g.entries.length])).toEqual([["session", true, 0]]);
  });
});

describe("keyboard rows", () => {
  const groups = groupsFor(
    [{ id: "commands", label: "Commands", entries: [e("a", "log a"), e("b", "log b")], scope: "commands" }, { id: "worktrees", label: "Worktrees", entries: [e("c", "log c")] }],
    { terminal: { hits: [hit("t1", "zsh", "log")], total: 9, done: true } },
    "log",
    [],
    2,
    toEntry,
  );
  const rows = rowsOf(groups);

  it("walks the entries of every group and a more row where a prefix can narrow", () => {
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "c", "t1", "more:terminal"]);
  });

  it("jumps to the next group with Tab and back with Shift+Tab, and wraps", () => {
    expect(groupJump(rows, 0, 1)).toBe(2);
    expect(groupJump(rows, 1, 1)).toBe(2);
    expect(groupJump(rows, 2, 1)).toBe(3);
    expect(groupJump(rows, 4, 1)).toBe(0);
    expect(groupJump(rows, 4, -1)).toBe(3);
    expect(groupJump(rows, 3, -1)).toBe(2);
    expect(groupJump(rows, 0, -1)).toBe(3);
    expect(groupJump([], 0, 1)).toBe(0);
  });
});

describe("highlight", () => {
  it("marks a substring match, else the characters of a fuzzy match", () => {
    expect(highlight("Run cargo test", "CARGO")).toEqual([
      { text: "Run ", hit: false },
      { text: "cargo", hit: true },
      { text: " test", hit: false },
    ]);
    expect(highlight("paletteModel.ts", "pmt").filter((p) => p.hit).map((p) => p.text)).toEqual(["p", "M", "t"]);
    expect(highlight("abc", "zz")).toEqual([{ text: "abc", hit: false }]);
    expect(highlight("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("pendingFor", () => {
  it("keeps the hits of the sources that the next query searches, marked as not done", () => {
    const before: Results = { file: { hits: [hit("f", "a")], total: 1, done: true }, terminal: { hits: [], total: 0, done: true } };
    expect(pendingFor(before, ["file", "session"])).toEqual({ file: { hits: [hit("f", "a")], total: 1, done: false } });
  });
});
