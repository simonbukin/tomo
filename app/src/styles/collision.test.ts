import { describe, expect, it } from "vitest";

/**
 * One class, one owner. A rule whose whole selector is a single class *defines* that
 * class, so two files defining the same one fight in the cascade: the later import wins
 * and silently restyles the other feature. That is how `.side-section` in sidebar.css
 * broke every section of the right inspector while every test stayed green.
 */
const sheets = import.meta.glob<string>(["../**/*.css"], { query: "?raw", import: "default", eager: true });

/** Classes that several features share on purpose. Each is still defined in exactly one file. */
const SHARED = new Set<string>([]);

const RULE = /(^|\})\s*([^{}@]+)\{/g;

function definitions(css: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(RULE)) {
    for (const selector of match[2].split(",")) {
      const one = selector.trim();
      if (/^\.[A-Za-z][\w-]*$/.test(one)) out.push(one.slice(1));
    }
  }
  return out;
}

describe("stylesheet ownership", () => {
  it("defines each class in one file only", () => {
    const owners = new Map<string, Set<string>>();
    for (const [path, css] of Object.entries(sheets)) {
      for (const name of definitions(css)) {
        if (SHARED.has(name)) continue;
        owners.set(name, (owners.get(name) ?? new Set()).add(path));
      }
    }
    const shared = [...owners.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([name, files]) => `.${name} defined in ${[...files].sort().join(" and ")}`);
    expect(shared).toEqual([]);
  });

  it("reads the stylesheets it claims to check", () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(10);
  });
});
