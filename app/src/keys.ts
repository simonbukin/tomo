export interface Binding {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  esc: "escape",
  return: "enter",
};

export function parseBinding(text: string): Binding | null {
  const parts = text.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const b: Binding = { mod: false, shift: false, alt: false, ctrl: false, key: "" };
  for (const p of parts) {
    if (p === "mod" || p === "cmd" || p === "meta") b.mod = true;
    else if (p === "shift") b.shift = true;
    else if (p === "alt" || p === "option") b.alt = true;
    else if (p === "ctrl" || p === "control") b.ctrl = true;
    else b.key = KEY_ALIASES[p] ?? p;
  }
  return b.key ? b : null;
}

const SHIFTED: Record<string, string> = { "{": "[", "}": "]", "<": ",", ">": ".", "?": "/", ":": ";", '"': "'", "|": "\\", "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=" };

export function eventMatches(e: KeyboardEvent, b: Binding): boolean {
  const key = e.key.toLowerCase();
  const normalized = SHIFTED[key] ?? key;
  const physical = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code.startsWith("Digit") ? e.code.slice(5) : "";
  const keyOk = normalized === b.key || key === b.key || (physical !== "" && physical === b.key);
  return keyOk && e.metaKey === b.mod && e.shiftKey === b.shift && e.altKey === b.alt && e.ctrlKey === b.ctrl;
}

export function describeBinding(text: string): string {
  const b = parseBinding(text);
  if (!b) return text;
  const parts: string[] = [];
  if (b.ctrl) parts.push("⌃");
  if (b.alt) parts.push("⌥");
  if (b.shift) parts.push("⇧");
  if (b.mod) parts.push("⌘");
  const names: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", enter: "↩", escape: "⎋" };
  parts.push(names[b.key] ?? b.key.toUpperCase());
  return parts.join("");
}

export function findAction(e: KeyboardEvent, bindings: Record<string, string>): string | null {
  for (const [action, text] of Object.entries(bindings)) {
    const b = parseBinding(text);
    if (b && eventMatches(e, b)) return action;
  }
  return null;
}
