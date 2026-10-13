import { describe, expect, it } from "vitest";
import type { WorktreeLink } from "./addons/types";
import { linkGroups } from "./linkGroups";

const link = (id: string, patch: Partial<WorktreeLink> = {}): WorktreeLink => ({ id, label: "x", icon: () => null, color: undefined, text: id, title: id, facts: [], ...patch });
const shape = (links: WorktreeLink[]) => linkGroups(links).map((g) => [g.head.id, g.children.map((c) => c.id)]);

describe("linkGroups", () => {
  it("puts a pull request under the ticket that it names, and the newest group first", () => {
    const groups = shape([
      link("ENG-29", { key: "ENG-29", touchedMs: 200 }),
      link("#402", { tickets: ["ENG-29"], touchedMs: 150 }),
      link("ENG-31", { key: "ENG-31", touchedMs: 100 }),
      link("#418", { tickets: ["ENG-31"], touchedMs: 300 }),
      link("#399", { touchedMs: 250 }),
    ]);
    expect(groups).toEqual([["ENG-31", ["#418"]], ["#399", []], ["ENG-29", ["#402"]]]);
  });

  it("keeps a pull request on its own when the worktree has no link for its ticket", () => {
    expect(shape([link("#9", { tickets: ["ENG-1"] }), link("ENG-2", { key: "ENG-2" })])).toEqual([["#9", []], ["ENG-2", []]]);
  });

  it("orders the children of a ticket newest first and treats a missing time as the oldest", () => {
    const groups = shape([link("ENG-1", { key: "ENG-1" }), link("#1", { tickets: ["ENG-1"], touchedMs: 5 }), link("#2", { tickets: ["ENG-1"] }), link("#3", { tickets: ["ENG-1"], touchedMs: 9 })]);
    expect(groups).toEqual([["ENG-1", ["#3", "#1", "#2"]]]);
  });

  it("puts a link under the first ticket that it names and the worktree has", () => {
    expect(shape([link("ENG-7", { key: "ENG-7" }), link("#5", { tickets: ["UTF-8", "ENG-7"] })])).toEqual([["ENG-7", ["#5"]]]);
  });

  it("gives nothing for no links", () => {
    expect(linkGroups([])).toEqual([]);
  });
});
