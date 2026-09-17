import { describe, expect, it } from "vitest";

const PURE_CLIENT_MODELS = [
  "./types.ts",
  "./appearance.ts",
  "./order.ts",
  "./activityModel.ts",
  "./homeQuery.ts",
  "./lenses.ts",
  "./layoutModel.ts",
  "./uiState.ts",
  "./shell/sidebarMode.ts",
];

const sources = import.meta.glob<string>(["./**/*.ts", "!./generated/**", "!./**/*.test.ts"], { query: "?raw", import: "default", eager: true });

const IMPORT = /(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g;
const withoutExtension = (path: string) => path.replace(/\.tsx?$/, "");
const allowed = new Set(PURE_CLIENT_MODELS.map((p) => withoutExtension(new URL(p, "file:///src/").pathname)));

const offence = (path: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return `${path} imports the package ${spec}`;
  const target = withoutExtension(new URL(spec, `file:///src/${path.slice(2)}`).pathname);
  return allowed.has(target) || target === "/src/generated" || target.startsWith("/src/generated/") ? null : `${path} imports ${spec}`;
};

describe("pure client models", () => {
  it("every listed module exists", () => {
    expect(PURE_CLIENT_MODELS.filter((path) => sources[path] === undefined)).toEqual([]);
  });

  it("import only other pure client models and generated wire types, never React, Tauri, or the store", () => {
    const offenders = PURE_CLIENT_MODELS.flatMap((path) => [...(sources[path] ?? "").matchAll(IMPORT)].flatMap((m) => offence(path, m[1]) ?? []));
    expect(offenders).toEqual([]);
  });
});
