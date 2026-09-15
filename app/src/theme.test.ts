import { describe, expect, it } from "vitest";
import { applyTheme, cssVar, cssVars, mixHex, resolveTheme, THEMES, TOKENS, xtermTheme } from "./theme";

const config = (patch: Record<string, unknown> = {}) => ({ name: "system", light: "murasaki-light", dark: "murasaki-dark", colors: {}, ...patch }) as never;

describe("built-in themes", () => {
  it("define every token as a hex color", () => {
    Object.values(THEMES).forEach(({ palette }) => {
      expect(Object.keys(palette).sort()).toEqual([...TOKENS].sort());
      Object.values(palette).forEach((v) => expect(v).toMatch(/^#[0-9a-f]{6}$/));
    });
  });

  it("match the Murasaki first-paint values in tokens.css", async () => {
    const nodeFsWithoutNodeTypes = "node:fs";
    const { readFileSync } = await import(/* @vite-ignore */ nodeFsWithoutNodeTypes);
    const tokensCss: string = readFileSync("src/styles/tokens.css", "utf8");
    const block = (selector: string) => tokensCss.slice(tokensCss.indexOf(selector), tokensCss.indexOf("}", tokensCss.indexOf(selector)));
    const read = (css: string, token: string) => new RegExp(`${cssVar(token as never)}:\\s*(#[0-9a-f]+);`).exec(css)?.[1];
    TOKENS.forEach((t) => {
      expect(read(block(":root {"), t), t).toBe(THEMES["murasaki-light"].palette[t]);
      expect(read(block(':root[data-theme="dark"]'), t), t).toBe(THEMES["murasaki-dark"].palette[t]);
    });
  });
});

describe("resolveTheme", () => {
  it("follows the OS in system mode with the chosen light and dark themes", () => {
    expect(resolveTheme(null, false).id).toBe("murasaki-light");
    expect(resolveTheme(null, true).id).toBe("murasaki-dark");
    const c = config({ light: "paper", dark: "ink" });
    expect(resolveTheme(c, false)).toMatchObject({ id: "paper", scheme: "light" });
    expect(resolveTheme(c, true)).toMatchObject({ id: "ink", scheme: "dark" });
  });

  it("uses an explicit theme whatever the OS says", () => {
    expect(resolveTheme(config({ name: "paper" }), true).id).toBe("paper");
  });

  it("falls back to Murasaki for unknown names and ignores malformed colors", () => {
    const r = resolveTheme(config({ name: "neon", dark: "nope", colors: { bg: "blue", fg: "#12", sparkle: "#fff" } }), true);
    expect(r.id).toBe("murasaki-dark");
    expect(r.palette).toEqual(THEMES["murasaki-dark"].palette);
  });

  it("applies partial overrides over the base theme", () => {
    const r = resolveTheme(config({ name: "ink", colors: { bg: "#101010", accent_soft: "#222222" } }), false);
    expect(r.palette).toEqual({ ...THEMES.ink.palette, bg: "#101010", accent_soft: "#222222" });
  });

  it("resolves an accent preset per scheme and derives a soft tint", () => {
    const light = resolveTheme(config({ colors: { accent: "sora" } }), false).palette;
    const dark = resolveTheme(config({ colors: { accent: "sora" } }), true).palette;
    expect([light.accent, dark.accent]).toEqual(["#2f7df6", "#6aa8ff"]);
    expect(light.accent_soft).toBe(mixHex("#2f7df6", "#ffffff", 0.14));
    expect(resolveTheme(config({ colors: { accent: "murasaki" } }), false).palette.accent_soft).toBe("#ede7ff");
  });
});

describe("token mapping", () => {
  it("maps every token to a kebab-case custom property", () => {
    expect(cssVars(THEMES.paper.palette)).toMatchObject({ "--surface-hover": "#e6dfcf", "--border-strong": "#cbbfa9", "--accent-soft": "#e6dcf0" });
    expect(Object.keys(cssVars(THEMES.paper.palette))).toHaveLength(TOKENS.length);
  });

  it("applies the scheme and the variables to the root element", () => {
    const root = document.createElement("html");
    const theme = resolveTheme(config({ name: "ink" }), false);
    applyTheme(root, theme);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--bg")).toBe("#000000");
    expect(xtermTheme(theme)).toMatchObject({ background: "#000000", foreground: THEMES.ink.palette.fg });
  });

  it("mixes hex colors like color-mix", () => {
    expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mixHex("#fff", "#000", 1)).toBe("#ffffff");
  });
});
