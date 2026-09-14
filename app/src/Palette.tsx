import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { allActions, activateTab, archiveWorktree, newTabIn, newTerminalIn, openWorktree, restoreWorktree, runAction, spawnAgent } from "./actions";
import { describeBinding } from "./keys";
import { repoName, setState, setUi, useStore, visibleRepos } from "./store";

interface Item {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
  rank: number;
}

const RECENT_KEY = "tomo.palette.recent";

function recentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recentIds().filter((k) => k !== key)].slice(0, 8)));
  } catch {}
}

function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 50;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    gaps += idx - ti;
    ti = idx + 1;
  }
  return Math.max(1, 30 - gaps);
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const worktrees = useStore((s) => s.worktrees);
  const repos = useStore(visibleRepos);
  const bindings = useStore((s) => s.config?.keybindings ?? {});
  const current = useStore((s) => s.worktrees.find((w) => w.id === s.ui.activeWorktreeId && s.ui.view === "worktree") ?? null);
  const tabs = useStore((s) => (current ? s.tabs[current.id] ?? [] : []));
  const selectionSize = useStore((s) => s.selection.size);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<Item[]>(() => {
    const recent = recentIds();
    const boost = (key: string) => (recent.includes(key) ? 20 - recent.indexOf(key) : 0);
    const repoOf = (w: (typeof worktrees)[number]) => repoName({ repos } as never, w.repo_id);
    const cmds: Item[] = allActions()
      .filter((a) => (!a.whenWorktree || !!current) && (!a.when || a.when()))
      .map((a) => ({
        key: `cmd:${a.id}`,
        label: a.label,
        hint: [a.whenWorktree && current ? current.name : null, bindings[a.id] ? describeBinding(bindings[a.id]) : null].filter(Boolean).join(" · ") || undefined,
        run: () => runAction(a.id),
        rank: (a.whenWorktree ? 10 : 0) + boost(`cmd:${a.id}`),
      }));
    const tabItems: Item[] = tabs.map((t) => ({ key: `tab:${t.id}`, label: `tab: ${t.title}`, hint: t.is_active ? "current" : undefined, run: () => activateTab(t.id), rank: 8 }));
    const ws: Item[] = worktrees.flatMap((w) => {
      const hint = [repoOf(w), w.metadata.project, w.branch].filter(Boolean).join(" · ");
      const archived = !!w.archived_at_ms;
      const base = boost(`wt:${w.id}`);
      return [
        archived
          ? { key: `wt:${w.id}`, label: `restore ${w.name}`, hint: `${hint} · archived`, run: () => restoreWorktree(w.id), rank: 4 + base }
          : { key: `wt:${w.id}`, label: `open ${w.name}`, hint, run: () => openWorktree(w.id), rank: 5 + base },
        ...(archived || !w.exists
          ? []
          : [
              { key: `wt-tab:${w.id}`, label: `new tab in ${w.name}`, hint, run: () => newTabIn(w.id), rank: 1 },
              { key: `wt-term:${w.id}`, label: `new terminal in ${w.name}`, hint, run: () => newTerminalIn(w.id), rank: 1 },
              { key: `wt-claude:${w.id}`, label: `start claude in ${w.name}`, hint, run: () => spawnAgent("claude", w.id), rank: 1 },
              { key: `wt-codex:${w.id}`, label: `start codex in ${w.name}`, hint, run: () => spawnAgent("codex", w.id), rank: 1 },
              { key: `wt-pi:${w.id}`, label: `start pi in ${w.name}`, hint, run: () => spawnAgent("pi", w.id), rank: 1 },
              ...(w.is_main ? [] : [{ key: `wt-archive:${w.id}`, label: `archive ${w.name}`, hint, run: () => archiveWorktree(w.id), rank: 0 }]),
            ]),
      ];
    });
    const rs: Item[] = repos.map((r) => ({ key: `repo:${r.id}`, label: `new worktree in ${r.name}`, hint: r.path, run: () => setState({ dialog: { kind: "create-worktree", repoId: r.id } }), rank: 2 + boost(`repo:${r.id}`) }));
    return [...tabItems, ...cmds, ...ws, ...rs];
  }, [worktrees, repos, bindings, current, tabs, selectionSize]);

  const results = useMemo(() => {
    return items
      .map((it) => ({ it, s: query ? Math.max(score(query, it.label), score(query, it.hint ?? "") * 0.6) : 1 }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || b.it.rank - a.it.rank || a.it.label.localeCompare(b.it.label))
      .slice(0, 50)
      .map((r) => r.it);
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;
  const close = () => setState({ paletteOpen: false });
  const choose = (it: Item | undefined) => {
    if (!it) return;
    close();
    remember(it.key);
    it.run();
  };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <label className="palette-input">
        <Search className="icon" />
        <input
          ref={inputRef}
          value={query}
          placeholder="worktree, tab, or command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setIndex((i) => Math.min(results.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") choose(results[index]);
            else return;
            e.preventDefault();
          }}
        />
        </label>
        <div className="palette-list">
          {results.map((it, i) => (
            <div key={it.key} className={`palette-item${i === index ? " palette-active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(it)}>
              <span className="palette-label">{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="palette-item muted">No matches</div>}
        </div>
        <div className="palette-foot"><span>↑↓ move</span><span>↩ run</span><span>esc close</span></div>
      </div>
    </div>
  );
}

export function openPalette(): void {
  setUi({});
  setState({ paletteOpen: true });
}
