import type { Action, CommandGroup } from "./actions";
import { describeBinding } from "./keys";
import { useStore } from "./store";

export const GROUP_ORDER: CommandGroup[] = ["Navigation", "Worktrees", "Tabs", "Panes", "Agents", "Browser", "General"];

/** Keys that the app handles outside `[keybindings]`: window zoom in `zoomKey`, and `?` in the shell key handler. */
export const FIXED_BINDINGS: Record<string, string> = { zoom_in: "mod+=", zoom_out: "mod+-", zoom_reset: "mod+0", keyboard_shortcuts: "?" };

export function effectiveBindings(config: Record<string, string>): Record<string, string> {
  return { ...FIXED_BINDINGS, ...config };
}

export function chordFor(id: string, bindings: Record<string, string>): string | undefined {
  const text = bindings[id];
  return text ? describeBinding(text) : undefined;
}

/** Returns a lookup from command id to its key chord, from the live config. */
export function useShortcuts(): (id: string) => string | undefined {
  const config = useStore((s) => s.config?.keybindings);
  return (id) => chordFor(id, effectiveBindings(config ?? {}));
}

export interface ShortcutRow {
  id: string;
  label: string;
  group: CommandGroup;
  binding: string;
  chord: string;
}

export function shortcutRows(commands: Pick<Action, "id" | "label" | "group">[], bindings: Record<string, string>): ShortcutRow[] {
  return commands
    .filter((c) => bindings[c.id])
    .map((c) => ({ id: c.id, label: c.label, group: c.group ?? "General", binding: bindings[c.id], chord: describeBinding(bindings[c.id]) }));
}

export function filterShortcuts(rows: ShortcutRow[], query: string): ShortcutRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    const text = `${r.label} ${r.id} ${r.group} ${r.binding} ${r.chord}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function groupShortcuts(rows: ShortcutRow[]): { group: CommandGroup; rows: ShortcutRow[] }[] {
  return GROUP_ORDER.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}

/** True for a bare `?` outside a terminal and outside anything that takes text. */
export function opensShortcutHelp(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target">): boolean {
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target) return true;
  return !target.isContentEditable && !target.closest(".xterm, input, textarea, select, [contenteditable='true']");
}
