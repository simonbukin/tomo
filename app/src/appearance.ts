export type ThemeChoice = "system" | "light" | "dark";

export const ACCENTS = [
  { id: "murasaki", label: "murasaki" },
  { id: "sora", label: "sora" },
  { id: "sakura", label: "sakura" },
  { id: "sumi", label: "sumi" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];

export interface Appearance {
  theme: ThemeChoice;
  accent: AccentId;
  zoom: number;
  terminalFontSize: number | null;
}

export const defaultAppearance: Appearance = { theme: "system", accent: "murasaki", zoom: 1, terminalFontSize: null };

export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2] as const;

/** The next zoom step in a direction; an off-grid value snaps to the nearest step first. */
export function stepZoom(current: number, dir: "in" | "out" | "reset"): number {
  if (dir === "reset") return 1;
  const next = dir === "in" ? ZOOM_STEPS.find((z) => z > current + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001);
  return next ?? current;
}

/** Cmd or Ctrl with =/+, -, or 0. Returns null for anything else. */
export function zoomKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): "in" | "out" | "reset" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

/** Accepts whatever came back from saved UI state and returns a valid appearance. */
export function sanitizeAppearance(saved: unknown): Appearance {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Appearance>;
  const zoom = typeof s.zoom === "number" && s.zoom >= ZOOM_STEPS[0] && s.zoom <= ZOOM_STEPS[ZOOM_STEPS.length - 1] ? s.zoom : 1;
  const font = typeof s.terminalFontSize === "number" && s.terminalFontSize >= 8 && s.terminalFontSize <= 32 ? Math.round(s.terminalFontSize) : null;
  return {
    theme: oneOf(["system", "light", "dark"], s.theme, "system"),
    accent: oneOf(ACCENTS.map((a) => a.id), s.accent, "murasaki"),
    zoom,
    terminalFontSize: font,
  };
}

/** The theme the app should paint: an explicit choice wins over the config file. */
export function effectiveTheme(choice: ThemeChoice, configTheme: string | undefined): ThemeChoice {
  if (choice !== "system") return choice;
  return configTheme === "light" || configTheme === "dark" ? configTheme : "system";
}

/**
 * Bytes to send instead of what xterm.js would send, or null to let xterm handle the key.
 * xterm.js sends a bare CR for Shift+Enter, the same as Enter. ESC CR is what Claude Code,
 * Codex, and Pi read as "insert a newline", and what zsh inserts as a literal newline.
 */
export function keyOverride(e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">): string | null {
  if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return "\x1b\r";
  return null;
}
