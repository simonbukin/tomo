import { defaultAppearance, sanitizeAppearance } from "./appearance";
import { LENSES } from "./lenses";
import type { CoreSection, Filter, FilterKind, HomeOptions, HomeScope, Id, SidebarMode, SidebarSort, UiState } from "./types";

export const defaultHome: HomeOptions = { query: "", scope: { kind: "all" }, filters: [], view: "list", sort: "state", group: "state", showArchived: false };

export const defaultUi: UiState = { view: "home", activeWorktreeId: null, leftMode: "open", rightMode: "open", leftWidth: 240, rightWidth: 280, rightSection: null, sidebarSort: "name", lens: "repo", showMain: false, showArchivedInSidebar: false, collapsedRepos: [], collapsedSections: [], hiddenRepos: [], showHiddenRepos: false, home: defaultHome, manualOrder: {}, repoOrder: [], appearance: defaultAppearance, paletteRecent: [] };

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

const MODES: readonly SidebarMode[] = ["open", "minimal", "closed"];
const CORE_SECTIONS: readonly CoreSection[] = ["worktree", "git", "processes", "sessions", "files"];
const CORE_VIEWS: readonly string[] = ["home", "worktree", "activity", "agents", "apps", "settings"];
const SORTS: readonly SidebarSort[] = ["name", "recent", "created", "attention", "state", "manual"];
const FILTER_KINDS: readonly FilterKind[] = ["state", "repo", "project", "tag", "agent", "archived", "attention"];

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const width = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(v))) : fallback);

const sidebarMode = (mode: unknown, legacyOpen: unknown): SidebarMode => (MODES.includes(mode as SidebarMode) ? (mode as SidebarMode) : legacyOpen === false ? "closed" : "open");

const stringLists = (v: unknown): Record<string, Id[]> =>
  Object.fromEntries(Object.entries(record(v)).filter(([, x]) => Array.isArray(x)).map(([k, x]) => [k, strings(x)]));

const filters = (v: unknown): Filter[] =>
  (Array.isArray(v) ? v : []).map(record).filter((f) => FILTER_KINDS.includes(f.kind as FilterKind) && typeof f.value === "string").map((f) => ({ kind: f.kind as FilterKind, value: f.value as string }));

const scope = (v: unknown): HomeScope => {
  const s = record(v);
  if (s.kind === "repo" && typeof s.repoId === "string") return { kind: "repo", repoId: s.repoId };
  if (s.kind === "project" && typeof s.project === "string") return { kind: "project", project: s.project };
  if (s.kind === "tag" && typeof s.tag === "string") return { kind: "tag", tag: s.tag };
  return { kind: "all" };
};

function sanitizeHome(v: unknown): HomeOptions {
  const h = record(v);
  return {
    ...defaultHome,
    query: typeof h.query === "string" ? h.query : "",
    scope: scope(h.scope),
    filters: filters(h.filters),
    view: oneOf(["list", "board"], h.view, defaultHome.view),
    sort: oneOf(["state", "recent", "created", "name"], h.sort, defaultHome.sort),
    group: oneOf(["state", "repo", "project", "none"], h.group, defaultHome.group),
    showArchived: bool(h.showArchived, defaultHome.showArchived),
  };
}

/**
 * UI state read back from the daemon with every known field checked. Unknown keys pass through untouched.
 * A missing active worktree keeps its id: a snapshot taken before discovery finishes must not erase it.
 */
export function sanitizeUi(saved: unknown, worktreeIds: readonly Id[], addonViewIds: readonly string[] = [], addonSectionIds: readonly string[] = []): UiState {
  const { leftOpen, rightOpen, ...s } = record(saved);
  const activeWorktreeId = typeof s.activeWorktreeId === "string" ? s.activeWorktreeId : null;
  const view = oneOf([...CORE_VIEWS, ...addonViewIds], s.view, defaultUi.view);
  return {
    ...defaultUi,
    ...(s as Partial<UiState>),
    view: view === "worktree" && !(activeWorktreeId && worktreeIds.includes(activeWorktreeId)) ? "home" : view,
    activeWorktreeId,
    leftMode: sidebarMode(s.leftMode, leftOpen),
    rightMode: sidebarMode(s.rightMode, rightOpen),
    leftWidth: width(s.leftWidth, defaultUi.leftWidth),
    rightWidth: width(s.rightWidth, defaultUi.rightWidth),
    rightSection: typeof s.rightSection === "string" && [...CORE_SECTIONS, ...addonSectionIds].includes(s.rightSection) ? s.rightSection : null,
    sidebarSort: oneOf(SORTS, s.sidebarSort, defaultUi.sidebarSort),
    lens: oneOf(LENSES, s.lens, defaultUi.lens),
    showMain: bool(s.showMain, defaultUi.showMain),
    showArchivedInSidebar: bool(s.showArchivedInSidebar, defaultUi.showArchivedInSidebar),
    collapsedRepos: strings(s.collapsedRepos),
    collapsedSections: strings(s.collapsedSections),
    hiddenRepos: strings(s.hiddenRepos),
    showHiddenRepos: bool(s.showHiddenRepos, defaultUi.showHiddenRepos),
    home: sanitizeHome(s.home),
    manualOrder: stringLists(s.manualOrder),
    repoOrder: strings(s.repoOrder),
    appearance: sanitizeAppearance(s.appearance),
    paletteRecent: strings(s.paletteRecent).slice(0, 12),
  };
}
