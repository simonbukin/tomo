import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { useEffect } from "react";
import { allActions, runAction, type Action } from "./actions";
import { addonViews } from "./addons";
import { parseBinding } from "./keys";
import { effectiveBindings } from "./shortcuts";
import { recordDiagnostic, useStore } from "./store";

export type Predefined = "About" | "Services" | "Hide" | "HideOthers" | "ShowAll" | "Quit" | "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" | "Minimize" | "Fullscreen";

type LayoutItem = string | { predefined: Predefined };

export type MenuBarItem = { kind: "command"; id: string; text: string; accelerator?: string } | { kind: "separator" } | { kind: "predefined"; item: Predefined };

export interface MenuBarMenu {
  text: string;
  items: MenuBarItem[];
}

const SEP = "-";
const p = (predefined: Predefined): LayoutItem => ({ predefined });

export const MENU_BAR_LAYOUT: { text: string; items: LayoutItem[] }[] = [
  { text: "Tomo", items: [p("About"), SEP, "settings", SEP, p("Services"), SEP, p("Hide"), p("HideOthers"), p("ShowAll"), SEP, p("Quit")] },
  { text: "File", items: ["new_tab", "new_browser", SEP, "create_worktree", "add_repo", SEP, "close_tab", "close_other_tabs"] },
  { text: "Edit", items: [p("Undo"), p("Redo"), SEP, p("Cut"), p("Copy"), p("Paste"), p("SelectAll")] },
  { text: "View", items: ["palette", SEP, "home", "activity", ...addonViews().map((v) => v.id), "toggle_board", SEP, "toggle_left_sidebar", "toggle_right_sidebar", SEP, "zoom_in", "zoom_out", "zoom_reset", SEP, p("Minimize"), p("Fullscreen")] },
  { text: "Workspace", items: ["next_worktree", "prev_worktree", SEP, "next_tab", "prev_tab", "move_tab_left", "move_tab_right", "rename_tab", SEP, "open_editor", "reveal_finder", "copy_path", SEP, "refresh", "archive_worktree"] },
  { text: "Pane", items: ["new_terminal", "split_vertical", SEP, "zoom_pane", "equalize_panes", "rotate_split", SEP, "focus_left", "focus_right", "focus_up", "focus_down", SEP, "kill_pane_tree", "close_pane"] },
  { text: "Agent", items: ["spawn_claude", "spawn_codex", "spawn_pi", SEP, "next_attention", "clear_attention", SEP, "integrations", "hook_log"] },
  { text: "Help", items: ["keyboard_shortcuts", "config_check"] },
];

const ACCEL_KEYS: Record<string, string> = { arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", enter: "Enter", escape: "Escape" };

/** A binding without Cmd or Ctrl gets no accelerator: a native menu item would take that key from every text field. */
export function toAccelerator(binding: string): string | undefined {
  const b = parseBinding(binding);
  if (!b || !(b.mod || b.ctrl)) return undefined;
  const key = ACCEL_KEYS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return [b.mod && "CmdOrCtrl", b.ctrl && "Ctrl", b.alt && "Alt", b.shift && "Shift", key].filter(Boolean).join("+");
}

function tidy(items: MenuBarItem[]): MenuBarItem[] {
  const out = items.reduce<MenuBarItem[]>((acc, it) => (it.kind === "separator" && (acc.length === 0 || acc[acc.length - 1].kind === "separator") ? acc : [...acc, it]), []);
  return out[out.length - 1]?.kind === "separator" ? out.slice(0, -1) : out;
}

export function menuBarSpec(commands: Pick<Action, "id" | "label">[], bindings: Record<string, string>, layout = MENU_BAR_LAYOUT): MenuBarMenu[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  return layout.map((menu) => ({
    text: menu.text,
    items: tidy(
      menu.items.flatMap((it): MenuBarItem[] => {
        if (typeof it !== "string") return [{ kind: "predefined", item: it.predefined }];
        if (it === SEP) return [{ kind: "separator" }];
        const cmd = byId.get(it);
        if (!cmd) return [];
        const accelerator = bindings[it] ? toAccelerator(bindings[it]) : undefined;
        return [{ kind: "command", id: it, text: cmd.label, ...(accelerator ? { accelerator } : {}) }];
      }),
    ),
  }));
}

function tauriItem(it: MenuBarItem, run: (id: string) => void) {
  if (it.kind === "separator") return { item: "Separator" as const };
  if (it.kind === "predefined") return { item: it.item === "About" ? { About: null } : it.item };
  return { id: it.id, text: it.text, accelerator: it.accelerator, action: () => run(it.id) };
}

export async function installAppMenu(spec: MenuBarMenu[], run: (id: string) => void): Promise<void> {
  // ponytail: the previous menu resource is not closed on a rebuild; it happens only when the config keybindings change.
  const menu = await Menu.new({ items: spec.map((m) => ({ text: m.text, items: m.items.map((it) => tauriItem(it, run)) })) });
  await menu.setAsAppMenu();
}

/** Builds the macOS menu bar from the command registry and rebuilds it when the keybindings change. */
export function useAppMenu(): void {
  const bindings = useStore((s) => s.config?.keybindings);
  useEffect(() => {
    if (!bindings || !isTauri()) return;
    installAppMenu(menuBarSpec(allActions(), effectiveBindings(bindings)), runAction).catch((e) => recordDiagnostic("error", "app", `menu bar: ${String(e)}`));
  }, [bindings]);
}
