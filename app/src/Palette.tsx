import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { endpointLabel, endpointUrl, httpEndpoints } from "./activityModel";
import { activateTab, allActions, focusPane, openEndpoint, openWorktree, restartWorktreeAction, runAction, runWorktreeAction, stopWorktreeAction } from "./actions";
import { Dialog, DialogContent } from "./components/ui";
import { describeBinding } from "./keys";
import { menuEntries, rankEntries, remembered, type PaletteEntry } from "./paletteModel";
import { repoMenu, worktreeMenu } from "./menus";
import { chordFor, effectiveBindings } from "./shortcuts";
import { getState, repoName, runningActionIds, setState, setUi, useStore, visibleRepos, type State } from "./store";
import { KIND_LABEL, type Worktree } from "./types";

function actionEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  const running = runningActionIds(s, w.id);
  return (s.actions[w.id]?.actions ?? []).flatMap((a): PaletteEntry[] => {
    const key = `action:${w.id}:${a.id}`;
    const hint = [w.name, a.shortcut ? describeBinding(a.shortcut) : null].filter(Boolean).join(" · ");
    if (!running.includes(a.id)) return [{ key, label: `start ${a.label}`, hint, context, run: () => runWorktreeAction(w.id, a.id) }];
    return [
      { key: `${key}:logs`, label: `focus ${a.label} logs`, hint, context, run: () => runWorktreeAction(w.id, a.id) },
      { key: `${key}:restart`, label: `restart ${a.label}`, hint, context, run: () => restartWorktreeAction(w.id, a.id) },
      { key: `${key}:stop`, label: `stop ${a.label}`, hint, context, run: () => stopWorktreeAction(w.id, a.id) },
    ];
  });
}

function endpointEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  const actions = s.actions[w.id]?.actions ?? [];
  return httpEndpoints(s.endpoints[w.id] ?? []).map((e) => ({
    key: `endpoint:${w.id}:${e.port}`,
    label: `open ${endpointLabel(e, actions)} :${e.port}`,
    hint: `${w.name} · runtime`,
    context,
    run: () => openEndpoint(endpointUrl(e), w.id),
  }));
}

export function worktreeChildren(s: State, w: Worktree): PaletteEntry[] {
  const key = `wt:${w.id}`;
  const [open, ...rest] = menuEntries(worktreeMenu(w, s), key);
  const extras = w.exists && !w.archived_at_ms ? [...actionEntries(s, w, false), ...endpointEntries(s, w, false)] : [];
  return open ? [open, ...extras, ...rest] : [...extras, ...rest];
}

/** Every palette source: context items for the worktree on screen, then commands, agents, worktrees, and repos. */
export function paletteEntries(s: State): PaletteEntry[] {
  const current = s.ui.view === "worktree" ? (s.worktrees.find((w) => w.id === s.ui.activeWorktreeId) ?? null) : null;
  const bindings = effectiveBindings(s.config?.keybindings ?? {});
  const byWorktree = new Map(s.worktrees.map((w) => [w.id, w]));
  const tabs: PaletteEntry[] = current
    ? (s.tabs[current.id] ?? []).map((t) => ({ key: `tab:${t.id}`, label: `tab ${t.title}`, hint: t.is_active ? "current" : "tabs", context: true, run: () => activateTab(t.id) }))
    : [];
  const panes: PaletteEntry[] = current
    ? Object.values(s.panes)
        .filter((p) => p.worktree_id === current.id && !(p.agent && p.agent.state !== "exited"))
        .map((p) => ({ key: `pane:${p.id}`, label: `pane ${p.user_title ?? p.title}`, hint: s.tabs[current.id]?.find((t) => t.id === p.tab_id)?.title, context: true, run: () => void focusPane(p.id) }))
    : [];
  const agents: PaletteEntry[] = Object.values(s.agents).flatMap((a) => {
    const w = byWorktree.get(a.worktree_id);
    if (!w || a.state === "exited" || !s.panes[a.pane_id]) return [];
    const run = async () => {
      await openWorktree(w.id);
      await focusPane(a.pane_id);
    };
    return [{ key: `agent:${a.pane_id}`, label: `focus ${KIND_LABEL[a.kind]} · ${w.name}`, hint: a.state, context: w.id === current?.id, run: () => void run() }];
  });
  const contextual = current ? [...actionEntries(s, current, true), ...endpointEntries(s, current, true)] : [];
  const commands: PaletteEntry[] = allActions()
    .filter((a) => (!a.whenWorktree || !!current) && (!a.when || a.when()))
    .map((a) => ({ key: `cmd:${a.id}`, label: a.label, hint: a.group?.toLowerCase(), shortcut: chordFor(a.id, bindings), run: () => runAction(a.id) }));
  const worktrees: PaletteEntry[] = s.worktrees.map((w) => ({
    key: `wt:${w.id}`,
    label: w.name,
    hint: [repoName(s, w.repo_id), w.metadata.project, w.branch, w.archived_at_ms ? "archived" : null].filter(Boolean).join(" · "),
    context: w.id === current?.id,
    children: () => worktreeChildren(getState(), w),
  }));
  const repos: PaletteEntry[] = visibleRepos(s).map((r) => ({ key: `repo:${r.id}`, label: r.name, hint: `repo · ${r.path}`, children: () => menuEntries(repoMenu(r, getState()), `repo:${r.id}`) }));
  return [...tabs, ...panes, ...agents, ...contextual, ...commands, ...worktrees, ...repos];
}

interface Frame {
  entry: PaletteEntry;
  entries: PaletteEntry[];
}

/** Tomo's own ranking and list inside the shared Dialog shell. */
export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const state = useStore((s) => (s.paletteOpen ? s : null));
  const recent = useStore((s) => s.ui.paletteRecent);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [stack, setStack] = useState<Frame[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const root = useMemo(() => (state ? paletteEntries(state) : []), [state]);
  const top = stack[stack.length - 1];
  const results = useMemo(() => rankEntries(top ? top.entries : root, query, top ? [] : recent).slice(0, 60), [top, root, query, recent]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setStack([]);
  }, [open]);

  useEffect(() => setIndex(0), [query, stack.length]);

  const remember = (key: string) => setUi({ paletteRecent: remembered(getState().ui.paletteRecent, key) });
  const close = () => setState({ paletteOpen: false });
  const run = (entry: PaletteEntry) => {
    close();
    remember(entry.key);
    entry.run?.();
  };
  const choose = (entry: PaletteEntry | undefined, direct = false) => {
    if (!entry) return;
    if (!entry.children) return run(entry);
    const entries = entry.children();
    if (direct && entries[0]?.run) return run(entries[0]);
    if (!top) remember(entry.key);
    setStack((s) => [...s, { entry, entries }]);
    setQuery("");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
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
            placeholder={top ? `actions for ${top.entry.label}` : "worktree, tab, agent, or command"}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setIndex((i) => Math.min(results.length - 1, i + 1));
              else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
              else if (e.key === "Enter") choose(results[index], e.metaKey);
              else if (e.key === "Backspace" && query === "" && stack.length > 0) setStack((s) => s.slice(0, -1));
              else return;
              e.preventDefault();
            }}
          />
        </label>
        <div className="palette-list" role="listbox">
          {results.map((it, i) => (
            <div key={it.key} role="option" aria-selected={i === index} className={`palette-item${i === index ? " palette-active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(it)}>
              <span className="palette-label">{it.label}</span>
              <span className="palette-side">
                {it.hint && <span className="palette-hint">{it.hint}</span>}
                {it.shortcut && <kbd className="kbd">{it.shortcut}</kbd>}
                {it.children && <ChevronRight className="palette-chevron" aria-label="has actions" />}
              </span>
            </div>
          ))}
          {results.length === 0 && <div className="palette-item muted">no matches</div>}
        </div>
        <div className="palette-foot">
          <span>↑↓ move</span>
          <span>↩ {results[index]?.children ? "actions" : "run"}</span>
          {results[index]?.children && <span>⌘↩ open</span>}
          {stack.length > 0 && <span>⌫ back</span>}
          <span>esc close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function openPalette(): void {
  setUi({});
  setState({ paletteOpen: true });
}
