import type { Terminal } from "@xterm/xterm";
import type { Id } from "./types";

export interface Registered {
  term: Terminal;
  el: HTMLElement;
}

const registry = new Map<Id, Registered>();

export function registerTerminal(paneId: Id, entry: Registered): () => void {
  registry.set(paneId, entry);
  return () => {
    if (registry.get(paneId) === entry) registry.delete(paneId);
  };
}

export function getTerminal(paneId: Id): Registered | undefined {
  return registry.get(paneId);
}

export function focusTerminal(paneId: Id): boolean {
  const entry = registry.get(paneId);
  if (!entry) return false;
  entry.term.focus();
  return true;
}

export function paneRects(ids: Id[]): { id: Id; rect: DOMRect }[] {
  return ids.flatMap((id) => {
    const entry = registry.get(id);
    return entry ? [{ id, rect: entry.el.getBoundingClientRect() }] : [];
  });
}

export function neighbor(fromId: Id, ids: Id[], dir: "left" | "right" | "up" | "down"): Id | null {
  const rects = paneRects(ids);
  const from = rects.find((r) => r.id === fromId);
  if (!from) return null;
  const cx = from.rect.left + from.rect.width / 2;
  const cy = from.rect.top + from.rect.height / 2;
  const candidates = rects
    .filter((r) => r.id !== fromId)
    .map((r) => {
      const x = r.rect.left + r.rect.width / 2;
      const y = r.rect.top + r.rect.height / 2;
      const dx = x - cx;
      const dy = y - cy;
      const ahead = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
      const lateral = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
      return { id: r.id, ahead, lateral };
    })
    .filter((c) => c.ahead > 1)
    .sort((a, b) => a.ahead + a.lateral * 0.5 - (b.ahead + b.lateral * 0.5));
  return candidates[0]?.id ?? null;
}
