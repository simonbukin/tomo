import { describe, expect, it } from "vitest";
import { SEEN_DELAY_MS, seenDelay, type SeenView } from "./agentSeen";

const view = (patch: Partial<SeenView> = {}): SeenView => ({ paneId: "p1", state: "done", seen: false, windowActive: true, ...patch });

describe("seen timing", () => {
  it("marks a done agent seen at once when you come to its pane or to the window", () => {
    expect(seenDelay(null, view())).toBe(0);
    expect(seenDelay(view({ paneId: "p2", state: "idle" }), view())).toBe(0);
    expect(seenDelay(view({ windowActive: false }), view())).toBe(0);
  });

  it("keeps done on screen for a moment when the turn ends while you look", () => {
    expect(seenDelay(view({ state: "working" }), view())).toBe(SEEN_DELAY_MS);
  });

  it("does nothing in a window without focus, a hidden window, or away from an agent pane", () => {
    expect(seenDelay(null, view({ windowActive: false }))).toBeNull();
    expect(seenDelay(null, view({ paneId: null }))).toBeNull();
    expect(seenDelay(null, view({ state: null }))).toBeNull();
  });

  it("marks a dead agent seen once, and leaves other states alone", () => {
    expect(seenDelay(null, view({ state: "dead" }))).toBe(0);
    expect(seenDelay(null, view({ state: "dead", seen: true }))).toBeNull();
    expect(seenDelay(null, view({ state: "working" }))).toBeNull();
    expect(seenDelay(null, view({ state: "idle" }))).toBeNull();
  });
});
