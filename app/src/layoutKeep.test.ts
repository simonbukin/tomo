import { describe, expect, it } from "vitest";
import { KEEP_MS, keptTabs, stableOrder, type Candidate } from "./layoutKeep";

const tabs = (...list: Candidate[]) => new Map(list.map((c) => [c.id, c]));
const tab = (id: string, panes = 1, keepable = true): Candidate => ({ id, panes, keepable });
const seen = (...list: [string, number][]) => new Map(list);
const NOW = 1_000_000;

describe("which tab layouts stay mounted", () => {
  it("keeps the active tab first, then the tabs seen most recently", () => {
    expect(keptTabs(seen(["b", NOW - 2], ["c", NOW - 1]), "a", tabs(tab("a"), tab("b"), tab("c")), NOW)).toEqual(["a", "c", "b"]);
  });

  it("stops at the pane budget, so the window keeps few terminals", () => {
    expect(keptTabs(seen(["b", NOW - 1], ["c", NOW - 2], ["d", NOW - 3]), "a", tabs(tab("a", 3), tab("b", 3), tab("c", 3), tab("d", 1)), NOW, 8)).toEqual(["a", "b", "d"]);
  });

  it("never keeps a hidden tab that holds a browser pane, but always shows the active one", () => {
    expect(keptTabs(seen(["b", NOW]), "a", tabs(tab("a", 1, false), tab("b", 1, false)), NOW)).toEqual(["a"]);
  });

  it("lets a tab go after a while without a look, so its agent can sleep", () => {
    expect(keptTabs(seen(["b", NOW - KEEP_MS - 1], ["c", NOW - 5]), "a", tabs(tab("a"), tab("b"), tab("c")), NOW)).toEqual(["a", "c"]);
  });

  it("drops a tab that no longer exists", () => {
    expect(keptTabs(seen(["gone", NOW], ["b", NOW - 1]), "a", tabs(tab("a"), tab("b")), NOW)).toEqual(["a", "b"]);
  });

  it("keeps the layers in the order they were first kept", () => {
    expect(stableOrder(["a", "b", "c"], ["c", "a", "d"])).toEqual(["a", "c", "d"]);
  });
});
