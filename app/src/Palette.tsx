import { ChevronRight, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { activateTab, allActions, focusPane, openWorktree, runAction, wakePane } from "./actions";
import { rpcParsed } from "./api";
import { openFile } from "./editor/editor";
import { fsEntrySchema } from "./schemas";
import { builtins } from "./addons";
import { Dialog, DialogContent } from "./components/ui";
import { menuEntries, rankEntries, remembered, type PaletteEntry } from "./paletteModel";
import { repoMenu, worktreeMenu } from "./menus";
import { ago } from "./RightSidebar";
import { openHit, useSearch } from "./search";
import { CONTENT_MIN, GROUP_LIMIT, groupJump, groupsFor, highlight, parseQuery, prefixOf, PREFIXES, rowsOf, SCOPED_LIMIT, SOURCES, type Group, type LocalGroup, type Row, type Scope } from "./searchModel";
import { chordFor, effectiveBindings } from "./shortcuts";
import { failQuietly, getState, repoName, setState, setUi, useStore, visibleRepos, type State } from "./store";
import { KIND_LABEL, type FsEntry, type Worktree } from "./types";
import type { SearchHit } from "./generated";

export const FILES_KEY = "files";

/** The files of the worktree on screen, newest change first, while the palette shows the file list. */
function useWorktreeFiles(open: boolean, worktreeId: string | null): FsEntry[] {
  const [files, setFiles] = useState<FsEntry[]>([]);
  useEffect(() => {
    setFiles([]);
    if (!open || !worktreeId) return;
    let live = true;
    rpcParsed("fs_recent", z.array(fsEntrySchema), { worktree_id: worktreeId, limit: 20_000 })
      .then((f) => live && setFiles(f))
      .catch(failQuietly("fs_recent"));
    return () => {
      live = false;
    };
  }, [open, worktreeId]);
  return files;
}

export function fileEntries(worktreeId: string, files: FsEntry[]): PaletteEntry[] {
  return files.map((f) => ({ key: `file:${f.rel_path}`, label: f.rel_path, run: () => void openFile(worktreeId, f.rel_path) }));
}

function addonEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  return builtins.flatMap((a) => a.paletteEntries?.(s, w, context) ?? []);
}

export function worktreeChildren(s: State, w: Worktree): PaletteEntry[] {
  const key = `wt:${w.id}`;
  const [open, ...rest] = menuEntries(worktreeMenu(w, s), key);
  const extras = w.exists && !w.archived_at_ms ? addonEntries(s, w, false) : [];
  return open ? [open, ...extras, ...rest] : [...extras, ...rest];
}

const current = (s: State): Worktree | null => (s.ui.view === "worktree" ? (s.worktrees.find((w) => w.id === s.ui.activeWorktreeId) ?? null) : null);

/** Context items for the worktree on screen, live agents, addon context items, and every command. */
function commandEntries(s: State): PaletteEntry[] {
  const here = current(s);
  const bindings = effectiveBindings(s.config?.keybindings ?? {});
  const byWorktree = new Map(s.worktrees.map((w) => [w.id, w]));
  const tabs: PaletteEntry[] = here
    ? (s.tabs[here.id] ?? []).map((t) => ({ key: `tab:${t.id}`, label: `tab ${t.title}`, hint: t.is_active ? "current" : "tabs", context: true, run: () => activateTab(t.id) }))
    : [];
  const panes: PaletteEntry[] = here
    ? Object.values(s.panes)
        .filter((p) => p.worktree_id === here.id && !(p.agent && p.agent.state !== "exited"))
        .map((p) => ({ key: `pane:${p.id}`, label: `pane ${p.user_title ?? p.title}`, hint: s.tabs[here.id]?.find((t) => t.id === p.tab_id)?.title, context: true, run: () => void focusPane(p.id) }))
    : [];
  const agents: PaletteEntry[] = Object.values(s.agents).flatMap((a) => {
    const w = byWorktree.get(a.worktree_id);
    if (!w || a.state === "exited" || !s.panes[a.pane_id]) return [];
    const asleep = a.sleep === "asleep";
    const run = async () => {
      await openWorktree(w.id);
      await focusPane(a.pane_id);
      if (asleep) wakePane(a.pane_id);
    };
    const label = `${asleep ? "wake" : "focus"} ${KIND_LABEL[a.kind]} · ${w.name}`;
    return [{ key: `agent:${a.pane_id}`, label, hint: a.sleep ? "sleeping" : a.state, context: w.id === here?.id, run: () => void run() }];
  });
  const contextual = here ? addonEntries(s, here, true) : [];
  const commands: PaletteEntry[] = allActions()
    .filter((a) => (!a.whenWorktree || !!here) && (!a.when || a.when()))
    .map((a) => ({ key: `cmd:${a.id}`, label: a.label, hint: a.group?.toLowerCase(), shortcut: chordFor(a.id, bindings), run: () => runAction(a.id) }));
  return [...tabs, ...panes, ...agents, ...contextual, ...commands];
}

/** Worktrees, found by name, repo, branch, or tag, and repos. */
function placeEntries(s: State): PaletteEntry[] {
  const here = current(s);
  const worktrees: PaletteEntry[] = s.worktrees.map((w) => ({
    key: `wt:${w.id}`,
    label: w.name,
    hint: [repoName(s, w.repo_id), w.branch, ...w.metadata.tags.map((t) => `#${t}`), w.archived_at_ms ? "archived" : null].filter(Boolean).join(" · "),
    context: w.id === here?.id,
    children: () => worktreeChildren(getState(), w),
  }));
  const repos: PaletteEntry[] = visibleRepos(s).map((r) => ({ key: `repo:${r.id}`, label: r.name, hint: `repo · ${r.path}`, children: () => menuEntries(repoMenu(r, getState()), `repo:${r.id}`) }));
  return [...worktrees, ...repos];
}

/** One entry for each tag. Enter lists the worktrees that carry it. */
function tagEntries(s: State): PaletteEntry[] {
  const tags = [...new Set(s.worktrees.flatMap((w) => w.metadata.tags))].sort();
  return tags.map((tag) => {
    const tagged = placeEntries(s).filter((e) => s.worktrees.some((w) => `wt:${w.id}` === e.key && w.metadata.tags.includes(tag)));
    return { key: `tag:${tag}`, label: `#${tag}`, hint: `${tagged.length} ${tagged.length === 1 ? "worktree" : "worktrees"}`, children: () => tagged };
  });
}

/** Every palette source: context items for the worktree on screen, then commands, agents, worktrees, and repos. */
export function paletteEntries(s: State): PaletteEntry[] {
  return [...commandEntries(s), ...placeEntries(s)];
}

/** The groups that the store answers at once, for one scope. */
export function localGroups(s: State, scope: Scope): LocalGroup[] {
  const commands: LocalGroup = { id: "commands", label: "Commands", entries: commandEntries(s), scope: "commands" };
  if (scope === "commands") return [commands];
  if (scope === "tags") return [{ id: "tags", label: "Tags", entries: tagEntries(s) }];
  if (scope !== "all") return [];
  const addons = builtins.flatMap((a) => a.searchSources ?? []).map((g) => ({ id: g.id, label: g.label, entries: g.entries(s) }));
  return [commands, { id: "worktrees", label: "Worktrees", entries: placeEntries(s) }, ...addons];
}

function hitEntry(s: State, hit: SearchHit, text: string): PaletteEntry {
  const where = s.worktrees.find((w) => w.id === hit.worktree_id)?.name;
  return { key: hit.key, label: hit.label, snippet: hit.snippet ?? undefined, where, at: hit.at_ms ?? undefined, run: () => void openHit(hit, text) };
}

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>))}
    </>
  );
}

const moreLabel = (g: Group) => `+${g.more} more in ${PREFIXES.find((p) => p.scope === g.scope)?.label ?? g.label.toLowerCase()}`;

interface Frame {
  entry: PaletteEntry;
}

/** Tomo's own ranking and list inside the shared Dialog shell. A typed query searches everything, in groups. */
export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const state = useStore((s) => (s.paletteOpen ? s : null));
  const recent = useStore((s) => s.ui.paletteRecent);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [stack, setStack] = useState<Frame[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const worktreeId = state?.ui.view === "worktree" ? state.ui.activeWorktreeId : null;
  const top = stack[stack.length - 1];
  const files = useWorktreeFiles(!!open && top?.entry.key === FILES_KEY, worktreeId);
  const filesEntry: PaletteEntry | null = useMemo(
    () => (worktreeId ? { key: FILES_KEY, label: "open file", children: () => fileEntries(worktreeId, files) } : null),
    [worktreeId, files],
  );
  const { scope, text } = parseQuery(query);
  const searching = !top && (scope !== "all" || text !== "");
  const short = scope === "terminal" && text.length < CONTENT_MIN;
  const results = useSearch(!!open && !top, scope, searching && !short ? text : "", worktreeId, scope === "all" ? GROUP_LIMIT + 3 : SCOPED_LIMIT);
  const local = useMemo(() => (state && searching ? localGroups(state, scope) : []), [state, searching, scope]);
  const entries = useMemo(
    () => (top ? ((top.entry.key === FILES_KEY && filesEntry ? filesEntry : top.entry).children?.() ?? []) : state && !searching ? paletteEntries(state) : []),
    [top, state, searching, filesEntry],
  );
  const groups: Group[] = useMemo(
    () =>
      searching
        ? groupsFor(local, results, text, recent, scope === "all" ? GROUP_LIMIT : SCOPED_LIMIT, (hit) => hitEntry(getState(), hit, text))
        : [{ id: "list", label: "", entries: rankEntries(entries, query, top ? [] : recent).slice(0, 60), more: 0, pending: false }],
    [searching, local, results, text, recent, scope, entries, query, top],
  );
  const rows = useMemo(() => rowsOf(groups), [groups]);
  const index = Math.max(0, rows.findIndex((r) => r.key === selected));
  const active = rows[index];
  const waiting = searching && scope !== "all" && (short || text === "");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(null);
    setStack(open === "files" && filesEntry ? [{ entry: filesEntry }] : []);
  }, [open]);

  useEffect(() => setSelected(null), [query, stack.length]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-active")?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  const remember = (key: string) => setUi({ paletteRecent: remembered(getState().ui.paletteRecent, key) });
  const close = () => setState({ paletteOpen: false });
  const run = (entry: PaletteEntry, keep: boolean) => {
    close();
    if (keep) remember(entry.key);
    entry.run?.();
  };
  const choose = (row: Row | undefined, direct = false) => {
    if (!row) return;
    if (row.kind === "more") return setQuery(`${prefixOf(row.group.scope ?? "all")}${text}`);
    const entry = row.entry;
    const keep = !(SOURCES.all as readonly string[]).includes(row.group);
    if (!entry.children) return run(entry, keep);
    const first = direct ? entry.children()[0] : undefined;
    if (first?.run) return run(first, keep);
    if (!top) remember(entry.key);
    setStack((s) => [...s, { entry }]);
    setQuery("");
  };
  const move = (to: number) => setSelected(rows[Math.min(Math.max(0, to), rows.length - 1)]?.key ?? null);

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="palette" initialFocus={inputRef} aria-label="Command palette">
        <label className="palette-input">
          <Search className="icon" />
          {stack.map((f) => (
            <span key={f.entry.key} className="palette-crumb">
              {f.entry.label}
            </span>
          ))}
          <input
            ref={inputRef}
            value={query}
            aria-label="Search commands"
            placeholder={top?.entry.key === FILES_KEY ? "file name or path" : top ? `actions for ${top.entry.label}` : "search commands, worktrees, files, sessions, terminals"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") move(index + 1);
              else if (e.key === "ArrowUp") move(index - 1);
              else if (e.key === "Tab" && searching) move(groupJump(rows, index, e.shiftKey ? -1 : 1));
              else if (e.key === "Enter") choose(active, e.metaKey);
              else if (e.key === "Backspace" && query === "" && stack.length > 0) setStack((s) => s.slice(0, -1));
              else return;
              e.preventDefault();
            }}
          />
        </label>
        <div className="palette-list" role="listbox" ref={listRef}>
          {groups.map((g) => (
            <Fragment key={g.id}>
              {g.label && (
                <div className="palette-group" role="presentation">
                  <span>{g.label}</span>
                  <span className="palette-group-count">{g.pending ? "searching…" : g.more > 0 && !g.scope ? `+${g.more}` : ""}</span>
                </div>
              )}
              {g.entries.map((it) => {
                const on = active?.key === it.key;
                const side = [it.where, it.at ? ago(it.at) : null].filter(Boolean).join(" · ");
                return (
                  <div
                    key={it.key}
                    role="option"
                    aria-selected={on}
                    className={`palette-item${it.snippet ? " palette-hit" : ""}${on ? " palette-active" : ""}`}
                    onMouseEnter={() => setSelected(it.key)}
                    onClick={() => choose(rows.find((r) => r.key === it.key))}
                  >
                    <span className="palette-label">{searching ? <Marked text={it.label} query={text} /> : it.label}</span>
                    <span className="palette-side">
                      {(side || it.hint) && <span className="palette-hint">{side || it.hint}</span>}
                      {it.shortcut && <kbd className="kbd">{it.shortcut}</kbd>}
                      {it.children && <ChevronRight className="palette-chevron" aria-label="has actions" />}
                    </span>
                    {it.snippet && (
                      <span className="palette-snippet">
                        <Marked text={it.snippet} query={text} />
                      </span>
                    )}
                  </div>
                );
              })}
              {g.more > 0 && g.scope && (
                <div
                  role="option"
                  aria-selected={active?.key === `more:${g.id}`}
                  className={`palette-item palette-more${active?.key === `more:${g.id}` ? " palette-active" : ""}`}
                  onMouseEnter={() => setSelected(`more:${g.id}`)}
                  onClick={() => choose(rows.find((r) => r.key === `more:${g.id}`))}
                >
                  <span className="palette-label">{moreLabel(g)}</span>
                  <span className="palette-side">
                    <kbd className="kbd">{prefixOf(g.scope)}</kbd>
                  </span>
                </div>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && <div className="palette-item muted">{waiting ? (text ? `type ${CONTENT_MIN} or more characters` : `type to search ${PREFIXES.find((p) => p.scope === scope)?.label}`) : groups.some((g) => g.pending) ? "searching…" : "no matches"}</div>}
        </div>
        <div className="palette-foot">
          <span>↑↓ move</span>
          {searching && <span>⇥ group</span>}
          <span>↩ {active?.kind === "entry" && active.entry.children ? "actions" : "run"}</span>
          {active?.kind === "entry" && active.entry.children && <span>⌘↩ open</span>}
          {stack.length > 0 && <span>⌫ back</span>}
          {!top && !searching && (
            <span className="palette-prefixes" aria-label="Search prefixes">
              {PREFIXES.map((p) => (
                <span key={p.prefix}>
                  <b>{p.prefix}</b> {p.label}
                </span>
              ))}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function openPalette(start: true | "files" = true): void {
  setUi({});
  setState({ paletteOpen: start });
}
