import type { Id } from "./types";

/** Who started a row, so its owner can restart or stop it. Core never reads `kind`; it only passes it back. */
export interface AppSource {
  kind: string;
  id: string;
}

/**
 * One running application, as Core understands it.
 *
 * Core owns the Apps view, its order, and the way to open a row. It does not
 * find a running app by itself, because a port belongs to the addon that
 * watches for one. An addon fills these rows in.
 */
export interface AppRow {
  /** Unique across every contributor. */
  id: string;
  worktreeId: Id;
  /** The pane that runs it, when a pane does. */
  paneId: Id | null;
  label: string;
  /** The address to open, when the app serves one. */
  url: string | null;
  port: number | null;
  /** One short extra fact, such as the process name. */
  detail: string | null;
  source: AppSource | null;
}

export function sortApps(rows: readonly AppRow[]): AppRow[] {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label) || (a.port ?? 0) - (b.port ?? 0) || a.id.localeCompare(b.id));
}

/** Join the rows of every contributor. The first row of an id wins, so two addons cannot show the same app twice. */
export function mergeApps(lists: readonly (readonly AppRow[])[]): AppRow[] {
  const seen = new Map<string, AppRow>();
  for (const list of lists) for (const row of list) if (!seen.has(row.id)) seen.set(row.id, row);
  return sortApps([...seen.values()]);
}

/** What the address column shows: the port when there is one, else the address, else nothing. */
export function addressLabel(row: AppRow): string {
  if (row.port !== null) return `:${row.port}`;
  return row.url ?? "—";
}

export function appsOfWorktree(rows: readonly AppRow[], worktreeId: Id): AppRow[] {
  return rows.filter((r) => r.worktreeId === worktreeId);
}
