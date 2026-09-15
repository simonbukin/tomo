import { describe, expect, it } from "vitest";
import { eventMatches, parseBinding } from "./keys";
import { bindingFromEvent, splitList } from "./settingsModel";

const press = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("bindingFromEvent", () => {
  it("writes text that the keybinding parser matches against the same press", () => {
    const presses = [
      press("d", "KeyD", { metaKey: true, shiftKey: true }),
      press("{", "BracketLeft", { metaKey: true, shiftKey: true }),
      press("ArrowLeft", "ArrowLeft", { metaKey: true, altKey: true }),
      press("∂", "KeyD", { altKey: true }),
      press(",", "Comma", { metaKey: true }),
      press("Enter", "Enter", { metaKey: true, shiftKey: true }),
      press("F5", "F5"),
    ];
    presses.forEach((e) => {
      const text = bindingFromEvent(e);
      expect(text, e.code).not.toBeNull();
      expect(eventMatches(e, parseBinding(text!)!), text!).toBe(true);
    });
    expect(bindingFromEvent(presses[0])).toBe("mod+shift+d");
    expect(bindingFromEvent(presses[1])).toBe("mod+shift+[");
    expect(bindingFromEvent(presses[2])).toBe("mod+alt+left");
    expect(bindingFromEvent(presses[4])).toBe("mod+,");
  });

  it("waits while only modifiers are down and refuses plain typing keys", () => {
    expect(bindingFromEvent(press("Meta", "MetaLeft", { metaKey: true }))).toBeNull();
    expect(bindingFromEvent(press("h", "KeyH"))).toBeNull();
    expect(bindingFromEvent(press("H", "KeyH", { shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(press(" ", "Space", { metaKey: true }))).toBeNull();
  });
});

describe("splitList", () => {
  it("drops empty entries", () => {
    expect(splitList(" node_modules, target ,,dist ", /[\s,]+/)).toEqual(["node_modules", "target", "dist"]);
    expect(splitList("   ", /\s+/)).toEqual([]);
  });
});
