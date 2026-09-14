import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { setState, useStore } from "./store";

export type MenuItem =
  | { separator: true }
  | { label: string; icon?: React.ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; checked?: boolean; run?: () => void; submenu?: MenuItem[] };

type Entry = Exclude<MenuItem, { separator: true }>;

export function openMenu(e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  setState({ menu: { x: e.clientX, y: e.clientY, items } });
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect();
  setState({ menu: { x: r.left, y: r.bottom + 4, items } });
}

export function closeMenu(): void {
  setState({ menu: null });
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  if (!menu) return null;
  return <MenuPanel key={`${menu.x}-${menu.y}`} x={menu.x} y={menu.y} items={menu.items} depth={0} autoFocus />;
}

function MenuPanel({ x, y, items, depth, autoFocus }: { x: number; y: number; items: MenuItem[]; depth: number; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [index, setIndex] = useState(-1);
  const [open, setOpen] = useState<number | null>(null);
  const entries = items.map((it, i) => ({ it, i })).filter((e): e is { it: Entry; i: number } => !("separator" in e.it));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 8 ? Math.max(8, (depth ? x - r.width * 2 - 4 : window.innerWidth - r.width - 8)) : x;
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y;
    setPos({ x: nx, y: ny });
    if (autoFocus) el.focus();
  }, [x, y, depth, autoFocus]);

  const activate = (i: number) => {
    const it = items[i];
    if (!it || "separator" in it || it.disabled) return;
    if (it.submenu) {
      setOpen(i);
      setIndex(i);
      return;
    }
    closeMenu();
    it.run?.();
  };
  const move = (delta: number) => {
    if (!entries.length) return;
    const at = entries.findIndex((e) => e.i === index);
    const next = entries[(at + delta + entries.length) % entries.length];
    setIndex(next.i);
    setOpen(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" || e.key === "ArrowRight") {
      if (index >= 0) activate(index);
      if (e.key === "ArrowRight" && index >= 0) {
        const sub = ref.current?.querySelector<HTMLElement>(".menu-panel");
        sub?.focus();
      }
    } else if (e.key === "ArrowLeft" && depth > 0) {
      (ref.current?.parentElement?.closest(".menu-panel") as HTMLElement | null)?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={ref} className="menu-panel rise" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
      {items.map((it, i) =>
        "separator" in it ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className={`menu-item${i === index ? " menu-active" : ""}${it.danger ? " menu-danger" : ""}${it.disabled ? " menu-disabled" : ""}`}
            onMouseEnter={() => {
              setIndex(i);
              setOpen(it.submenu ? i : null);
            }}
            onClick={() => activate(i)}
          >
            <span className="menu-check">{it.checked ? <Check className="icon" /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
            {it.submenu && <ChevronRight className="icon menu-chevron" />}
            {it.submenu && open === i && <SubMenu parent={ref} items={it.submenu} depth={depth + 1} />}
          </div>
        ),
      )}
    </div>
  );
}

function SubMenu({ parent, items, depth }: { parent: React.RefObject<HTMLDivElement | null>; items: MenuItem[]; depth: number }) {
  const r = parent.current?.getBoundingClientRect();
  const row = parent.current?.querySelector<HTMLElement>(".menu-active")?.getBoundingClientRect();
  if (!r) return null;
  const x = r.right + 2 + 200 > window.innerWidth ? r.left - 202 : r.right + 2;
  return createPortal(<MenuPanel x={x} y={(row?.top ?? r.top) - 4} items={items} depth={depth} />, document.body);
}
