import { describe, expect, it } from "vitest";
import type { MenuItem } from "./components/ui";
import { MATCH, matchText, menuEntries, rankEntries, remembered, type PaletteEntry } from "./paletteModel";

const e = (key: string, label: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({ key, label, ...extra });
const keys = (list: PaletteEntry[]) => list.map((x) => x.key);

describe("matchText", () => {
  it("grades exact, prefix, word prefix, substring, fuzzy, and no match", () => {
    expect(matchText("app", "app").tier).toBe(MATCH.exact);
    expect(matchText("app", "app logs").tier).toBe(MATCH.prefix);
    expect(matchText("claude", "focus Claude · aogashima").tier).toBe(MATCH.prefix);
    expect(matchText("app", "reapply").tier).toBe(MATCH.substring);
    expect(matchText("app", "a p p").tier).toBe(MATCH.fuzzy);
    expect(matchText("app", "zsh").tier).toBe(MATCH.none);
  });
});

describe("rankEntries", () => {
  it("orders by context, then how well it matches what was typed, and recency only breaks a tie", () => {
    const entries = [e("fz", "a p p"), e("none", "zsh"), e("pre", "app logs"), e("exact", "app"), e("rec", "reapply"), e("ctx", "a big pile of prose", { context: true })];
    expect(keys(rankEntries(entries, "app", ["rec"]))).toEqual(["ctx", "exact", "pre", "rec", "fz"]);
  });

  it("lets recency separate two entries that match the query equally well", () => {
    const entries = [e("first", "app one"), e("second", "app two")];
    expect(keys(rankEntries(entries, "app", ["second"]))).toEqual(["second", "first"]);
  });

  it("keeps the source order for an empty query after context and recency", () => {
    const entries = [e("a", "alpha"), e("b", "beta"), e("c", "gamma", { context: true }), e("d", "delta")];
    expect(keys(rankEntries(entries, "", ["d", "b"]))).toEqual(["c", "d", "b", "a"]);
  });

  it("counts a hint match as fuzzy, below a label match", () => {
    const entries = [e("hint", "open", { hint: "aogashima" }), e("label", "aogashima")];
    expect(keys(rankEntries(entries, "aoga", []))).toEqual(["label", "hint"]);
  });

  it("orders fuzzy matches by fewer gaps", () => {
    expect(keys(rankEntries([e("far", "n e w   t a b"), e("near", "n-e-w-t")], "newt", []))).toEqual(["near", "far"]);
  });
});

describe("menuEntries", () => {
  it("drops separators and disabled items and nests submenus", () => {
    const run = () => {};
    const items: MenuItem[] = [
      { label: "open", run, shortcut: "⌘O" },
      { separator: true },
      { label: "locked", disabled: true, run },
      { label: "copy", submenu: [{ label: "path", run }] },
      { label: "header", disabled: true },
      { label: "active", checked: true, run },
    ];
    const list = menuEntries(items, "wt:1");
    expect(list.map((x) => [x.key, x.label, x.shortcut, x.hint])).toEqual([
      ["wt:1/open", "open", "⌘O", undefined],
      ["wt:1/copy", "copy", undefined, undefined],
      ["wt:1/active", "active", undefined, "current"],
    ]);
    expect(list[1].children?.().map((x) => x.key)).toEqual(["wt:1/copy/path"]);
  });
});

describe("remembered", () => {
  it("puts the key first, removes the old copy, and caps the list", () => {
    expect(remembered(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(remembered(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("what wins when a query is typed", () => {
  const entry = (key: string, label: string): PaletteEntry => ({ key, label, run: () => {} });

  it("puts an exact match above something used recently that merely fuzzy matches", () => {
    const fuzzyMatchesGit = entry("toggle_right_sidebar", "Toggle right sidebar");
    const ranked = rankEntries([fuzzyMatchesGit, entry("git", "Git")], "git", ["toggle_right_sidebar"]);
    expect(ranked.map((x) => x.key)).toEqual(["git", "toggle_right_sidebar"]);
  });

  it("puts a prefix match above a recent fuzzy match", () => {
    const entries = [entry("toggle_right_sidebar", "Toggle right sidebar"), entry("agents", "Agents")];
    const ranked = rankEntries(entries, "age", ["toggle_right_sidebar"]);
    expect(ranked[0].key).toBe("agents");
  });

  it("still leads with recency when nothing is typed", () => {
    const entries = [entry("home", "Home"), entry("activity", "Activity")];
    expect(rankEntries(entries, "", ["activity"])[0].key).toBe("activity");
  });

  it("keeps the worktree on screen first, whatever the query", () => {
    const here: PaletteEntry = { key: "here", label: "zzz", context: true, run: () => {} };
    expect(rankEntries([entry("other", "zzz"), here], "zzz", ["other"])[0].key).toBe("here");
  });
});
