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

  it("core client files do not name an Action type, call, or event", () => {
    const actionNoun = /\bAction(Def|Set|RunResult|Mode|Show|Activity)\b|["'`]action_(list|run|stop|restart)["'`]|actions_changed|WorktreeAction\b|runningAction|activeActionSet/;
    const offenders = Object.entries(sources)
      .filter(([path]) => !inAddons(path))
      .filter(([, text]) => actionNoun.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("an addon imports no other addon folder", () => {
    const insideAddons = (path: string) => (path.startsWith("./") ? path.slice(2) : path.startsWith("../addons/") ? path.slice("../addons/".length) : null);
    const folderOf = (rel: string) => /^([^/]+)\//.exec(rel)?.[1];
    const folders = new Set(Object.keys(sources).flatMap((path) => folderOf(insideAddons(path) ?? "") ?? []));
    const offenders = Object.entries(sources).flatMap(([path, text]) => {
      const rel = insideAddons(path);
      const own = rel && folderOf(rel);
      if (!rel || !own) return [];
      return [...text.matchAll(IMPORT)]
        .map((m) => m[1])
        .filter((spec) => spec.startsWith("."))
        .map((spec) => new URL(spec, `file:///src/addons/${rel}`).pathname)
        .filter((target) => {
          const other = /^\/src\/addons\/([^/]+)/.exec(target)?.[1];
          return other !== undefined && other !== own && folders.has(other);
        })
        .map((target) => `${path} imports ${target}`);
    });
    expect(offenders).toEqual([]);
  });

  it("core activity files do not name an addon activity kind", () => {
    const coreActivityFiles = ["../Activity.tsx", "../activityKinds.ts", "../activityModel.ts", "../glyphs.ts"];
    const addonKind = /action_(started|stopped|completed|crashed)|endpoint_discovered|annotations_sent|pr_merged|ActionActivity|RuntimeActivity|GitHubActivity|AgentationActivity/;
    expect(coreActivityFiles.filter((path) => sources[path] === undefined)).toEqual([]);
    expect(coreActivityFiles.filter((path) => addonKind.test(sources[path]!))).toEqual([]);
  });

  it("core client files do not name a runtime endpoint noun", () => {
    const runtimeNoun = /RuntimeEndpoint|RuntimeProtocol|RuntimeActivity|RuntimePreview|endpoints_changed|["'`]runtime_list["'`]|endpointsOf|endpointUrl|httpEndpoints|endpointLabel|\bendpoints\b/;
    const offenders = Object.entries(sources)
      .filter(([path]) => !inAddons(path))
      .flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (runtimeNoun.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])));
    expect(offenders).toEqual([]);
  });

  it("the Runtime and the Actions addon do not name each other", () => {
    const inFolder = (path: string, folder: string) => path.startsWith(`./${folder}/`) || path.includes(`/addons/${folder}/`);
    const actionNoun = /\bAction(Def|Set|RunResult|Mode|Show|Activity|Buttons|Warning)\b|["'`]action_(list|run|stop|restart)["'`]|actions_changed|runningAction|WorktreeAction\b|SOURCE_KIND/;
    const runtimeNoun = /RuntimeEndpoint|RuntimePreview|EndpointMark|endpointsOf|endpointUrl|httpEndpoints|endpointLabel|\bendpoints\b/;
    const offenders = Object.entries(sources).flatMap(([path, text]) => {
      const noun = inFolder(path, "runtime") ? actionNoun : inFolder(path, "actions") ? runtimeNoun : null;
      return noun ? text.split("\n").flatMap((line, i) => (noun.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])) : [];
    });
    expect(offenders).toEqual([]);
  });

  it("core client files do not name GitHub pull request nouns", () => {
    const githubNoun = /GitHub|PullRequest|PrStatusResult|review_decision|checks_failed|mergeable|pr_status|pr_changed|\bprs\b/;
    const offenders = Object.entries(sources)
      .filter(([path]) => !inAddons(path))
      .flatMap(([path, text]) => text.split("\n").flatMap((line, i) => (githubNoun.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])));
    expect(offenders).toEqual([]);
  });
});
