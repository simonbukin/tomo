import type { Action } from "../actions";

/**
 * Each feature file in this folder exports `commands: Action[]`. They join the one command
 * registry that feeds the palette, keyboard shortcuts, menus, and the shortcut reference.
 */
const modules = import.meta.glob<{ commands?: Action[] }>("./*.ts", { eager: true });

export function moduleCommands(): Action[] {
  return Object.entries(modules)
    .filter(([path]) => !path.endsWith("/index.ts"))
    .flatMap(([, mod]) => mod.commands ?? []);
}
