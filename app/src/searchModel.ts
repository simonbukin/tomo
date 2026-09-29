import { MATCH, matchText, rankEntries, type PaletteEntry } from "./paletteModel";
import type { SearchHit, SearchSource } from "./generated";

export type Scope = "all" | "commands" | "files" | "tags" | "sessions" | "terminal";

/** The first character of the query narrows the search to one scope. The palette footer shows this table. */
export const PREFIXES: readonly { prefix: string; scope: Exclude<Scope, "all">; label: string }[] = [
  { prefix: ">", scope: "commands", label: "commands" },
  { prefix: "/", scope: "files", label: "files" },
  { prefix: "#", scope: "tags", label: "tags" },
  { prefix: "@", scope: "sessions", label: "sessions" },
  { prefix: "$", scope: "terminal", label: "terminal" },
];

/** The daemon sources of each scope. Commands, worktrees, tags, and addon items are in the store already. */
export const SOURCES: Record<Scope, readonly SearchSource[]> = {
  all: ["file", "session", "terminal", "activity"],
  commands: [],
  files: ["file"],
  tags: [],
  sessions: ["session"],
  terminal: ["terminal"],
};

const SOURCE_LABEL: Record<SearchSource, string> = { file: "Files", session: "Sessions", terminal: "Terminal", activity: "Activity" };
const SOURCE_SCOPE: Partial<Record<SearchSource, Scope>> = { file: "files", session: "sessions", terminal: "terminal" };

export const DEBOUNCE_MS = 60;
/** Terminal and session text need this many characters, as in the daemon. */
export const CONTENT_MIN = 3;
export const GROUP_LIMIT = 5;
export const SCOPED_LIMIT = 50;

export function parseQuery(input: string): { scope: Scope; text: string } {
  const found = PREFIXES.find((p) => input.startsWith(p.prefix));
  return found ? { scope: found.scope, text: input.slice(found.prefix.length).trim() } : { scope: "all", text: input.trim() };
}

export const prefixOf = (scope: Scope): string => PREFIXES.find((p) => p.scope === scope)?.prefix ?? "";

export interface SourceResult {
  hits: SearchHit[];
  total: number;
  done: boolean;
}

export type Results = Partial<Record<SearchSource, SourceResult>>;

/** Keeps the hits of the sources that the next query searches, marked as not done, so the list does not jump while it waits. */
export const pendingFor = (results: Results, sources: readonly SearchSource[]): Results =>
  Object.fromEntries(sources.flatMap((s) => (results[s] ? [[s, { ...results[s], done: false }]] : [])));

export interface LocalGroup {
  id: string;
  label: string;
  entries: PaletteEntry[];
  /** Enter on the "more" row narrows the query to this scope. */
  scope?: Scope;
}

export interface Group {
  id: string;
  label: string;
  entries: PaletteEntry[];
  /** Matches past the ones shown. */
  more: number;
  scope?: Scope;
  pending: boolean;
}

const bestTier = (entries: PaletteEntry[], text: string): number => Math.max(MATCH.none, ...entries.map((e) => matchText(text, e.label).tier));

/**
 * The groups of a typed query: local groups first, the best match first, then the daemon sources in a fixed
 * order. The daemon groups come last so that a late answer never moves the rows above it.
 */
export function groupsFor(local: LocalGroup[], results: Results, text: string, recent: string[], limit: number, toEntry: (hit: SearchHit) => PaletteEntry): Group[] {
  const ranked = local
    .map((g, order) => {
      const all = rankEntries(g.entries, text, recent);
      return { group: { id: g.id, label: g.label, entries: all.slice(0, limit), more: Math.max(0, all.length - limit), scope: g.scope, pending: false }, tier: bestTier(all, text), order };
    })
    .filter((g) => g.group.entries.length > 0)
    .sort((a, b) => b.tier - a.tier || a.order - b.order)
    .map((g) => g.group);
  const remote = SOURCES.all.flatMap((source): Group[] => {
    const r = results[source];
    if (!r || (r.done && r.hits.length === 0)) return [];
    const entries = r.hits.map(toEntry);
    return [{ id: source, label: SOURCE_LABEL[source], entries, more: Math.max(0, r.total - entries.length), scope: SOURCE_SCOPE[source], pending: !r.done }];
  });
  return [...ranked, ...remote];
}

export type Row = { kind: "entry"; key: string; entry: PaletteEntry; group: string } | { kind: "more"; key: string; group: Group };

/** The rows that the arrow keys walk, in screen order. A "more" row exists only for a group that a prefix can narrow to. */
export const rowsOf = (groups: Group[]): Row[] =>
  groups.flatMap((g): Row[] => [
    ...g.entries.map((entry): Row => ({ kind: "entry", key: entry.key, entry, group: g.id })),
    ...(g.more > 0 && g.scope ? [{ kind: "more", key: `more:${g.id}`, group: g } as Row] : []),
  ]);

const groupOf = (row: Row): string => (row.kind === "entry" ? row.group : row.group.id);

/** The first row of the next group (`dir` 1) or of this or the previous group (`dir` -1), as Tab and Shift+Tab move. */
export function groupJump(rows: Row[], at: number, dir: 1 | -1): number {
  if (rows.length === 0) return 0;
  const starts = rows.flatMap((r, i) => (i === 0 || groupOf(rows[i - 1]) !== groupOf(r) ? [i] : []));
  const current = starts.filter((s) => s <= at).pop() ?? 0;
  if (dir === 1) return starts.find((s) => s > at) ?? starts[0];
  const before = starts.filter((s) => s < current);
  return at > current ? current : (before.pop() ?? starts[starts.length - 1]);
}

/** Splits `text` into plain and matched parts: the substring match, or the characters of a fuzzy match. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();
  if (!q) return [{ text, hit: false }];
  const at = lower.indexOf(q);
  const marks = new Set<number>();
  if (at >= 0 && lower.length === text.length) {
    for (let i = at; i < at + q.length; i++) marks.add(i);
  } else {
    let from = 0;
    for (const ch of q.replace(/\s+/g, "")) {
      const i = lower.indexOf(ch, from);
      if (i < 0) return [{ text, hit: false }];
      marks.add(i);
      from = i + 1;
    }
  }
  return [...text].reduce<{ text: string; hit: boolean }[]>((parts, ch, i) => {
    const hit = marks.has(i);
    const last = parts[parts.length - 1];
    return last && last.hit === hit ? [...parts.slice(0, -1), { text: last.text + ch, hit }] : [...parts, { text: ch, hit }];
  }, []);
}
