import { describe, expect, it } from "vitest";

const modules = import.meta.glob<string>(["./*.ts", "!./index.ts", "!./schemas.ts"], { query: "?raw", import: "default", eager: true });
const schemas = import.meta.glob<string>("./schemas.ts", { query: "?raw", import: "default", eager: true })["./schemas.ts"];

const exported = new Set([...schemas.matchAll(/^export const (\w+)(?::[^=]+)? =/gm)].map((m) => m[1]));
const schemaName = (type: string) => `${type.charAt(0).toLowerCase()}${type.slice(1)}Schema`;

/** Every type name that a generated file declares. */
const declared = Object.values(modules).flatMap((text) => [...text.matchAll(/^export type (\w+)/gm)].map((m) => m[1]));

describe("generated schemas", () => {
  it("has a schema for every wire type, so a reply can be parsed at the boundary", () => {
    const missing = declared.filter((type) => !exported.has(schemaName(type)));
    expect(missing, "run `pnpm gen:schemas` after regenerating the types").toEqual([]);
  });

  it("finds the types it is generated from", () => {
    expect(declared.length).toBeGreaterThan(50);
  });
});
