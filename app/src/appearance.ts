/** Per-window view settings kept in UI state. Theme and terminal font live in config.toml. */
export interface Appearance {
  zoom: number;
}

export const defaultAppearance: Appearance = { zoom: 1 };

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

/** Accepts whatever came back from saved UI state and returns a valid appearance. Old theme, accent, and font fields are dropped. */
export function sanitizeAppearance(saved: unknown): Appearance {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Appearance>;
  const zoom = typeof s.zoom === "number" && s.zoom >= ZOOM_STEPS[0] && s.zoom <= ZOOM_STEPS[ZOOM_STEPS.length - 1] ? s.zoom : 1;
  return { zoom };
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
