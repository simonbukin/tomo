import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { rpc } from "./api";
import {failQuietly, paneIds, useStore} from "./store";
const TerminalPane = lazy(() => import("./TerminalPane").then((m) => ({ default: m.TerminalPane })));
import { BrowserPane } from "./browser/BrowserPane";
import { EditorPane } from "./editor/EditorPane";
import { LayoutHidden, LayoutPreview } from "./LayoutDnd";
import { keptTabs, type Candidate } from "./layoutKeep";
import type { Id, LayoutNode, Tab } from "./types";

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The active tab's layout and the layouts of the tabs seen just before it, mounted on top of each other. Only the
 * active one shows; a switch to a kept tab draws nothing new. See layoutKeep.ts.
 */
export function LayoutStack({ active }: { active: Tab }) {
  const recent = useRef<string[]>([]);
  const tabsByWorktree = useStore((s) => s.tabs);
  const browsers = useStore((s) => Object.values(s.panes).filter((p) => p.kind === "browser").map((p) => p.id).join(" "));
  const candidates = new Map(
    Object.values(tabsByWorktree)
      .flat()
      .map((t): [string, Candidate & { tab: Tab }] => [t.id, { id: t.id, tab: t, panes: paneIds(t.layout).length, keepable: paneIds(t.layout).every((p) => !browsers.split(" ").includes(p)) }]),
  );
  const kept = keptTabs(recent.current, active.id, candidates);
  if (!sameIds(kept, recent.current)) recent.current = kept;
  return (
    <div className="layout-stack">
      {kept.map((id) => {
        const t = id === active.id ? active : candidates.get(id)?.tab;
        return t ? <TabLayout key={id} tab={t} hidden={id !== active.id} /> : null;
      })}
    </div>
  );
}

export function TabLayout({ tab, hidden = false }: { tab: Tab; hidden?: boolean }) {
  const zoomed = useStore((s) => s.zoomed[tab.id] ?? null);
  const node: LayoutNode = zoomed && paneIds(tab.layout).includes(zoomed) ? { type: "leaf", pane_id: zoomed } : tab.layout;
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (hidden && root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
  }, [hidden]);
  return (
    <LayoutHidden.Provider value={hidden}>
      <div className="layout-root" ref={root} data-tab-id={tab.id} data-hidden={hidden || undefined} aria-hidden={hidden || undefined}>
        <Node node={node} tabId={tab.id} activePane={tab.active_pane_id} />
        <LayoutPreview node={node} />
      </div>
    </LayoutHidden.Provider>
  );
}

function Node({ node, tabId, activePane }: { node: LayoutNode; tabId: Id; activePane: Id | null }) {
  const kind = useStore((s) => (node.type === "leaf" ? s.panes[node.pane_id]?.kind : undefined));
  if (node.type === "leaf" && kind === "browser") return <BrowserPane paneId={node.pane_id} active={node.pane_id === activePane} />;
  if (node.type === "leaf" && kind === "editor") return <EditorPane paneId={node.pane_id} active={node.pane_id === activePane} />;
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
      if (latest !== node.ratio) rpc("layout_resize", { tab_id: tabId, split_id: node.id, ratio: latest }).catch(failQuietly("layout_resize"));
      setDrag(null);
    };
    document.body.classList.add(horizontal ? "resizing-h" : "resizing-v");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const equalize = () => {
    if (node.ratio !== 0.5) rpc("layout_resize", { tab_id: tabId, split_id: node.id, ratio: 0.5 }).catch(failQuietly("layout_resize"));
  };
  return (
    <div ref={ref} className={`split split-${node.direction}`}>
      <div className="split-child" style={{ flexBasis: `${ratio * 100}%` }}>
        <Node node={node.first} tabId={tabId} activePane={activePane} />
      </div>
      <div className={`splitter splitter-${node.direction}`} onMouseDown={onMouseDown} onDoubleClick={equalize} />
      <div className="split-child" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <Node node={node.second} tabId={tabId} activePane={activePane} />
      </div>
    </div>
  );
}
