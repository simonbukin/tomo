import { useMemo, useSyncExternalStore } from "react";
import { useStore } from "./store";
import type { ThemeConfig } from "./types";

export const TOKENS = ["bg", "surface", "surface_hover", "fg", "fg_muted", "fg_faint", "border", "border_strong", "accent", "accent_soft", "working", "waiting", "danger", "success"] as const;
export type Token = (typeof TOKENS)[number];
export type Palette = Record<Token, string>;
export type Scheme = "light" | "dark";

export const BASE_THEMES = ["slab-dark", "slab-light"] as const;
export type BaseThemeId = (typeof BASE_THEMES)[number];
export type ThemeName = BaseThemeId | "system";

export const THEME_LABELS: Record<ThemeName, string> = { system: "system", "slab-dark": "slab dark", "slab-light": "slab light" };

export const THEMES: Record<BaseThemeId, { scheme: Scheme; palette: Palette }> = {
  "slab-dark": {
    scheme: "dark",
    palette: { bg: "#0e0e0e", surface: "#151515", surface_hover: "#1d1d1d", fg: "#ecebe8", fg_muted: "#9d9c97", fg_faint: "#6d6c68", border: "#2a2a2a", border_strong: "#3a3a3a", accent: "#ecebe8", accent_soft: "#292929", working: "#7fd28a", waiting: "#e8b14c", danger: "#ff7a66", success: "#7fd28a" },
  },
  "slab-light": {
    scheme: "light",
    palette: { bg: "#efeee9", surface: "#e7e5df", surface_hover: "#dcdad3", fg: "#121212", fg_muted: "#5b5954", fg_faint: "#85827b", border: "#cfccc4", border_strong: "#b4b1a8", accent: "#121212", accent_soft: "#cbc8c0", working: "#2f8a44", waiting: "#a66f0c", danger: "#c4412c", success: "#2f8a44" },
  },
};

export const defaultThemeConfig: ThemeConfig = { name: "system", light: "slab-light", dark: "slab-dark", colors: {} };

const isBase = (id: string): id is BaseThemeId => (BASE_THEMES as readonly string[]).includes(id);
const isHex = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

function rgb(hex: string): [number, number, number] {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** `weight` of `a` over `b`, like CSS `color-mix(in srgb, a weight, b)`, as #rrggbb. */
export function mixHex(a: string, b: string, weight: number): string {
  const [ca, cb] = [rgb(a), rgb(b)];
  return `#${ca.map((v, i) => Math.round(v * weight + cb[i] * (1 - weight)).toString(16).padStart(2, "0")).join("")}`;
}

export interface ResolvedTheme {
  id: BaseThemeId;
  scheme: Scheme;
  palette: Palette;
}

/** The theme to paint for this `[theme]` config and OS appearance. Anything unknown or malformed falls back to slab. */
export function resolveTheme(config: ThemeConfig | null | undefined, osDark: boolean): ResolvedTheme {
  const c = config ?? defaultThemeConfig;
  const picked = c.name === "system" || !isBase(c.name) ? (osDark ? c.dark : c.light) : c.name;
  const id: BaseThemeId = isBase(picked) ? picked : osDark ? "slab-dark" : "slab-light";
  const { scheme, palette: base } = THEMES[id];
  const overrides = Object.fromEntries(TOKENS.map((t) => [t, c.colors?.[t]]).filter((e): e is [Token, string] => typeof e[1] === "string" && isHex(e[1])));
  const merged: Palette = { ...base, ...overrides };
  const accentChanged = merged.accent !== base.accent && !overrides.accent_soft;
  const palette = accentChanged ? { ...merged, accent_soft: mixHex(merged.accent, merged.bg, scheme === "dark" ? 0.18 : 0.14) } : merged;
  return { id, scheme, palette };
}

export const cssVar = (token: Token) => `--${token.replace(/_/g, "-")}`;

export function cssVars(palette: Palette): Record<string, string> {
  return Object.fromEntries(TOKENS.map((t) => [cssVar(t), palette[t]]));
}

export function xtermTheme(theme: ResolvedTheme) {
  const p = theme.palette;
  return { background: p.bg, foreground: p.fg, cursor: p.fg, cursorAccent: p.bg, selectionBackground: p.accent_soft };
}

// The splash in index.html reads this before the daemon has answered, so the window opens
// on the ground the app last settled on rather than on whatever the OS prefers.
const SCHEME_KEY = "tomo.theme.scheme";

export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.dataset.theme = theme.scheme;
  Object.entries(cssVars(theme.palette)).forEach(([name, value]) => root.style.setProperty(name, value));
  try {
    localStorage.setItem(SCHEME_KEY, theme.scheme);
  } catch {
    // A webview with storage blocked still themes correctly; only the next splash guesses.
  }
}

const darkQuery = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null);

export const prefersDark = (): boolean => darkQuery()?.matches ?? false;

function onSchemeChange(listener: () => void): () => void {
  const q = darkQuery();
  q?.addEventListener("change", listener);
  return () => q?.removeEventListener("change", listener);
}

export function useResolvedTheme(): ResolvedTheme {
  const config = useStore((s) => s.config?.theme);
  const osDark = useSyncExternalStore(onSchemeChange, prefersDark);
  return useMemo(() => resolveTheme(config, osDark), [config, osDark]);
}
