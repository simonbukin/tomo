import { describe, expect, it } from "vitest";
import type { WorktreeLink } from "./addons/types";
import { linkGroups, ticketKey } from "./linkGroups";

const link = (id: string, patch: Partial<WorktreeLink> = {}): WorktreeLink => ({ id, label: "x", icon: () => null, color: undefined, text: id, title: id, facts: [], ...patch });
const shape = (links: WorktreeLink[]) => linkGroups(links).map((g) => [g.head.id, g.children.map((c) => c.id)]);

describe("ticketKey", () => {
  it("finds the first TEAM-123 in a branch or a title", () => {
    expect(ticketKey("you/eng-31-sync-retry")).toBe("ENG-31");
    expect(ticketKey("Fix ENG-7 and ENG-8")).toBe("ENG-7");
    expect(ticketKey("feature/abc-0042")).toBe("ABC-42");
    expect(ticketKey("release-2026-10")).toBe("RELEASE-2026");
  });

  it("needs a key that starts with a letter, then only digits", () => {
    expect(ticketKey("main")).toBeNull();
    expect(ticketKey("v2-3")).toBe("V2-3");
    expect(ticketKey("2026-10-13")).toBeNull();
    expect(ticketKey("eng-31b")).toBeNull();
    expect(ticketKey("")).toBeNull();
  });
});

describe("linkGroups", () => {
  it("puts a pull request under the ticket that it names, and the newest group first", () => {
    const groups = shape([
      link("ENG-29", { key: "ENG-29", touchedMs: 200 }),
      link("#402", { ticket: "ENG-29", touchedMs: 150 }),
      link("ENG-31", { key: "ENG-31", touchedMs: 100 }),
      link("#418", { ticket: "ENG-31", touchedMs: 300 }),
      link("#399", { touchedMs: 250 }),
    ]);
    expect(groups).toEqual([["ENG-31", ["#418"]], ["#399", []], ["ENG-29", ["#402"]]]);
  });

  it("keeps a pull request on its own when the worktree has no link for its ticket", () => {
    expect(shape([link("#9", { ticket: "ENG-1" }), link("ENG-2", { key: "ENG-2" })])).toEqual([["#9", []], ["ENG-2", []]]);
  });

  it("orders the children of a ticket newest first and treats a missing time as the oldest", () => {
    const groups = shape([link("ENG-1", { key: "ENG-1" }), link("#1", { ticket: "ENG-1", touchedMs: 5 }), link("#2", { ticket: "ENG-1" }), link("#3", { ticket: "ENG-1", touchedMs: 9 })]);
    expect(groups).toEqual([["ENG-1", ["#3", "#1", "#2"]]]);
  });

  it("gives nothing for no links", () => {
    expect(linkGroups([])).toEqual([]);
  });
});
