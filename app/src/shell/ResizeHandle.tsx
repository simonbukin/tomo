import type { PointerEvent } from "react";
import { setUi } from "../store";
import { columnWidth, snapPatch, snapSidebar, type Side } from "./sidebarMode";

const COLUMN_VAR: Record<Side, string> = { left: "--left-col", right: "--right-col" };

/** The body boundary of a sidebar. The drag previews the snapped column and saves the mode and open width on release. */
export function ResizeHandle({ side, width }: { side: Side; width: number }) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const app = handle.closest<HTMLElement>(".app");
    const start = e.clientX;
    const before = app?.style.getPropertyValue(COLUMN_VAR[side]) ?? "";
    const rawAt = (x: number) => width + (side === "left" ? x - start : start - x);
    let raw = width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-h", "no-anim");
    const move = (ev: globalThis.PointerEvent) => {
      raw = rawAt(ev.clientX);
      const snap = snapSidebar(raw);
      app?.style.setProperty(COLUMN_VAR[side], `${columnWidth(snap.mode, snap.width ?? 0)}px`);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("lostpointercapture", end);
      document.body.classList.remove("resizing-h", "no-anim");
      app?.style.setProperty(COLUMN_VAR[side], before);
      if (raw !== width) setUi(snapPatch(side, raw));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end);
  };
  return <div className={`resize-handle resize-${side}`} role="separator" aria-orientation="vertical" aria-label={side === "left" ? "Resize sidebar" : "Resize inspector"} onPointerDown={onPointerDown} />;
}
