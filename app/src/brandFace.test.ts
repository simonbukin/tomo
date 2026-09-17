import { describe, expect, it, vi } from "vitest";
import { BOX, face, SMALL_SIZE } from "./brandFace";

const SEEDS = Array.from({ length: 64 }, (_, i) => i + 1);
const px = (units: number, size: number) => (units * size) / BOX;

describe("face", () => {
  it("gives the same face for the same seed", () => {
    for (const seed of SEEDS) expect(face(seed, 128)).toEqual(face(seed, 128));
  });

  it("reads no clock and no Math.random", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random is not allowed");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now is not allowed");
    });
    expect(() => SEEDS.map((seed) => face(seed, 128))).not.toThrow();
    random.mockRestore();
    now.mockRestore();
  });

  it("gives a different face for a different seed", () => {
    const drawn = SEEDS.map((seed) => JSON.stringify(face(seed, 128)));
    expect(new Set(drawn).size).toBe(SEEDS.length);
    const strokes = new Set(SEEDS.map((seed) => face(seed, 128).stroke));
    expect(strokes.size).toBeGreaterThan(SEEDS.length / 2);
  });

  it("accepts a string seed and a number seed", () => {
    expect(face("tomo", 128)).not.toEqual(face("tomo2", 128));
    expect(face(7, 128)).toEqual(face("7", 128));
  });

  it("draws an extra mark for some seeds at a normal size", () => {
    const extras = SEEDS.filter((seed) => {
      const f = face(seed, 128);
      return f.dots.length > 2 || f.paths.length > 1;
    });
    expect(extras.length).toBeGreaterThan(0);
  });

  it("keeps every face inside the box", () => {
    for (const size of [16, 128]) {
      for (const seed of SEEDS) {
        const f = face(seed, size);
        const edge = f.stroke / 2;
        for (const p of f.mouth) {
          expect(p.x).toBeGreaterThanOrEqual(edge);
          expect(p.y).toBeGreaterThanOrEqual(edge);
          expect(p.x).toBeLessThanOrEqual(BOX - edge);
          expect(p.y).toBeLessThanOrEqual(BOX - edge);
        }
        for (const d of f.dots) {
          expect(d.cx - d.r).toBeGreaterThanOrEqual(0);
          expect(d.cy - d.r).toBeGreaterThanOrEqual(0);
          expect(d.cx + d.r).toBeLessThanOrEqual(BOX);
          expect(d.cy + d.r).toBeLessThanOrEqual(BOX);
        }
      }
    }
  });
});

describe("small size mode", () => {
  it("thickens the stroke below the threshold", () => {
    for (const seed of SEEDS) {
      const small = face(seed, SMALL_SIZE - 1);
      expect(small.stroke).toBeGreaterThanOrEqual(7);
      expect(small.stroke).toBeLessThanOrEqual(9);
      expect(px(small.stroke, 16)).toBeGreaterThanOrEqual(1);
    }
  });

  it("drops the extra mark below the threshold", () => {
    for (const seed of SEEDS) {
      const small = face(seed, SMALL_SIZE - 1);
      expect(small.dots).toHaveLength(2);
      expect(small.paths).toHaveLength(1);
    }
  });

  it("keeps two eyes apart and readable at 16 px", () => {
    for (const seed of SEEDS) {
      const [left, right] = face(seed, 16).dots;
      const gap = Math.hypot(right.cx - left.cx, right.cy - left.cy) - left.r - right.r;
      expect(px(2 * Math.min(left.r, right.r), 16)).toBeGreaterThanOrEqual(1.5);
      expect(px(gap, 16)).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves the face unclamped at and above the threshold", () => {
    const light = SEEDS.filter((seed) => face(seed, SMALL_SIZE).stroke < 7);
    expect(light.length).toBeGreaterThan(0);
  });
});
