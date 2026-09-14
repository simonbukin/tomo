import { useEffect, useMemo, useRef, useState } from "react";
import { actions, currentWorktree, openWorktree, runAction } from "./actions";
import { describeBinding } from "./keys";
import { repoName, setState, setUi, useStore } from "./store";

interface Item {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
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
  const repos = useStore((s) => s.repos);
  const bindings = useStore((s) => s.config?.keybindings ?? {});
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasWorktree = !!currentWorktree();

  const items = useMemo<Item[]>(() => {
    const ws: Item[] = worktrees.map((w) => ({
      key: `wt:${w.id}`,
      label: `Open worktree: ${w.name}`,
      hint: [repoName({ repos } as never, w.repo_id), w.metadata.project, w.branch].filter(Boolean).join(" · "),
      run: () => openWorktree(w.id),
    }));
    const cmds: Item[] = actions
      .filter((a) => !a.whenWorktree || hasWorktree)
      .map((a) => ({ key: `cmd:${a.id}`, label: a.label, hint: bindings[a.id] ? describeBinding(bindings[a.id]) : undefined, run: () => runAction(a.id) }));
    const rs: Item[] = repos.map((r) => ({ key: `repo:${r.id}`, label: `New worktree in ${r.name}…`, hint: r.path, run: () => setState({ dialog: { kind: "create-worktree", repoId: r.id } }) }));
    return [...ws, ...cmds, ...rs];
  }, [worktrees, repos, bindings, hasWorktree]);

  const results = useMemo(() => {
    return items
      .map((it) => ({ it, s: score(query, it.label) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
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
    it.run();
  };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a worktree name or a command"
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
        <div className="palette-list">
          {results.map((it, i) => (
            <div key={it.key} className={`palette-item${i === index ? " palette-active" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(it)}>
              <span>{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="palette-item muted">No matches</div>}
        </div>
        <div className="palette-foot muted">↑↓ navigate · ↩ run · ⎋ close · Home: {describeBinding(bindings.home ?? "")}</div>
      </div>
    </div>
  );
}

export function openPalette(): void {
  setUi({});
  setState({ paletteOpen: true });
}
