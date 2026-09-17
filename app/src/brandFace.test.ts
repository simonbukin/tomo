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
  });

  it("accepts a string seed and a number seed", () => {
    expect(face("tomo", 128)).not.toEqual(face("tomo2", 128));
    expect(face(7, 128)).toEqual(face("7", 128));
  });

  it("draws two eyes and one mouth, and nothing else", () => {
    for (const size of [16, 128]) {
      for (const seed of SEEDS) {
        const f = face(seed, size);
        expect(f.dots).toHaveLength(2);
        expect(f.paths).toHaveLength(1);
      }
    }
  });

  it("gives the two eyes the same size and keeps them level", () => {
    for (const size of [16, 128]) {
      for (const seed of SEEDS) {
        const [left, right] = face(seed, size).dots;
        expect(left.r).toBe(right.r);
        expect(left.cy).toBe(right.cy);
      }
    }
  });

  it("draws the mouth as a single arc", () => {
    for (const seed of SEEDS) {
      const [d] = face(seed, 128).paths;
      expect(d).toMatch(/^M[\d .-]+Q[\d .-]+$/);
      expect(d.match(/[QC]/g)).toHaveLength(1);
    }
  });

  it("bends the mouth down in the middle", () => {
    for (const seed of SEEDS) {
      const f = face(seed, 128);
      const ends = (f.mouth[0].y + f.mouth[f.mouth.length - 1].y) / 2;
      const middle = f.mouth[Math.floor(f.mouth.length / 2)].y;
      expect(middle).toBeGreaterThan(ends);
      for (const dot of f.dots) expect(dot.cy).toBeLessThan(Math.min(...f.mouth.map((m) => m.y)));
    }
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

  it("centres the face in the box", () => {
    for (const seed of SEEDS) {
      const f = face(seed, 128);
      const xs = [...f.mouth.map((m) => m.x), ...f.dots.flatMap((d) => [d.cx - d.r, d.cx + d.r])];
      const ys = [...f.mouth.map((m) => m.y), ...f.dots.flatMap((d) => [d.cy - d.r, d.cy + d.r])];
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(BOX, 0);
      expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(BOX, 0);
    }
  });
});

describe("small size mode", () => {
  it("keeps the stroke chunky below the threshold", () => {
    for (const seed of SEEDS) {
      const small = face(seed, SMALL_SIZE - 1);
      expect(small.stroke).toBeGreaterThanOrEqual(9.5);
      expect(small.stroke).toBeLessThanOrEqual(12);
      expect(px(small.stroke, 16)).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("keeps two eyes apart and readable at 16 px", () => {
    for (const seed of SEEDS) {
      const [left, right] = face(seed, 16).dots;
      const gap = right.cx - left.cx - left.r - right.r;
      expect(px(2 * left.r, 16)).toBeGreaterThanOrEqual(1.5);
      expect(px(gap, 16)).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves the stroke unclamped at and above the threshold", () => {
    const strokes = SEEDS.map((seed) => face(seed, SMALL_SIZE).stroke);
    expect(strokes.filter((s) => s < 9.5).length).toBeGreaterThan(0);
    expect(strokes.filter((s) => s > 12).length).toBeGreaterThan(0);
  });
});
