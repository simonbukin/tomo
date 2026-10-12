import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlyphText } from "./GlyphText";

let frames: FrameRequestCallback[] = [];
let clock = 0;
const advance = (ms: number) =>
  act(() => {
    clock += ms;
    const due = frames;
    frames = [];
    due.forEach((f) => f(clock));
  });

beforeEach(() => {
  frames = [];
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("glyph text", () => {
  it("shows the first text as it is", () => {
    const { container } = render(<GlyphText text="Kanazawa" />);
    expect(container.textContent).toBe("Kanazawa");
    expect(container.querySelector(".glyph-letter")).toBeNull();
  });

  it("holds one box for each letter of the new text while it changes, then folds back to plain text", () => {
    const { container, rerender } = render(<GlyphText text="Kanazawa" />);
    rerender(<GlyphText text="Hakone" />);
    expect(container.querySelectorAll(".glyph-letter")).toHaveLength(6);
    advance(300);
    expect(container.querySelectorAll(".glyph-letter")).toHaveLength(6);
    advance(1000);
    expect(container.textContent).toBe("Hakone");
    expect(container.querySelector(".glyph-letter")).toBeNull();
  });

  it("hides the changing letters from assistive technology and says the final text once", () => {
    const { container, rerender } = render(<GlyphText text="Kanazawa" />);
    rerender(<GlyphText text="Hakone" />);
    expect([...container.querySelectorAll(".glyph-letter")].every((b) => b.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(container.querySelector(".glyph-said")?.textContent).toBe("Hakone");
    advance(2000);
    expect(container.querySelector(".glyph-said")).toBeNull();
  });

  it("lets an entrance finish when its parent renders again", () => {
    const { container, rerender } = render(<GlyphText text="zsh" effect="hitsujun" enter />);
    advance(200);
    rerender(<GlyphText text="zsh" effect="hitsujun" enter={false} />);
    expect(container.querySelectorAll(".glyph-letter")).toHaveLength(3);
    advance(2000);
    expect(container.textContent).toBe("zsh");
  });

  it("keeps a drag region on the letters, so the title still moves the window", () => {
    const { container, rerender } = render(<GlyphText text="Kanazawa" dragRegion />);
    rerender(<GlyphText text="Hakone" dragRegion />);
    expect([...container.querySelectorAll(".glyph-letter")].every((b) => b.hasAttribute("data-tauri-drag-region"))).toBe(true);
  });

  it("brushes a new text in with strokes when it enters", () => {
    const { container } = render(<GlyphText text="zsh" effect="hitsujun" enter />);
    advance(250);
    expect([...container.querySelectorAll(".glyph-stroke")].length).toBeGreaterThan(0);
    advance(2000);
    expect(container.textContent).toBe("zsh");
  });
});
