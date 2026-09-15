import { describe, expect, it } from "vitest";
import { findLinks, resolvePath } from "./links";

const texts = (line: string) => findLinks(line).map((l) => line.slice(l.start, l.end));

describe("findLinks", () => {
  it("finds URLs and drops trailing punctuation", () => {
    expect(findLinks("ready on http://localhost:3000.")).toEqual([{ kind: "url", start: 9, end: 30, url: "http://localhost:3000" }]);
    expect(texts("see (https://example.com/a?b=1) now")).toEqual(["https://example.com/a?b=1"]);
  });

  it("finds path:line and path:line:col", () => {
    expect(findLinks("src/components/Foo.tsx:182")).toEqual([{ kind: "file", start: 0, end: 26, path: "src/components/Foo.tsx", line: 182, col: null }]);
    expect(findLinks("  --> /Users/me/foo.rs:44:3")[0]).toMatchObject({ path: "/Users/me/foo.rs", line: 44, col: 3 });
    expect(texts("at run (./lib/a.ts:1:9)")).toEqual(["./lib/a.ts:1:9"]);
    expect(texts("~/notes/todo.md:2, and README.md:10.")).toEqual(["~/notes/todo.md:2", "README.md:10"]);
  });

  it("ignores times, host ports, versions, and the port inside a URL", () => {
    expect(findLinks("12:30:45 localhost:3000 v1.2.3:4 line:0")).toEqual([]);
    expect(texts("http://example.com:8080/x.js:3")).toEqual(["http://example.com:8080/x.js:3"]);
    expect(findLinks("foo.ts:12abc")).toEqual([]);
  });
});

describe("resolvePath", () => {
  it("resolves relative paths against the pane cwd", () => {
    expect(resolvePath("src/a.ts", "/w/app", null)).toBe("/w/app/src/a.ts");
    expect(resolvePath("./src/../b.ts", "/w/app/", null)).toBe("/w/app/b.ts");
    expect(resolvePath("../../../../x", "/w/app", null)).toBe("/x");
  });

  it("keeps absolute paths and expands ~ only with a home", () => {
    expect(resolvePath("/etc//hosts", "/w", null)).toBe("/etc/hosts");
    expect(resolvePath("~/n.md", "/w", "/Users/me")).toBe("/Users/me/n.md");
    expect(resolvePath("~/n.md", "/w", null)).toBeNull();
  });
});
