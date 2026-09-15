import { useMemo, useSyncExternalStore } from "react";
import { useStore } from "./store";
import type { ThemeConfig } from "./types";

export const TOKENS = ["bg", "surface", "surface_hover", "fg", "fg_muted", "fg_faint", "border", "border_strong", "accent", "accent_soft", "working", "waiting", "danger", "success"] as const;
export type Token = (typeof TOKENS)[number];
export type Palette = Record<Token, string>;
export type Scheme = "light" | "dark";

export const BASE_THEMES = ["murasaki-dark", "murasaki-light", "paper", "ink"] as const;
export type BaseThemeId = (typeof BASE_THEMES)[number];
export type ThemeName = BaseThemeId | "system";

export const THEME_LABELS: Record<ThemeName, string> = { system: "system", "murasaki-dark": "murasaki dark", "murasaki-light": "murasaki light", paper: "paper", ink: "ink" };

export const THEMES: Record<BaseThemeId, { scheme: Scheme; palette: Palette }> = {
  "murasaki-light": {
    scheme: "light",
    palette: { bg: "#ffffff", surface: "#f5f6f8", surface_hover: "#e8e8ee", fg: "#17171c", fg_muted: "#7a7a86", fg_faint: "#a8a8b3", border: "#e3e3e9", border_strong: "#c8c8d2", accent: "#7d4dff", accent_soft: "#ede7ff", working: "#2a9d5c", waiting: "#d98a1a", danger: "#d9433b", success: "#2a9d5c" },
  },
  "murasaki-dark": {
    scheme: "dark",
    palette: { bg: "#0f0f12", surface: "#151519", surface_hover: "#1a1a21", fg: "#e8e8ee", fg_muted: "#7f7f8c", fg_faint: "#52525e", border: "#232329", border_strong: "#34343e", accent: "#a684ff", accent_soft: "#261d45", working: "#4cc57e", waiting: "#f0a23a", danger: "#f26b63", success: "#4cc57e" },
  },
  paper: {
    scheme: "light",
    palette: { bg: "#f7f3ea", surface: "#efe9dc", surface_hover: "#e6dfcf", fg: "#2a2620", fg_muted: "#7b7263", fg_faint: "#a99f8f", border: "#e2dac9", border_strong: "#cbbfa9", accent: "#6b3fd6", accent_soft: "#e6dcf0", working: "#3b8a4e", waiting: "#b8741a", danger: "#c0412f", success: "#3b8a4e" },
  },
  ink: {
    scheme: "dark",
    palette: { bg: "#000000", surface: "#0a0a0c", surface_hover: "#141418", fg: "#f4f4f6", fg_muted: "#8e8e99", fg_faint: "#55555f", border: "#1c1c21", border_strong: "#2e2e35", accent: "#b69aff", accent_soft: "#211a38", working: "#5bd48c", waiting: "#f5ab45", danger: "#ff7a70", success: "#5bd48c" },
  },
};

export const ACCENT_PRESETS = {
  murasaki: { light: "#7d4dff", dark: "#a684ff" },
  sora: { light: "#2f7df6", dark: "#6aa8ff" },
  sakura: { light: "#d8467f", dark: "#f07aa9" },
  sumi: { light: "#3f3f48", dark: "#c9c9d4" },
} as const;
export type AccentPreset = keyof typeof ACCENT_PRESETS;

export const defaultThemeConfig: ThemeConfig = { name: "system", light: "murasaki-light", dark: "murasaki-dark", colors: {} };

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

/** The theme to paint for this `[theme]` config and OS appearance. Anything unknown or malformed falls back to Murasaki. */
export function resolveTheme(config: ThemeConfig | null | undefined, osDark: boolean): ResolvedTheme {
  const c = config ?? defaultThemeConfig;
  const picked = c.name === "system" || !isBase(c.name) ? (osDark ? c.dark : c.light) : c.name;
  const id: BaseThemeId = isBase(picked) ? picked : osDark ? "murasaki-dark" : "murasaki-light";
  const { scheme, palette: base } = THEMES[id];
  const overrides = Object.fromEntries(TOKENS.map((t) => [t, c.colors?.[t]]).filter((e): e is [Token, string] => typeof e[1] === "string" && isHex(e[1])));
  const presetAccent = c.colors?.accent && c.colors.accent in ACCENT_PRESETS ? ACCENT_PRESETS[c.colors.accent as AccentPreset][scheme] : undefined;
  const merged: Palette = { ...base, ...(presetAccent ? { accent: presetAccent } : {}), ...overrides };
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

export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.dataset.theme = theme.scheme;
  Object.entries(cssVars(theme.palette)).forEach(([name, value]) => root.style.setProperty(name, value));
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
