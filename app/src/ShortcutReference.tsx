import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { allActions } from "./actions";
import { builtins } from "./addons";
import { Dialog, DialogContent } from "./components/ui";
import { effectiveBindings, filterShortcuts, groupShortcuts, shortcutRows } from "./shortcuts";
import { keyBindings, setState, useStore } from "./store";

/** Searchable list of every bound command, grouped. Reads the same registry and bindings as the palette and menus. */
export function ShortcutReference() {
  const open = useStore((s) => s.shortcutsOpen);
  const bindings = useStore((s) => (s.shortcutsOpen ? keyBindings(s) : null));
  const bound = useStore((s) => (s.shortcutsOpen ? builtins.flatMap((a) => a.shortcuts?.(s) ?? []) : []));
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const rows = useMemo(() => (bindings ? shortcutRows([...allActions(), ...bound], effectiveBindings(bindings)) : []), [bindings, bound]);
  const groups = groupShortcuts(filterShortcuts(rows, query));
  const close = () => setState({ shortcutsOpen: false });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="palette shortcuts" initialFocus={inputRef} aria-label="Keyboard shortcuts">
        <label className="palette-input">
          <Search className="icon" />
          <input ref={inputRef} value={query} placeholder="search shortcuts" aria-label="Search shortcuts" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="palette-list">
          {groups.map((g) => (
            <section key={g.group} aria-label={g.group}>
              <div className="section-label shortcuts-group">{g.group.toLowerCase()}</div>
              {g.rows.map((r) => (
                <div key={r.id} className="palette-item">
                  <span className="palette-label">{r.label}</span>
                  <kbd className="kbd">{r.chord}</kbd>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <div className="palette-item muted">no matches</div>}
        </div>
        <div className="palette-foot">
          <span>change keys in [keybindings] in config.toml</span>
          <span>esc close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
