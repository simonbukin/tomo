import { useEffect, useRef } from "react";
import { AnchoredMenu, type MenuAnchor, type MenuItem } from "./components/ui";
import { setState, useStore } from "./store";

let nonce = 0;

/** Opens a context menu at the pointer. Items are built by the caller at open time. */
export function openMenu(e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  setState({ menu: { anchor: { x: e.clientX, y: e.clientY }, items, nonce: ++nonce } });
}

/** Opens a menu below an element, like a dropdown without its own trigger. */
export function openMenuAt(el: Element, items: MenuItem[]): void {
  setState({ menu: { anchor: el, items, nonce: ++nonce } });
}

export function closeMenu(): void {
  setState({ menu: null });
}

/**
 * Renders the one code-opened menu. Base UI owns positioning, keyboard, and dismissal.
 * Focus goes back to whatever was focused before the menu opened, including a terminal.
 */
export function MenuHost() {
  const menu = useStore((s) => s.menu);
  const last = useRef<{ anchor: MenuAnchor; items: MenuItem[]; nonce: number } | null>(null);
  const before = useRef<Element | null>(null);
  if (menu && menu !== last.current) {
    if (!last.current || last.current.nonce !== menu.nonce) before.current = document.activeElement;
    last.current = menu;
  }
  useEffect(() => {
    if (!menu) return;
    const onBlur = () => closeMenu();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [menu]);
  const shown = menu ?? last.current;
  if (!shown) return null;
  const restore = () => {
    const el = before.current;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  };
  return <AnchoredMenu key={shown.nonce} open={!!menu} anchor={shown.anchor} items={shown.items} onOpenChange={(open) => !open && closeMenu()} onOpenChangeComplete={(open) => !open && restore()} />;
}
