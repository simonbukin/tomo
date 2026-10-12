import { describe, expect, it } from "vitest";
import { coversFor, type Scene } from "./coverPlan";

const scene = (over: Partial<Scene> = {}): Scene => ({ view: "worktree", worktreeId: "w1", tabId: "t1", tabIds: ["t1", "t2", "t3"], leaves: ["p1"], asleep: [], ...over });

describe("which cover a change gets", () => {
  it("draws nothing on the first scene or when nothing changed", () => {
    expect(coversFor(null, scene())).toEqual([]);
    expect(coversFor(scene(), scene())).toEqual([]);
  });

  it("opens another view or another worktree with the aperture", () => {
    expect(coversFor(scene({ view: "home" }), scene())).toEqual([{ target: { kind: "center" }, style: "aperture" }]);
    expect(coversFor(scene(), scene({ worktreeId: "w2", tabId: "t9", tabIds: ["t9"] }))).toEqual([{ target: { kind: "layout" }, style: "aperture" }]);
    expect(coversFor(scene({ tabId: null, tabIds: [] }), scene())).toEqual([{ target: { kind: "layout" }, style: "aperture" }]);
  });

  it("opens a new tab from the pointer, and surfaces the next tab after a close with silk", () => {
    expect(coversFor(scene(), scene({ tabId: "t4", tabIds: ["t1", "t2", "t3", "t4"] }))).toEqual([{ target: { kind: "layout" }, style: "aperture", fromPointer: true }]);
    expect(coversFor(scene({ tabId: "t2" }), scene({ tabId: "t1", tabIds: ["t1", "t3"] }))).toEqual([{ target: { kind: "layout" }, style: "silk" }]);
  });

  it("runs halftone toward the tab you go to", () => {
    expect(coversFor(scene({ tabId: "t1" }), scene({ tabId: "t3" }))).toEqual([{ target: { kind: "layout" }, style: "halftone", reverse: false }]);
    expect(coversFor(scene({ tabId: "t3" }), scene({ tabId: "t1" }))).toEqual([{ target: { kind: "layout" }, style: "halftone", reverse: true }]);
  });

  it("covers a new split pane, and a pane that falls asleep or wakes", () => {
    expect(coversFor(scene(), scene({ leaves: ["p1", "p2"] }))).toEqual([{ target: { kind: "pane", paneId: "p2" }, style: "halftone" }]);
    expect(coversFor(scene(), scene({ asleep: ["p1"] }))).toEqual([{ target: { kind: "pane", paneId: "p1" }, style: "silk" }]);
    expect(coversFor(scene({ asleep: ["p1"] }), scene())).toEqual([{ target: { kind: "pane", paneId: "p1" }, style: "silk" }]);
  });

  it("covers nothing for a pane that closed", () => {
    expect(coversFor(scene({ leaves: ["p1", "p2"] }), scene({ leaves: ["p1"] }))).toEqual([]);
  });
});
