import { describe, expect, it } from "vitest";
import { containsPoint, cssPoint, dropText, shellEscape } from "./fileDrop";

describe("shellEscape", () => {
  it("leaves plain paths alone", () => {
    expect(shellEscape("/Users/me/src/app.tsx")).toBe("/Users/me/src/app.tsx");
  });

  it("quotes spaces, quotes, globs, and non-ASCII names", () => {
    expect(shellEscape("/Users/me/My Files/a.png")).toBe("'/Users/me/My Files/a.png'");
    expect(shellEscape("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(shellEscape("/tmp/*$(rm)")).toBe("'/tmp/*$(rm)'");
    expect(shellEscape("/tmp/日本.txt")).toBe("'/tmp/日本.txt'");
  });
});

describe("dropText", () => {
  it("joins several paths with a trailing space", () => {
    expect(dropText(["/a", "/b c"])).toBe("/a '/b c' ");
    expect(dropText([])).toBe("");
  });
});

describe("drop hit test", () => {
  it("converts physical pixels through the scale factor and zoom", () => {
    expect(cssPoint({ x: 400, y: 200 }, 2, 1.25)).toEqual({ x: 160, y: 80 });
    expect(cssPoint({ x: 10, y: 10 }, 0, 0)).toEqual({ x: 10, y: 10 });
  });

  it("hits only inside a visible rect", () => {
    const rect = { left: 100, top: 50, right: 300, bottom: 150 };
    expect(containsPoint(rect, { x: 100, y: 50 })).toBe(true);
    expect(containsPoint(rect, { x: 300, y: 100 })).toBe(false);
    expect(containsPoint({ left: 0, top: 0, right: 0, bottom: 0 }, { x: 0, y: 0 })).toBe(false);
  });
});
