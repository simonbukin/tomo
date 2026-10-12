import { describe, expect, it } from "vitest";
import { hitsujunFrame, scrambleFrame } from "./glyphFrames";

const chars = (s: string) => [...s];
const text = (glyphs: { ch: string }[]) => glyphs.map((g) => g.ch).join("");

describe("glyph text", () => {
  it("scramble starts from the old text and ends on the new one", () => {
    expect(text(scrambleFrame(chars("Kanazawa"), chars("Hakone"), 0, 0))).toBe("Kanazawa".slice(0, 6));
    expect(text(scrambleFrame(chars("Kanazawa"), chars("Hakone"), 1, 1))).toBe("Hakone");
  });

  it("scramble keeps one glyph for each letter of the new text, and keeps spaces", () => {
    for (const k of [0.1, 0.4, 0.7]) {
      const frame = scrambleFrame(chars("old"), chars("Edit src/a.ts"), k, k);
      expect(frame).toHaveLength("Edit src/a.ts".length);
      expect(frame[4].ch).toBe(" ");
    }
  });

  it("scramble settles letters from left to right", () => {
    const frame = text(scrambleFrame(chars(""), chars("abcdefgh"), 0.6, 0.6));
    expect(frame.startsWith("abc")).toBe(true);
    expect(frame.endsWith("h")).toBe(false);
  });

  it("hitsujun brushes strokes before each letter and ends on the text", () => {
    expect(text(hitsujunFrame(chars("zsh"), 0))).toBe("");
    const middle = hitsujunFrame(chars("zsh"), 0.3);
    expect(middle.some((g) => g.stroke)).toBe(true);
    expect(middle.filter((g) => g.stroke).every((g) => "丶丿一十".includes(g.ch))).toBe(true);
    expect(text(hitsujunFrame(chars("zsh"), 1))).toBe("zsh");
    expect(hitsujunFrame(chars("zsh"), 1).every((g) => !g.stroke)).toBe(true);
  });
});
