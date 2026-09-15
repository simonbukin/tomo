export const SETTINGS_SECTIONS = ["appearance", "terminal", "keyboard", "agents", "notifications", "archive", "integrations"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const MODIFIER_KEYS = ["Meta", "Shift", "Alt", "Control", "CapsLock", "Fn", "Dead"];
const ARROWS: Record<string, string> = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down" };
const UNSHIFTED: Record<string, string> = { "{": "[", "}": "]", "<": ",", ">": ".", "?": "/", ":": ";", '"': "'", "|": "\\", "~": "`", "_": "-", "+": "=" };

/**
 * The config binding text for a key press, such as `mod+shift+d`, or null while only modifiers are down.
 * A binding needs Cmd, Ctrl, or Alt (or an F key), so it can never swallow ordinary typing in a terminal.
 */
export function bindingFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIER_KEYS.includes(e.key) || e.key === " ") return null;
  const physical = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : null;
  const lower = e.key.toLowerCase();
  const key = physical ?? ARROWS[lower] ?? UNSHIFTED[lower] ?? lower;
  if (!(e.metaKey || e.ctrlKey || e.altKey) && !/^f\d{1,2}$/.test(key)) return null;
  return [e.metaKey && "mod", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", key].filter(Boolean).join("+");
}

export const splitList = (text: string, separator: RegExp): string[] => text.split(separator).map((s) => s.trim()).filter(Boolean);
