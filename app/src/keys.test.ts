import { describe, expect, it } from "vitest";
import { eventMatches, findAction, parseBinding } from "./keys";

function key(init: Partial<KeyboardEvent> & { key: string; code?: string }): KeyboardEvent {
  return { metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, code: "", ...init } as KeyboardEvent;
}

describe("keybindings", () => {
  it("parses modifiers and aliases", () => {
    expect(parseBinding("mod+shift+a")).toEqual({ mod: true, shift: true, alt: false, ctrl: false, key: "a" });
    expect(parseBinding("mod+alt+left")?.key).toBe("arrowleft");
    expect(parseBinding("")).toBeNull();
  });

  it("matches shifted punctuation by the unshifted key", () => {
    const b = parseBinding("mod+shift+]")!;
    expect(eventMatches(key({ key: "}", metaKey: true, shiftKey: true }), b)).toBe(true);
    expect(eventMatches(key({ key: "]", metaKey: true }), b)).toBe(false);
  });

  it("finds the bound action for an event", () => {
    const bindings = { home: "mod+h", palette: "mod+k" };
    expect(findAction(key({ key: "k", metaKey: true, code: "KeyK" }), bindings)).toBe("palette");
    expect(findAction(key({ key: "k", ctrlKey: true, code: "KeyK" }), bindings)).toBeNull();
  });
});
