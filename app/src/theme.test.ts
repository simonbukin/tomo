import { describe, expect, it } from "vitest";
import { applyTheme, cssVar, cssVars, mixHex, resolveTheme, THEMES, TOKENS, xtermTheme } from "./theme";

const config = (patch: Record<string, unknown> = {}) => ({ name: "system", light: "slab-light", dark: "slab-dark", colors: {}, ...patch }) as never;

describe("built-in themes", () => {
  it("define every token as a hex color", () => {
    Object.values(THEMES).forEach(({ palette }) => {
      expect(Object.keys(palette).sort()).toEqual([...TOKENS].sort());
      Object.values(palette).forEach((v) => expect(v).toMatch(/^#[0-9a-f]{6}$/));
    });
  });

  it("match the slab first-paint values in tokens.css", async () => {
    const nodeFsWithoutNodeTypes = "node:fs";
    const { readFileSync } = await import(/* @vite-ignore */ nodeFsWithoutNodeTypes);
    const tokensCss: string = readFileSync("src/styles/tokens.css", "utf8");
    const block = (selector: string) => tokensCss.slice(tokensCss.indexOf(selector), tokensCss.indexOf("}", tokensCss.indexOf(selector)));
    const read = (css: string, token: string) => new RegExp(`${cssVar(token as never)}:\\s*(#[0-9a-f]+);`).exec(css)?.[1];
    TOKENS.forEach((t) => {
      expect(read(block(":root {"), t), t).toBe(THEMES["slab-light"].palette[t]);
      expect(read(block(':root[data-theme="dark"]'), t), t).toBe(THEMES["slab-dark"].palette[t]);
    });
  });
});

describe("resolveTheme", () => {
  it("follows the OS in system mode with the chosen light and dark themes", () => {
    expect(resolveTheme(null, false).id).toBe("slab-light");
    expect(resolveTheme(null, true).id).toBe("slab-dark");
    const c = config({ light: "slab-dark", dark: "slab-light" });
    expect(resolveTheme(c, false)).toMatchObject({ id: "slab-dark", scheme: "dark" });
    expect(resolveTheme(c, true)).toMatchObject({ id: "slab-light", scheme: "light" });
  });

  it("uses an explicit theme whatever the OS says", () => {
    expect(resolveTheme(config({ name: "slab-light" }), true).id).toBe("slab-light");
  });

  it("falls back to slab for unknown names and ignores malformed colors", () => {
    const r = resolveTheme(config({ name: "neon", dark: "nope", colors: { bg: "blue", fg: "#12", sparkle: "#fff" } }), true);
    expect(r.id).toBe("slab-dark");
    expect(r.palette).toEqual(THEMES["slab-dark"].palette);
  });

  it("applies partial overrides over the base theme", () => {
    const r = resolveTheme(config({ name: "slab-dark", colors: { bg: "#101010", accent_soft: "#222222" } }), false);
    expect(r.palette).toEqual({ ...THEMES["slab-dark"].palette, bg: "#101010", accent_soft: "#222222" });
  });

  it("derives a soft tint from an accent override and ignores a retired preset name", () => {
    const light = resolveTheme(config({ colors: { accent: "#2f7df6" } }), false).palette;
    expect(light.accent_soft).toBe(mixHex("#2f7df6", "#efeee9", 0.14));
    expect(resolveTheme(config({ colors: { accent: "sakura" } }), true).palette).toEqual(THEMES["slab-dark"].palette);
  });
});

describe("token mapping", () => {
  it("maps every token to a kebab-case custom property", () => {
    expect(cssVars(THEMES["slab-light"].palette)).toMatchObject({ "--surface-hover": "#dcdad3", "--border-strong": "#b4b1a8", "--accent-soft": "#cbc8c0" });
    expect(Object.keys(cssVars(THEMES["slab-light"].palette))).toHaveLength(TOKENS.length);
  });

  it("applies the scheme and the variables to the root element", () => {
    const root = document.createElement("html");
    const theme = resolveTheme(config({ name: "slab-dark" }), false);
    applyTheme(root, theme);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--bg")).toBe("#0e0e0e");
    expect(xtermTheme(theme)).toMatchObject({ background: "#0e0e0e", foreground: THEMES["slab-dark"].palette.fg });
  });

  it("mixes hex colors like color-mix", () => {
    expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mixHex("#fff", "#000", 1)).toBe("#ffffff");
  });
});
