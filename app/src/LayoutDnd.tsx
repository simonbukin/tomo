import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useDndContext, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type Modifier } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { sortableKeyboardCoordinates, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createContext, useCallback, useContext, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { movePane, moveTab, paneToNewTab, type PaneTarget } from "./commands/panes";
import type { DropPlace } from "./generated";
import { insertionSide, moveBoxes, stickyRegion, type Box, type Sticky } from "./layoutModel";
import type { Id, LayoutNode } from "./types";

type DragData = { kind: "tab"; tabId: Id } | { kind: "pane"; paneId: Id; tabId: Id; title: string };
type DropData = { kind: "tab"; tabId: Id } | { kind: "pane-drop"; paneId: Id } | { kind: "new-tab" };
type Hover = { dragId: Id; paneId: Id; place: DropPlace } | null;
type Anchor = { paneId: Id; at: Sticky } | null;

const HoverContext = createContext<Hover>(null);

const dragData = (d: { data: { current?: unknown } } | null | undefined) => d?.data.current as DragData | undefined;
const dropData = (d: { data: { current?: unknown } } | null | undefined) => d?.data.current as DropData | undefined;

const collision: CollisionDetection = (args) => {
  const tabDrag = dragData(args.active)?.kind === "tab";
  const droppableContainers = args.droppableContainers.filter((c) => {
    const kind = dropData(c)?.kind;
    return kind === "tab" || (!tabDrag && (kind === "pane-drop" || kind === "new-tab"));
  });
  return (tabDrag ? closestCenter : pointerWithin)({ ...args, droppableContainers });
};

const tabAxis: Modifier = (args) => (dragData(args.active)?.kind === "tab" ? restrictToHorizontalAxis(args) : args.transform);

/** Tabs keep their place while one is dragged; the insertion line shows where it lands. */
export const keepInPlace: SortingStrategy = () => null;

function pointer(e: DragMoveEvent | DragEndEvent): { x: number; y: number } | null {
  const start = e.activatorEvent as Partial<PointerEvent>;
  return typeof start.clientX === "number" && typeof start.clientY === "number" ? { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y } : null;
}

/** The region under the pointer, held steady by `anchor` so a boundary does not flicker. A new target pane starts a new anchor. */
function paneDrop(e: DragMoveEvent | DragEndEvent, anchor: Anchor): { hover: Hover; anchor: Anchor } {
  const from = dragData(e.active);
  const to = dropData(e.over);
  if (from?.kind !== "pane" || to?.kind !== "pane-drop" || to.paneId === from.paneId || !e.over) return { hover: null, anchor: null };
  const p = pointer(e);
  if (!p) return { hover: { dragId: from.paneId, paneId: to.paneId, place: "center" }, anchor: null };
  const at = stickyRegion(e.over.rect, p.x, p.y, anchor?.paneId === to.paneId ? anchor.at : null);
  return { hover: { dragId: from.paneId, paneId: to.paneId, place: at.place }, anchor: { paneId: to.paneId, at } };
}

export interface LayoutDndProps {
  children: ReactNode;
  onTabMove?: (tabId: Id, position: number) => void;
  onPaneMove?: (paneId: Id, target: PaneTarget, place: DropPlace) => void;
  onPaneToNewTab?: (paneId: Id) => void;
}

export function LayoutDnd({ children, onTabMove = moveTab, onPaneMove = movePane, onPaneToNewTab = paneToNewTab }: LayoutDndProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [hover, setHover] = useState<Hover>(null);
  const anchor = useRef<Anchor>(null);
  const finish = () => {
    setHover(null);
    anchor.current = null;
    document.body.classList.remove("pane-dragging");
  };
  const onDragStart = (e: DragStartEvent) => {
    if (dragData(e.active)?.kind === "pane") document.body.classList.add("pane-dragging");
  };
  const onDragMove = (e: DragMoveEvent) => {
    const { hover: next, anchor: at } = paneDrop(e, anchor.current);
    anchor.current = at;
    setHover((h) => (h?.paneId === next?.paneId && h?.place === next?.place ? h : next));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const drop = paneDrop(e, anchor.current).hover;
    finish();
    const from = dragData(e.active);
    const to = dropData(e.over);
    if (from?.kind === "tab" && to?.kind === "tab" && from.tabId !== to.tabId) {
      const index = (e.over?.data.current as { sortable?: { index: number } } | undefined)?.sortable?.index;
      if (index !== undefined) onTabMove(from.tabId, index);
    }
    if (from?.kind === "pane" && to?.kind === "tab" && to.tabId !== from.tabId) onPaneMove(from.paneId, { tabId: to.tabId }, "right");
    if (from?.kind === "pane" && to?.kind === "new-tab") onPaneToNewTab(from.paneId);
    if (from?.kind === "pane" && drop) onPaneMove(from.paneId, { paneId: drop.paneId }, drop.place);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} modifiers={[tabAxis]} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={finish}>
      <HoverContext.Provider value={hover}>{children}</HoverContext.Provider>
      <PaneDragOverlay />
    </DndContext>
  );
}

function PaneDragOverlay() {
  const data = dragData(useDndContext().active);
  return <DragOverlay dropAnimation={null}>{data?.kind === "pane" ? <div className="pane-drag-chip">{data.title || "pane"}</div> : null}</DragOverlay>;
}

export function NewTabDrop() {
  const dragging = dragData(useDndContext().active)?.kind === "pane";
  const { setNodeRef, isOver } = useDroppable({ id: "new-tab-drop", data: { kind: "new-tab" } satisfies DropData });
  if (!dragging) return null;
  return (
    <div ref={setNodeRef} className={`tab-newdrop${isOver ? " tab-newdrop-over" : ""}`}>
      new tab
    </div>
  );
}

export function useTabSortable(tabId: Id, disabled = false) {
  const s = useSortable({ id: tabId, data: { kind: "tab", tabId } satisfies DragData, disabled });
  const kind = dragData(s.active)?.kind;
  const side = s.isOver && kind === "tab" ? insertionSide(s.activeIndex, s.index) : null;
  return {
    ref: s.setNodeRef,
    props: { ...s.attributes, ...s.listeners },
    style: { transform: CSS.Translate.toString(s.transform), transition: s.transition },
    className: [s.isDragging && "tab-dragging", side && `tab-drop-${side}`, s.isOver && kind === "pane" && "tab-pane-over"].filter(Boolean).join(" "),
    busy: !!s.active,
  };
}

/** Spread on the pane chrome that starts a pane drag. Never on the terminal body: text selection must keep working. */
export function usePaneDrag(paneId: Id, tabId: Id, title: string, enabled = true) {
  const d = useDraggable({ id: `pane-drag:${paneId}`, disabled: !enabled, data: { kind: "pane", paneId, tabId, title } satisfies DragData });
  return { ref: d.setNodeRef, props: { ...d.attributes, ...d.listeners } };
}

const PLACE_LABEL: Record<DropPlace, string> = { center: "swap", left: "split left", right: "split right", top: "split up", bottom: "split down" };

/** Fills the pane so a drag can aim at it. The preview over the layout draws the result. */
export function PaneDropZone({ paneId }: { paneId: Id }) {
  const { setNodeRef } = useDroppable({ id: `pane-drop:${paneId}`, data: { kind: "pane-drop", paneId } satisfies DropData });
  return <div ref={setNodeRef} className="pane-drop" aria-hidden />;
}

/** The pane under the pointer and the region it shows, or `null` while no pane drags. */
export const usePaneDropHover = () => useContext(HoverContext);

const num = (style: CSSStyleDeclaration, prop: string) => parseFloat(style.getPropertyValue(prop)) || 0;

/** The box the split tree fills: the content box of the layout root, in viewport coordinates. */
function contentBox(el: HTMLElement): Box {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const left = num(style, "padding-left");
  const top = num(style, "padding-top");
  return { left: rect.left + left, top: rect.top + top, width: rect.width - left - num(style, "padding-right"), height: rect.height - top - num(style, "padding-bottom") };
}

const frame = (box: Box): CSSProperties => ({ transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height });

/**
 * Draws the result of the drop, not the region under the pointer: the box the dragged pane takes, and the box
 * the target keeps. `moveBoxes` runs the same `movePane` as the drop, so the picture cannot disagree with it.
 * Render it as the last child of `.layout-root`.
 */
export function LayoutPreview({ node }: { node: LayoutNode }) {
  const hover = useContext(HoverContext);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const mount = useCallback((el: HTMLDivElement | null) => setRoot(el?.parentElement ?? null), []);
  const boxes = hover && root ? moveBoxes(node, hover.dragId, hover.paneId, hover.place, contentBox(root), num(getComputedStyle(root), "--sp-2")) : null;
  const landing = hover && boxes ? boxes.get(hover.dragId) : undefined;
  const target = hover && boxes ? boxes.get(hover.paneId) : undefined;
  return (
    <div className="pane-preview-layer" ref={mount} aria-hidden>
      {target && <div className="pane-preview pane-preview-target" style={frame(target)} />}
      {landing && hover && <div className="pane-preview" style={frame(landing)}>{PLACE_LABEL[hover.place]}</div>}
    </div>
  );
}
