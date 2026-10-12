import { describe, expect, it } from "vitest";
import { coversFor, type Scene } from "./coverPlan";

const scene = (over: Partial<Scene> = {}): Scene => ({ view: "worktree", worktreeId: "w1", tabId: "t1", tabIds: ["t1", "t2", "t3"], leaves: ["p1"], asleep: [], ...over });

describe("which cover a change gets", () => {
  it("draws nothing on the first scene or when nothing changed", () => {
    expect(coversFor(null, scene())).toEqual([]);
    expect(coversFor(scene(), scene())).toEqual([]);
  });

  it("opens another view with the aperture, and masks the old worktree away with the iris", () => {
    expect(coversFor(scene({ view: "home" }), scene())).toEqual([{ kind: "cover", target: { kind: "center" }, style: "aperture" }]);
    expect(coversFor(scene(), scene({ worktreeId: "w2", tabId: "t9", tabIds: ["t9"] }))).toEqual([{ kind: "swap", fromTabId: "t1", style: "iris", fallback: "aperture" }]);
    expect(coversFor(scene({ tabId: null, tabIds: [] }), scene())).toEqual([{ kind: "cover", target: { kind: "layout" }, style: "aperture" }]);
  });

  it("masks the old tab away from the pointer for a new tab, and surfaces the next tab after a close with silk", () => {
    expect(coversFor(scene(), scene({ tabId: "t4", tabIds: ["t1", "t2", "t3", "t4"] }))).toEqual([{ kind: "swap", fromTabId: "t1", style: "iris", fromPointer: true, fallback: "aperture" }]);
    expect(coversFor(scene({ tabId: "t2" }), scene({ tabId: "t1", tabIds: ["t1", "t3"] }))).toEqual([{ kind: "cover", target: { kind: "layout" }, style: "silk" }]);
  });

  it("sweeps the old tab away toward the tab you go to", () => {
    expect(coversFor(scene({ tabId: "t1" }), scene({ tabId: "t3" }))).toEqual([{ kind: "swap", fromTabId: "t1", style: "sweep", reverse: false, fallback: "halftone" }]);
    expect(coversFor(scene({ tabId: "t3" }), scene({ tabId: "t1" }))).toEqual([{ kind: "swap", fromTabId: "t3", style: "sweep", reverse: true, fallback: "halftone" }]);
  });

  it("covers a new split pane, and a pane that falls asleep or wakes", () => {
    expect(coversFor(scene(), scene({ leaves: ["p1", "p2"] }))).toEqual([{ kind: "cover", target: { kind: "pane", paneId: "p2" }, style: "halftone" }]);
    expect(coversFor(scene(), scene({ asleep: ["p1"] }))).toEqual([{ kind: "cover", target: { kind: "pane", paneId: "p1" }, style: "silk" }]);
    expect(coversFor(scene({ asleep: ["p1"] }), scene())).toEqual([{ kind: "cover", target: { kind: "pane", paneId: "p1" }, style: "silk" }]);
  });

  it("covers nothing for a pane that closed", () => {
    expect(coversFor(scene({ leaves: ["p1", "p2"] }), scene({ leaves: ["p1"] }))).toEqual([]);
  });
});
