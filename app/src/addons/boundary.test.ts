import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../generated/**", "!../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

const IMPORT = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
const ADDON_FOLDER = /(?:^|\/)addons\/(?!(?:index|types)(?:\.tsx?)?$)[^/]+/;
const inAddons = (path: string) => path.startsWith("./") || path.startsWith("../addons/");

describe("addon boundary", () => {
  it("core client files reach addons only through addons/index.ts and addons/types.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !inAddons(path))
      .flatMap(([path, text]) => [...text.matchAll(IMPORT)].map((m) => m[1]).filter((spec) => ADDON_FOLDER.test(spec)).map((spec) => `${path} imports ${spec}`));
    expect(offenders).toEqual([]);
  });
});
