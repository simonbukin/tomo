import { describe, expect, it } from "vitest";
import { effectiveTheme, keyOverride, sanitizeAppearance, stepZoom, zoomKey } from "./appearance";

describe("stepZoom", () => {
  it("walks the steps and stops at the ends", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(2, "in")).toBe(2);
    expect(stepZoom(0.67, "out")).toBe(0.67);
    expect(stepZoom(1.4, "reset")).toBe(1);
  });
  it("snaps an off-grid value to the next step in the direction", () => {
    expect(stepZoom(1.05, "in")).toBe(1.1);
    expect(stepZoom(1.05, "out")).toBe(1);
  });
});

describe("zoomKey", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => zoomKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  it("reads Cmd and Ctrl with = + - 0", () => {
    expect(key("=", { metaKey: true })).toBe("in");
    expect(key("+", { ctrlKey: true })).toBe("in");
    expect(key("-", { metaKey: true })).toBe("out");
    expect(key("0", { ctrlKey: true })).toBe("reset");
  });
  it("ignores plain keys and Alt chords", () => {
    expect(key("=")).toBeNull();
    expect(key("-", { metaKey: true, altKey: true })).toBeNull();
    expect(key("k", { metaKey: true })).toBeNull();
  });
});

describe("sanitizeAppearance", () => {
  it("falls back for junk and clamps ranges", () => {
    expect(sanitizeAppearance(null)).toEqual({ theme: "system", accent: "murasaki", zoom: 1, terminalFontSize: null });
    expect(sanitizeAppearance({ theme: "neon", accent: "sora", zoom: 9, terminalFontSize: 13.4 })).toEqual({ theme: "system", accent: "sora", zoom: 1, terminalFontSize: 13 });
  });
});

describe("effectiveTheme", () => {
  it("prefers the explicit choice, then the config file", () => {
    expect(effectiveTheme("light", "dark")).toBe("light");
    expect(effectiveTheme("system", "dark")).toBe("dark");
    expect(effectiveTheme("system", "system")).toBe("system");
  });
});

describe("keyOverride", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => keyOverride({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  it("sends ESC CR for Shift+Enter so agents insert a newline", () => {
    expect(key("Enter", { shiftKey: true })).toBe("\x1b\r");
  });
  it("leaves Enter and chorded Enter to xterm", () => {
    expect(key("Enter")).toBeNull();
    expect(key("Enter", { shiftKey: true, metaKey: true })).toBeNull();
    expect(key("a", { shiftKey: true })).toBeNull();
  });
});
