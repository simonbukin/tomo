import { afterEach, describe, expect, it, vi } from "vitest";
import { playCover } from "./glyphCoverPlay";

const context = () =>
  new Proxy(
    { measureText: () => ({ width: 7 }), createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => ({ data: new Uint8ClampedArray(4) })), set: () => true },
  );

const host = () => {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("playCover", () => {
  it("gives a static host its position back when the cover ends, so a hidden layer leaves the flex row again", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(context as never);
    const el = host();
    const cover = playCover(el, { style: "aperture", ms: 10 });
    expect(el.style.position).toBe("relative");
    expect(el.querySelector(".glyph-cover")).not.toBeNull();
    cover.cancel();
    await cover.done;
    expect(el.style.position).toBe("");
    expect(el.querySelector(".glyph-cover")).toBeNull();
  });

  it("leaves a host that has its own position as it was", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(context as never);
    const el = host();
    el.style.position = "absolute";
    playCover(el, { style: "aperture", ms: 10 }).cancel();
    expect(el.style.position).toBe("absolute");
  });
});
