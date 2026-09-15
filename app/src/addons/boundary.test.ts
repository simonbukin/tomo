import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../generated/**", "!../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

const IMPORT = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
const ADDON_FOLDER = /(?:^|\/)addons\/(?!(?:index|types|activity)(?:\.tsx?)?$)[^/]+/;
const inAddons = (path: string) => path.startsWith("./") || path.startsWith("../addons/");

describe("addon boundary", () => {
  it("core client files reach addons only through addons/index.ts and addons/types.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !inAddons(path))
      .flatMap(([path, text]) => [...text.matchAll(IMPORT)].map((m) => m[1]).filter((spec) => ADDON_FOLDER.test(spec)).map((spec) => `${path} imports ${spec}`));
    expect(offenders).toEqual([]);
  });

  it("core activity files do not name an addon activity kind", () => {
    const coreActivityFiles = ["../Activity.tsx", "../activityKinds.ts", "../activityModel.ts", "../glyphs.ts"];
    const addonKind = /action_(started|stopped|completed|crashed)|endpoint_discovered|annotations_sent|pr_merged|ActionActivity|RuntimeActivity|GitHubActivity|AgentationActivity/;
    expect(coreActivityFiles.filter((path) => sources[path] === undefined)).toEqual([]);
    expect(coreActivityFiles.filter((path) => addonKind.test(sources[path]!))).toEqual([]);
  });
});
