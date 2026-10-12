/**
 * Text that changes in place: scramble (old letters break up, new ones settle out of flickering glyphs) and hitsujun
 * (筆順, stroke order: each letter is brushed from 丶 丿 一 十 before it settles). A frame is a pure function of the
 * progress; the DOM side gives every letter a box as wide as its final glyph, so the line never changes width.
 */
export type TextEffect = "scramble" | "hitsujun";

export interface Glyph {
  readonly ch: string;
  /** A brush stroke, drawn smaller than the letter it becomes. */
  readonly stroke: boolean;
}

const NOISE = "!<>-_\\/[]{}=+*^?#%&$@0123456789abcdefxyz";
const STROKES = ["丶", "丿", "一", "十"];
const FLICKER_PER_SECOND = 40;

const hash = (a: number, b: number): number => {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const DURATION_MS: Readonly<Record<TextEffect, number>> = { scramble: 620, hitsujun: 900 };

const letter = (ch: string): Glyph => ({ ch, stroke: false });

/** `seconds` drives the flicker, so a slow run flickers at the same rate as a fast one. */
export function scrambleFrame(from: readonly string[], to: readonly string[], k: number, seconds: number): Glyph[] {
  const n = to.length;
  return to.map((ch, i) => {
    if (ch === " ") return letter(" ");
    const leave = 0.02 + (i / n) * 0.3, settle = 0.35 + (i / n) * 0.6;
    if (k >= settle) return letter(ch);
    if (k < leave && from[i] !== undefined) return letter(from[i]);
    return letter(NOISE[Math.floor(hash(i, Math.floor(seconds * FLICKER_PER_SECOND)) * NOISE.length)]);
  });
}

export function hitsujunFrame(to: readonly string[], k: number): Glyph[] {
  const n = to.length;
  return to.map((ch, i) => {
    if (ch === " ") return letter(" ");
    const q = (k - (i / n) * 0.45) / 0.55;
    if (q <= 0) return letter("");
    const step = Math.floor(q * (STROKES.length + 1));
    return step >= STROKES.length ? letter(ch) : { ch: STROKES[step], stroke: true };
  });
}

export const frameOf = (effect: TextEffect, from: readonly string[], to: readonly string[], k: number, seconds: number): Glyph[] =>
  effect === "scramble" ? scrambleFrame(from, to, k, seconds) : hitsujunFrame(to, k);
