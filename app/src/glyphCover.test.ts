import { describe, expect, it } from "vitest";
import { cellAt, frontAt, STYLES, thresholds, type CoverStyle } from "./glyphCover";

const STYLE_NAMES = Object.keys(STYLES) as CoverStyle[];
const grid = { cols: 40, rows: 12, ox: 10, oy: 3 };

describe("glyph covers", () => {
  it("gives every cell a threshold from 0 to 1, and uses the whole range", () => {
    for (const style of STYLE_NAMES) {
      const at = thresholds(style, grid, 7);
      expect(at).toHaveLength(grid.cols * grid.rows);
      expect(Math.min(...at)).toBeCloseTo(0, 1);
      expect(Math.max(...at)).toBeGreaterThan(0.95);
      for (const v of at) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("covers every cell at the start of an opening and none at the end", () => {
    for (const style of STYLE_NAMES) {
      const at = thresholds(style, grid, 3);
      const start = frontAt(0, "in", STYLES[style].band), end = frontAt(1, "in", STYLES[style].band);
      expect([...at].every((v) => cellAt(style, start, v).ground === 1)).toBe(true);
      expect([...at].every((v) => cellAt(style, end, v).ground === 0)).toBe(true);
    }
  });

  it("closes the other way round", () => {
    const at = thresholds("aperture", grid, 1);
    const band = STYLES.aperture.band;
    expect([...at].every((v) => cellAt("aperture", frontAt(0, "out", band), v).ground === 0)).toBe(true);
    expect([...at].every((v) => cellAt("aperture", frontAt(1, "out", band), v).ground === 1)).toBe(true);
  });

  it("opens the aperture from its origin first", () => {
    const at = thresholds("aperture", grid, 1);
    const origin = 3 * grid.cols + 10, corner = grid.cols * grid.rows - 1;
    expect(at[origin]).toBeLessThan(at[corner]);
  });

  it("runs halftone the other way when reversed", () => {
    const left = thresholds("halftone", grid, 1), right = thresholds("halftone", grid, 1, true);
    expect(left[0]).toBeLessThan(left[grid.cols - 1]);
    expect(right[0]).toBeGreaterThan(right[grid.cols - 1]);
  });

  it("spreads silk evenly, so the front moves at a steady pace", () => {
    const at = [...thresholds("silk", { cols: 80, rows: 30, ox: 0, oy: 0 }, 11)];
    const quarters = [0.25, 0.5, 0.75].map((q) => at.filter((v) => v < q).length / at.length);
    quarters.forEach((share, i) => expect(share).toBeCloseTo([0.25, 0.5, 0.75][i], 1));
  });

  it("draws an edge glyph only inside the band", () => {
    const band = STYLES.seed.band;
    expect(cellAt("seed", 0.5, 0.5 + 0.01).glyph).toBe(-1);
    expect(cellAt("seed", 0.5, 0.5 - band / 2).glyph).toBeGreaterThanOrEqual(0);
    expect(cellAt("seed", 0.5, 0.5 - band - 0.01).glyph).toBe(-1);
  });

  it("has no cells for an empty grid", () => {
    expect(thresholds("aperture", { cols: 0, rows: 5, ox: 0, oy: 0 }, 1)).toHaveLength(0);
  });
});
