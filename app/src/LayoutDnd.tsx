import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useDndContext, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type Modifier } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { sortableKeyboardCoordinates, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createContext, useContext, useState, type ReactNode } from "react";
import { movePane, moveTab, type PaneTarget } from "./commands/panes";
import type { DropPlace } from "./generated";
import { dropRegion, insertionSide } from "./layoutModel";
import type { Id } from "./types";

type DragData = { kind: "tab"; tabId: Id } | { kind: "pane"; paneId: Id; tabId: Id; title: string };
type DropData = { kind: "tab"; tabId: Id } | { kind: "pane-drop"; paneId: Id };
type Hover = { paneId: Id; place: DropPlace } | null;

const HoverContext = createContext<Hover>(null);

const dragData = (d: { data: { current?: unknown } } | null | undefined) => d?.data.current as DragData | undefined;
const dropData = (d: { data: { current?: unknown } } | null | undefined) => d?.data.current as DropData | undefined;

const collision: CollisionDetection = (args) => {
  const tabDrag = dragData(args.active)?.kind === "tab";
  const droppableContainers = args.droppableContainers.filter((c) => {
    const kind = dropData(c)?.kind;
    return kind === "tab" || (!tabDrag && kind === "pane-drop");
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

function paneDrop(e: DragMoveEvent | DragEndEvent): Hover {
  const from = dragData(e.active);
  const to = dropData(e.over);
  if (from?.kind !== "pane" || to?.kind !== "pane-drop" || to.paneId === from.paneId || !e.over) return null;
  const p = pointer(e);
  return { paneId: to.paneId, place: p ? dropRegion(e.over.rect, p.x, p.y) : "center" };
}

export interface LayoutDndProps {
  children: ReactNode;
  onTabMove?: (tabId: Id, position: number) => void;
  onPaneMove?: (paneId: Id, target: PaneTarget, place: DropPlace) => void;
}

/** One drag context for the tab strip and the split layout, so a pane can drop on a pane or on a tab. */
export function LayoutDnd({ children, onTabMove = moveTab, onPaneMove = movePane }: LayoutDndProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [hover, setHover] = useState<Hover>(null);
  const finish = () => {
    setHover(null);
    document.body.classList.remove("pane-dragging");
  };
  const onDragStart = (e: DragStartEvent) => {
    if (dragData(e.active)?.kind === "pane") document.body.classList.add("pane-dragging");
  };
  const onDragMove = (e: DragMoveEvent) => {
    const next = paneDrop(e);
    setHover((h) => (h?.paneId === next?.paneId && h?.place === next?.place ? h : next));
  };
  const onDragEnd = (e: DragEndEvent) => {
    finish();
    const from = dragData(e.active);
    const to = dropData(e.over);
    if (from?.kind === "tab" && to?.kind === "tab" && from.tabId !== to.tabId) {
      const index = (e.over?.data.current as { sortable?: { index: number } } | undefined)?.sortable?.index;
      if (index !== undefined) onTabMove(from.tabId, index);
    }
    if (from?.kind === "pane" && to?.kind === "tab" && to.tabId !== from.tabId) onPaneMove(from.paneId, { tabId: to.tabId }, "right");
    const drop = paneDrop(e);
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
export function usePaneDrag(paneId: Id, tabId: Id, title: string) {
  const d = useDraggable({ id: `pane-drag:${paneId}`, data: { kind: "pane", paneId, tabId, title } satisfies DragData });
  return { ref: d.setNodeRef, props: { ...d.attributes, ...d.listeners } };
}

const PLACE_LABEL: Record<DropPlace, string> = { center: "swap", left: "split left", right: "split right", top: "split up", bottom: "split down" };

/** Fills the pane; shows where the dragged pane lands. Render it inside a positioned pane frame. */
export function PaneDropZone({ paneId }: { paneId: Id }) {
  const { setNodeRef } = useDroppable({ id: `pane-drop:${paneId}`, data: { kind: "pane-drop", paneId } satisfies DropData });
  const hover = useContext(HoverContext);
  const place = hover?.paneId === paneId ? hover.place : null;
  return (
    <div ref={setNodeRef} className="pane-drop" aria-hidden>
      {place && <div className={`pane-drop-area pane-drop-${place}`}>{PLACE_LABEL[place]}</div>}
    </div>
  );
}
