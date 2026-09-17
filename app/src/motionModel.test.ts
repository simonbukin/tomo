import { describe, expect, it } from "vitest";
import { centreOf, freshPointer, originPoint, POINTER_TTL_MS, revealRadius } from "./motionModel";

const viewport = { width: 1000, height: 600 };

describe("where a transition starts", () => {
  it("opens from the pointer when one was used", () => {
    expect(originPoint("pointer", { x: 120, y: 40 }, viewport)).toEqual({ x: 120, y: 40 });
  });

  it("opens from the centre for a keyboard command, which points at nothing", () => {
    expect(originPoint("pointer", null, viewport)).toEqual({ x: 500, y: 300 });
    expect(originPoint("center", { x: 10, y: 10 }, viewport)).toEqual({ x: 500, y: 300 });
  });

  it("takes an explicit point as it is", () => {
    expect(originPoint({ x: 7, y: 9 }, null, viewport)).toEqual({ x: 7, y: 9 });
  });

  it("forgets a pointer the person has left behind", () => {
    const seen = { x: 3, y: 4, at: 1_000 };
    expect(freshPointer(seen, 1_000 + POINTER_TTL_MS)).toEqual({ x: 3, y: 4 });
    expect(freshPointer(seen, 1_001 + POINTER_TTL_MS)).toBeNull();
    expect(freshPointer(null, 0)).toBeNull();
  });
});

describe("how far the reveal travels", () => {
  it("reaches the farthest corner from the centre", () => {
    expect(revealRadius(centreOf(viewport), viewport)).toBeCloseTo(Math.hypot(500, 300));
  });

  it("reaches the opposite corner from a corner", () => {
    expect(revealRadius({ x: 0, y: 0 }, viewport)).toBeCloseTo(Math.hypot(1000, 600));
    expect(revealRadius({ x: 1000, y: 600 }, viewport)).toBeCloseTo(Math.hypot(1000, 600));
  });

  it("covers the screen from a point just off centre", () => {
    const r = revealRadius({ x: 520, y: 280 }, viewport);
    const corners = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 600 }, { x: 1000, y: 600 }];
    for (const c of corners) expect(r).toBeGreaterThanOrEqual(Math.hypot(c.x - 520, c.y - 280) - 0.001);
  });
});
