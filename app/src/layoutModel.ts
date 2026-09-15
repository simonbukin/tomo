import type { DropPlace } from "./generated";
import type { Id, LayoutNode, Tab } from "./types";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The part of a pane under the pointer: the outer `edge` fraction on each side is that side, the rest is the center. */
export function dropRegion(box: Box, x: number, y: number, edge = 0.25): DropPlace {
  const fx = box.width > 0 ? (x - box.left) / box.width : 0.5;
  const fy = box.height > 0 ? (y - box.top) / box.height : 0.5;
  const dx = Math.min(fx, 1 - fx);
  const dy = Math.min(fy, 1 - fy);
  if (dx >= edge && dy >= edge) return "center";
  if (dx < dy) return fx < 0.5 ? "left" : "right";
  return fy < 0.5 ? "top" : "bottom";
}

/** Moves `id` to `position` (clamped), like the daemon's `tab_move`. Unknown ids leave the list unchanged. */
export function reorder(ids: Id[], id: Id, position: number): Id[] {
  if (!ids.includes(id)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(position, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

export function reorderTabs(tabs: Tab[], tabId: Id, position: number): Tab[] {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return reorder(tabs.map((t) => t.id), tabId, position).map((id, i) => ({ ...byId.get(id)!, position: i }));
}

/** The side of the hovered tab where the dragged tab lands. */
export function insertionSide(activeIndex: number, overIndex: number): "before" | "after" | null {
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return null;
  return overIndex > activeIndex ? "after" : "before";
}

export function leafIds(node: LayoutNode): Id[] {
  return node.type === "leaf" ? [node.pane_id] : [...leafIds(node.first), ...leafIds(node.second)];
}

const leaf = (pane_id: Id): LayoutNode => ({ type: "leaf", pane_id });

function mapLeaves(node: LayoutNode, f: (paneId: Id, node: LayoutNode) => LayoutNode): LayoutNode {
  return node.type === "leaf" ? f(node.pane_id, node) : { ...node, first: mapLeaves(node.first, f), second: mapLeaves(node.second, f) };
}

function removeLeaf(node: LayoutNode, paneId: Id): LayoutNode | null {
  if (node.type === "leaf") return node.pane_id === paneId ? null : node;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  return first && second ? { ...node, first, second } : (first ?? second);
}

export function beside(node: LayoutNode, place: DropPlace, paneId: Id, splitId: string): LayoutNode {
  const paneFirst = place === "left" || place === "top";
  return { type: "split", id: splitId, direction: place === "top" || place === "bottom" ? "vertical" : "horizontal", ratio: 0.5, first: paneFirst ? leaf(paneId) : node, second: paneFirst ? node : leaf(paneId) };
}

/** Client copy of the daemon's `layout::move_within`, for the dev torture page. `null` means no change. */
export function movePane(node: LayoutNode, paneId: Id, targetId: Id, place: DropPlace, splitId: string): LayoutNode | null {
  const ids = leafIds(node);
  if (paneId === targetId || !ids.includes(paneId) || !ids.includes(targetId)) return null;
  if (place === "center") return mapLeaves(node, (id, n) => (id === paneId ? leaf(targetId) : id === targetId ? leaf(paneId) : n));
  const rest = removeLeaf(node, paneId);
  return rest && mapLeaves(rest, (id, n) => (id === targetId ? beside(n, place, paneId, splitId) : n));
}
