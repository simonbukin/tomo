import { lazy, Suspense, useRef, useState } from "react";
import { rpc } from "./api";
import { paneIds, useStore } from "./store";
const TerminalPane = lazy(() => import("./TerminalPane").then((m) => ({ default: m.TerminalPane })));
import type { Id, LayoutNode, Tab } from "./types";

export function TabLayout({ tab }: { tab: Tab }) {
  const zoomed = useStore((s) => s.zoomed[tab.id] ?? null);
  const node: LayoutNode = zoomed && paneIds(tab.layout).includes(zoomed) ? { type: "leaf", pane_id: zoomed } : tab.layout;
  return (
    <div className="layout-root">
      <Node node={node} tabId={tab.id} activePane={tab.active_pane_id} />
    </div>
  );
}

function Node({ node, tabId, activePane }: { node: LayoutNode; tabId: Id; activePane: Id | null }) {
  if (node.type === "leaf") return <Suspense fallback={<div className="pane-wrap" />}><TerminalPane paneId={node.pane_id} active={node.pane_id === activePane} /></Suspense>;
  return <Split node={node} tabId={tabId} activePane={activePane} />;
}

function Split({ node, tabId, activePane }: { node: Extract<LayoutNode, { type: "split" }>; tabId: Id; activePane: Id | null }) {
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const ratio = drag ?? node.ratio;
  const horizontal = node.direction === "horizontal";

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let latest = node.ratio;
    const move = (ev: MouseEvent) => {
      const raw = horizontal ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      latest = Math.min(0.9, Math.max(0.1, raw));
      setDrag(latest);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove(horizontal ? "resizing-h" : "resizing-v");
      rpc("layout_resize", { tab_id: tabId, split_id: node.id, ratio: latest }).catch(() => {});
      setDrag(null);
    };
    document.body.classList.add(horizontal ? "resizing-h" : "resizing-v");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={ref} className={`split split-${node.direction}`}>
      <div className="split-child" style={{ flexBasis: `${ratio * 100}%` }}>
        <Node node={node.first} tabId={tabId} activePane={activePane} />
      </div>
      <div className={`splitter splitter-${node.direction}`} onMouseDown={onMouseDown} />
      <div className="split-child" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <Node node={node.second} tabId={tabId} activePane={activePane} />
      </div>
    </div>
  );
}
