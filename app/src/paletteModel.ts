import type { MenuItem } from "./components/ui";

export interface PaletteEntry {
  /** Stable id. The recency list stores it. */
  key: string;
  label: string;
  hint?: string;
  shortcut?: string;
  /** The entry belongs to the worktree on screen. */
  context?: boolean;
  run?: () => void;
  /** Present on an entry that opens a sub-list instead of running. */
  children?: () => PaletteEntry[];
}

export const MATCH = { none: -1, fuzzy: 0, substring: 1, prefix: 2, exact: 3 } as const;

const WORD_SPLIT = /[\s·:/_\-.>]+/;

function fuzzyGaps(query: string, text: string): number {
  let at = 0;
  let gaps = 0;
  for (const ch of query) {
    const idx = text.indexOf(ch, at);
    if (idx < 0) return -1;
    gaps += idx - at;
    at = idx + 1;
  }
  return gaps;
}

export function matchText(query: string, text: string): { tier: number; gaps: number } {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { tier: MATCH.exact, gaps: 0 };
  if (t === q) return { tier: MATCH.exact, gaps: 0 };
  if (t.startsWith(q) || t.split(WORD_SPLIT).some((w) => w.startsWith(q))) return { tier: MATCH.prefix, gaps: 0 };
  if (t.includes(q)) return { tier: MATCH.substring, gaps: 0 };
  const gaps = fuzzyGaps(q.replace(/\s+/g, ""), t);
  return gaps < 0 ? { tier: MATCH.none, gaps: 0 } : { tier: MATCH.fuzzy, gaps };
}

function matchEntry(query: string, entry: PaletteEntry): { tier: number; gaps: number } {
  const label = matchText(query, entry.label);
  if (label.tier > MATCH.fuzzy || !entry.hint) return label;
  const hint = matchText(query, entry.hint);
  if (hint.tier === MATCH.none) return label;
  const capped = { tier: MATCH.fuzzy, gaps: hint.tier === MATCH.fuzzy ? hint.gaps : 0 };
  return label.tier === MATCH.none || capped.gaps < label.gaps ? capped : label;
}

interface Ranked {
  entry: PaletteEntry;
  order: number;
  recent: number;
  tier: number;
  gaps: number;
}

const byContext = (a: Ranked, b: Ranked) => Number(!!b.entry.context) - Number(!!a.entry.context);
const byMatch = (a: Ranked, b: Ranked) => b.tier - a.tier || a.gaps - b.gaps;
const byRecency = (a: Ranked, b: Ranked) => a.recent - b.recent;
const bySource = (a: Ranked, b: Ranked) => a.order - b.order;

/** With a query, the match leads and recency breaks ties. With none, there is nothing to match. */
const order = (typed: boolean): ((a: Ranked, b: Ranked) => number)[] =>
  typed ? [byContext, byMatch, byRecency, bySource] : [byContext, byRecency, bySource];

export function rankEntries(entries: PaletteEntry[], query: string, recent: string[]): PaletteEntry[] {
  const recency = (key: string) => {
    const idx = recent.indexOf(key);
    return idx < 0 ? recent.length : idx;
  };
  const rules = order(query.trim().length > 0);
  return entries
    .map((entry, at) => ({ entry, order: at, recent: recency(entry.key), ...matchEntry(query, entry) }))
    .filter((r) => r.tier > MATCH.none)
    .sort((a, b) => rules.reduce((decided, rule) => decided || rule(a, b), 0))
    .map((r) => r.entry);
}

/** Turns a context menu into palette entries, so nested palette lists reuse the menu builders. */
export function menuEntries(items: MenuItem[], prefix: string): PaletteEntry[] {
  return items.flatMap((it): PaletteEntry[] => {
    if ("separator" in it || it.disabled) return [];
    const key = `${prefix}/${it.label}`;
    const hint = it.checked ? "current" : undefined;
    if (it.submenu) {
      const sub = it.submenu;
      return [{ key, label: it.label, hint, children: () => menuEntries(sub, key) }];
    }
    return it.run ? [{ key, label: it.label, hint, shortcut: it.shortcut, run: it.run }] : [];
  });
}

export function remembered(recent: string[], key: string, limit = 12): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, limit);
}
