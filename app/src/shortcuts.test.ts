import { describe, expect, it } from "vitest";
import { allActions } from "./actions";
import { effectiveBindings, filterShortcuts, GROUP_ORDER, groupShortcuts, opensShortcutHelp, shortcutRows } from "./shortcuts";

const commands = [
  { id: "new_tab", label: "New tab", group: "Tabs" as const },
  { id: "home", label: "Go to Home", group: "Navigation" as const },
  { id: "unbound", label: "Nothing", group: "General" as const },
  { id: "zoom_in", label: "Zoom in", group: "General" as const },
];

describe("shortcut reference", () => {
  const rows = shortcutRows(commands, effectiveBindings({ new_tab: "mod+shift+t", home: "mod+h" }));

  it("lists only bound commands and shows the config binding over the default", () => {
    expect(rows.map((r) => [r.id, r.chord])).toEqual([
      ["new_tab", "⇧⌘T"],
      ["home", "⌘H"],
      ["zoom_in", "⌘="],
    ]);
  });

  it("filters by label, group, binding text, and every word", () => {
    expect(filterShortcuts(rows, "tab").map((r) => r.id)).toEqual(["new_tab"]);
    expect(filterShortcuts(rows, "navigation").map((r) => r.id)).toEqual(["home"]);
    expect(filterShortcuts(rows, "mod+h").map((r) => r.id)).toEqual(["home"]);
    expect(filterShortcuts(rows, "zoom general").map((r) => r.id)).toEqual(["zoom_in"]);
    expect(filterShortcuts(rows, "zoom tabs")).toEqual([]);
  });

  it("groups in the fixed order and skips empty groups", () => {
    expect(groupShortcuts(rows).map((g) => g.group)).toEqual(["Navigation", "Tabs", "General"]);
  });

  it("gives every registry command a known group", () => {
    const missing = allActions().filter((a) => !a.group || !GROUP_ORDER.includes(a.group));
    expect(missing.map((a) => a.id)).toEqual([]);
  });
});

describe("opensShortcutHelp", () => {
  const key = (target: EventTarget | null, extra: Partial<KeyboardEvent> = {}) => ({ key: "?", metaKey: false, ctrlKey: false, altKey: false, target, ...extra });

  it("opens on a bare question mark outside text and terminals", () => {
    expect(opensShortcutHelp(key(document.body))).toBe(true);
    expect(opensShortcutHelp(key(null))).toBe(true);
  });

  it("does not open in an input, in a terminal, or with a modifier", () => {
    const input = document.createElement("input");
    const term = document.createElement("div");
    term.className = "xterm";
    const inner = document.createElement("textarea");
    term.appendChild(inner);
    expect(opensShortcutHelp(key(input))).toBe(false);
    expect(opensShortcutHelp(key(inner))).toBe(false);
    expect(opensShortcutHelp(key(document.body, { metaKey: true }))).toBe(false);
    expect(opensShortcutHelp(key(document.body, { key: "/" }))).toBe(false);
  });
});
