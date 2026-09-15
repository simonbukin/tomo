import { describe, expect, it } from "vitest";
import { allActions } from "./actions";
import { MENU_BAR_LAYOUT, menuBarSpec, toAccelerator, type MenuBarItem } from "./appMenu";

describe("toAccelerator", () => {
  it("maps Tomo bindings to Tauri accelerators", () => {
    expect(toAccelerator("mod+shift+d")).toBe("CmdOrCtrl+Shift+D");
    expect(toAccelerator("mod+alt+left")).toBe("CmdOrCtrl+Alt+ArrowLeft");
    expect(toAccelerator("mod+shift+[")).toBe("CmdOrCtrl+Shift+[");
    expect(toAccelerator("mod+shift+enter")).toBe("CmdOrCtrl+Shift+Enter");
    expect(toAccelerator("ctrl+tab")).toBe("Ctrl+tab");
  });

  it("gives no accelerator to a binding that a text field needs", () => {
    expect(toAccelerator("?")).toBeUndefined();
    expect(toAccelerator("alt+x")).toBeUndefined();
    expect(toAccelerator("")).toBeUndefined();
  });
});

describe("menuBarSpec", () => {
  const spec = menuBarSpec(allActions(), { new_terminal: "mod+d", palette: "mod+k", keyboard_shortcuts: "?" });
  const commandIds = (items: MenuBarItem[]) => items.flatMap((it) => (it.kind === "command" ? [it.id] : []));

  it("has the macOS menus in order", () => {
    expect(spec.map((m) => m.text)).toEqual(["Tomo", "File", "Edit", "View", "Workspace", "Pane", "Agent", "Help"]);
  });

  it("maps every layout id to a registry command", () => {
    const layoutIds = MENU_BAR_LAYOUT.flatMap((m) => m.items.filter((it): it is string => typeof it === "string" && it !== "-"));
    expect(spec.flatMap((m) => commandIds(m.items))).toEqual(layoutIds);
  });

  it("keeps the native edit items so text fields and terminals can copy and paste", () => {
    const edit = spec.find((m) => m.text === "Edit")!;
    expect(edit.items.flatMap((it) => (it.kind === "predefined" ? [it.item] : []))).toEqual(["Undo", "Redo", "Cut", "Copy", "Paste", "SelectAll"]);
  });

  it("uses registry labels and accelerators from the bindings", () => {
    const pane = spec.find((m) => m.text === "Pane")!;
    expect(pane.items[0]).toEqual({ kind: "command", id: "new_terminal", text: "New terminal (split right)", accelerator: "CmdOrCtrl+D" });
    const help = spec.find((m) => m.text === "Help")!;
    expect(help.items[0]).toEqual({ kind: "command", id: "keyboard_shortcuts", text: "Keyboard shortcuts" });
  });

  it("drops unknown ids and the separators they leave behind", () => {
    const tidy = menuBarSpec([{ id: "a", label: "A" }], {}, [{ text: "X", items: ["-", "missing", "-", "a", "-", "-", "gone", "-"] }]);
    expect(tidy[0].items).toEqual([{ kind: "command", id: "a", text: "A" }]);
  });
});
