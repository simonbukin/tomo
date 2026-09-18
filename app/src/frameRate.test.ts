import { describe, expect, it } from "vitest";
import { droppedAt, summarise } from "./frameRate";

describe("what the frame gaps say", () => {
  it("reports nothing without a frame", () => {
    expect(summarise([])).toEqual({ fps: 0, longestGapMs: 0 });
  });

  it("reads a steady 60 Hz as 60", () => {
    expect(summarise(Array(60).fill(16.67)).fps).toBe(60);
  });

  it("reads a steady 120 Hz as 120", () => {
    expect(summarise(Array(120).fill(8.33)).fps).toBe(120);
  });

  it("keeps the worst frame, which an average hides", () => {
    const gaps = [...Array(59).fill(16.67), 220];
    const r = summarise(gaps);
    expect(r.longestGapMs).toBe(220);
    expect(r.fps).toBeLessThan(60);
  });

  it("calls a frame late against the rate on offer, not against 60", () => {
    expect(droppedAt(60)).toBe(25);
    expect(droppedAt(120)).toBe(12.5);
    expect(summarise(Array(120).fill(8.33)).longestGapMs).toBeLessThan(droppedAt(120));
    expect(summarise([...Array(119).fill(8.33), 18]).longestGapMs).toBeGreaterThan(droppedAt(120));
  });
});
