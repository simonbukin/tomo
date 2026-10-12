import { describe, expect, it } from "vitest";
import { keptTabs, type Candidate } from "./layoutKeep";

const tabs = (...list: Candidate[]) => new Map(list.map((c) => [c.id, c]));
const tab = (id: string, panes = 1, keepable = true): Candidate => ({ id, panes, keepable });

describe("which tab layouts stay mounted", () => {
  it("keeps the active tab first, then the recent ones in order", () => {
    expect(keptTabs(["b", "c"], "a", tabs(tab("a"), tab("b"), tab("c")))).toEqual(["a", "b", "c"]);
    expect(keptTabs(["a", "b"], "b", tabs(tab("a"), tab("b")))).toEqual(["b", "a"]);
  });

  it("stops at the pane budget, so the window keeps few terminals", () => {
    expect(keptTabs(["b", "c", "d"], "a", tabs(tab("a", 3), tab("b", 3), tab("c", 3), tab("d", 1)), 8)).toEqual(["a", "b", "d"]);
  });

  it("never keeps a hidden tab that holds a browser pane, but always shows the active one", () => {
    expect(keptTabs(["b"], "a", tabs(tab("a", 1, false), tab("b", 1, false)))).toEqual(["a"]);
  });

  it("drops a tab that no longer exists", () => {
    expect(keptTabs(["gone", "b"], "a", tabs(tab("a"), tab("b")))).toEqual(["a", "b"]);
  });
});
