import { describe, expect, it } from "vitest";
import { opacities, seedField, stepField, type Field, type Rand } from "./twinkle";

const seeded = (seed: number): Rand => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const run = (seed: number, frames: number, seconds = 1 / 60): number[][] => {
  const rand = seeded(seed);
  const fields = Array.from({ length: frames }).reduce<Field[]>((all) => [...all, stepField(all[all.length - 1], seconds, rand)], [seedField(rand)]);
  return fields.map(opacities);
};

describe("the live twinkle", () => {
  const frames = run(7, 60 * 30);

  it("keeps every cell between the ghost floor and full", () => {
    for (const frame of frames) for (const o of frame) expect(o).toBeGreaterThanOrEqual(0.2), expect(o).toBeLessThanOrEqual(1);
  });

  it("lights every cell at some time and never goes dark", () => {
    for (let c = 0; c < 9; c++) expect(Math.max(...frames.map((f) => f[c]))).toBeGreaterThan(0.7);
    for (const frame of frames.slice(60)) expect(Math.max(...frame)).toBeGreaterThan(0.35);
  });

  it("moves smoothly, with no jump bigger than a fifth at 60 frames a second", () => {
    const jumps = frames.slice(1).flatMap((f, i) => f.map((o, c) => Math.abs(o - frames[i][c])));
    expect(Math.max(...jumps)).toBeLessThan(0.2);
  });

  it("takes no big step after a long pause, such as a hidden window", () => {
    const rand = seeded(3);
    const before = seedField(rand);
    const after = stepField(before, 30, rand);
    expect(after.glow.every((g, c) => Math.abs(g - before.glow[c]) < 0.6)).toBe(true);
  });

  it("gives two marks different patterns", () => {
    expect(run(1, 120).at(-1)).not.toEqual(run(2, 120).at(-1));
  });
});
