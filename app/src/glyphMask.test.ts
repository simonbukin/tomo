import { describe, expect, it } from "vitest";
import { edgeAt, maskImage, maskT } from "./glyphMask";

const box = { width: 400, height: 200, ox: 100, oy: 50 };

describe("glyph masks", () => {
  it("starts the iris at its origin and ends it at the far corner", () => {
    expect(maskT("iris", box, 100, 50)).toBe(0);
    expect(maskT("iris", box, 400, 200)).toBeCloseTo(1);
    expect(maskT("iris", box, 0, 0)).toBeLessThan(maskT("iris", box, 400, 200));
  });

  it("runs the sweep across the box from one side, or the other when reversed", () => {
    expect(maskT("sweep", box, 0, 0)).toBeCloseTo(0);
    expect(maskT("sweep", box, 400, 200)).toBeCloseTo(1);
    expect(maskT("sweep", box, 400, 0, true)).toBeCloseTo(0);
  });

  it("shows a revealing element inside the edge and hides a concealing one there", () => {
    expect(maskImage("iris", "reveal", box, 0.3)).toMatch(/radial-gradient\(circle [\d.]+px at 100\.0px 50\.0px, #000 [\d.]+px, transparent/);
    expect(maskImage("iris", "conceal", box, 0.3)).toMatch(/, transparent [\d.]+px, #000 /);
    expect(maskImage("sweep", "conceal", box, 0.5)).toMatch(/^linear-gradient\([\d.-]+deg, transparent 50\.00%, #000 /);
  });

  it("closes from the far side toward the origin", () => {
    expect(edgeAt("close", 0)).toBe(1);
    expect(edgeAt("close", 1)).toBe(0);
    expect(edgeAt("reveal", 0.25)).toBe(0.25);
  });
});
