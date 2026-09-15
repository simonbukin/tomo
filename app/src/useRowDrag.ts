import type { DropPlace } from "./order";
import type { Id } from "./types";

const THRESHOLD_PX = 4;

export interface RowDragOptions {
  id: Id;
  /** Rows that share this group accept the drop; they carry `data-drag-group` and `data-drag-id`. */
  group: string;
  onDrop: (targetId: Id, place: DropPlace) => void;
}

function targetAt(group: string, y: number, self: Id): { el: HTMLElement; id: Id; place: DropPlace } | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-drag-group="${CSS.escape(group)}"]`)).filter((el) => el.dataset.dragId !== self);
  const hit = rows.find((el) => {
    const r = el.getBoundingClientRect();
    return y >= r.top && y <= r.bottom;
  });
  const el = hit ?? rows.reduce<HTMLElement | null>((best, cur) => {
    const d = (e: HTMLElement) => Math.abs(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2 - y);
    return !best || d(cur) < d(best) ? cur : best;
  }, null);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { el, id: el.dataset.dragId!, place: y < r.top + r.height / 2 ? "before" : "after" };
}

/**
 * Pointer-driven reordering. HTML5 drag and drop is unreliable inside the Tauri webview,
 * so this follows the mouse directly and marks the drop target with a class.
 */
export function startRowDrag(e: React.MouseEvent<HTMLElement>, opts: RowDragOptions): void {
  if (e.button !== 0 || e.metaKey || e.shiftKey || (e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
  const source = e.currentTarget;
  const startY = e.clientY;
  let dragging = false;
  let current: { el: HTMLElement; id: Id; place: DropPlace } | null = null;
  const clearMark = () => current?.el.classList.remove("drop-before", "drop-after");
  const move = (ev: MouseEvent) => {
    if (!dragging && Math.abs(ev.clientY - startY) < THRESHOLD_PX) return;
    if (!dragging) {
      dragging = true;
      source.classList.add("is-dragging");
      document.body.classList.add("row-dragging");
    }
    const next = targetAt(opts.group, ev.clientY, opts.id);
    if (next?.el !== current?.el || next?.place !== current?.place) {
      clearMark();
      current = next;
      current?.el.classList.add(current.place === "before" ? "drop-before" : "drop-after");
    }
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (!dragging) return;
    clearMark();
    source.classList.remove("is-dragging");
    document.body.classList.remove("row-dragging");
    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
    if (current) opts.onDrop(current.id, current.place);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
