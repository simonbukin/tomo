import { Columns2, FileText, Rows2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { closePane, focusPane, openExternalFor, splitPaneById } from "../actions";
import { rpc } from "../api";
import { Button, IconButton } from "../components/ui";
import { PaneDropZone, usePaneDrag } from "../LayoutDnd";
import { openMenu } from "../MenuHost";
import { editorMenu, isLastPane } from "../menus";
import { dotClass } from "../glyphs";
import { useShortcuts } from "../shortcuts";
import { failQuietly, failToast, splitsAllowed, useStore } from "../store";
import type { Id } from "../types";
import { editorPaneIds, preloadEditor } from "./editor";
import { titleOf, type EditorDoc } from "./model";
import { forgetSession, setComparing, useComparing, useEditorDoc } from "./sessions";

const cm = () => import("./cm");
const run = (f: (m: Awaited<ReturnType<typeof cm>>) => void) => () => void cm().then(f).catch(failToast("Editor failed to load"));

/** Mounted for the whole session. A buffer outlives its view, so the buffer of a pane that left the store goes here. */
export function EditorHost() {
  const ids = useStore(editorPaneIds);
  const known = useRef(ids);
  useEffect(() => {
    known.current.filter((id) => !ids.includes(id)).forEach(forgetSession);
    known.current = ids;
  }, [ids]);
  useEffect(() => {
    const t = window.setTimeout(() => void preloadEditor().catch(failQuietly("editor preload")), 1500);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}

function NoticeBar({ paneId, doc, comparing }: { paneId: Id; doc: EditorDoc; comparing: boolean }) {
  if (doc.notice?.kind === "changed")
    return (
      <div className="editor-bar" role="status">
        <span className={dotClass("needs")} />
        <span className="editor-bar-text">Changed on disk. Your edits are kept.</span>
        <Button variant="link" onClick={run((m) => m.reloadFromDisk(paneId))}>Reload</Button>
        <Button variant="link" aria-pressed={comparing} onClick={() => setComparing(paneId, !comparing)}>
          {comparing ? "Close compare" : "Compare"}
        </Button>
        <Button variant="link" onClick={run((m) => m.keepMine(paneId))}>Keep mine</Button>
      </div>
    );
  if (doc.notice?.kind === "deleted")
    return (
      <div className="editor-bar" role="status">
        <span className={dotClass("needs")} />
        <span className="editor-bar-text">Not on disk. Save creates the file.</span>
        <Button variant="link" onClick={run((m) => m.dismiss(paneId))}>Dismiss</Button>
      </div>
    );
  if (doc.error && doc.base)
    return (
      <div className="editor-bar editor-bar-error" role="alert">
        <span className={dotClass("failed")} />
        <span className="editor-bar-text">{doc.error}</span>
        <Button variant="link" onClick={run((m) => m.retry(paneId))}>Check again</Button>
      </div>
    );
  if (doc.overwrite)
    return (
      <div className="editor-bar" role="status">
        <span className="editor-bar-text muted">Keeping your version. Save replaces the file on disk.</span>
      </div>
    );
  return null;
}

export function EditorPane({ paneId, active }: { paneId: Id; active: boolean }) {
  const pane = useStore((s) => s.panes[paneId]);
  const worktree = useStore((s) => s.worktrees.find((w) => w.id === pane?.worktree_id));
  const zoomed = useStore((s) => !!pane && s.zoomed[pane.tab_id] === paneId);
  const fontFamily = useStore((s) => s.config?.font_family);
  const fontSize = useStore((s) => s.config?.font_size);
  const splits = useStore(splitsAllowed);
  const lastPane = useStore(() => isLastPane(paneId));
  const doc = useEditorDoc(paneId);
  const comparing = useComparing(paneId);
  const shortcut = useShortcuts();
  const hostRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const target = pane?.editor ?? null;
  const path = target?.path ?? "";
  const title = pane?.user_title ?? titleOf(path, !!doc?.dirty);
  const drag = usePaneDrag(paneId, pane?.tab_id ?? "", title, splits);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !pane || !target) return;
    let live = true;
    let unmount = () => {};
    cm()
      .then((m) => {
        if (live) unmount = m.mount(paneId, host, pane.worktree_id, target);
      })
      .catch(failToast("Editor failed to load"));
    return () => {
      live = false;
      unmount();
    };
  }, [paneId, path, attempt]);

  useEffect(() => {
    const host = compareRef.current;
    if (!comparing || !host) return;
    let live = true;
    let unmount = () => {};
    cm()
      .then((m) => m.mountCompare(paneId, host))
      .then((off) => (live ? (unmount = off) : off()))
      .catch(failToast("Compare failed"));
    return () => {
      live = false;
      unmount();
    };
  }, [comparing, paneId, doc?.notice]);

  const loadError = doc?.error && !doc.base ? doc.error : null;
  return (
    <div className="pane-wrap">
      <div className={`pane pane-editor${active ? " pane-active" : ""}`}>
        <div className="pane-legend" onMouseDown={() => focusPane(paneId)} onContextMenu={(e) => openMenu(e, editorMenu(paneId))}>
          <span className={splits ? "chip pane-grip" : "chip"} ref={drag.ref} {...drag.props}>
            <span className="state state-none" />
            <FileText className="icon proc-icon" aria-hidden />
            <strong>{title}</strong>
            {zoomed && <span className="pane-note pane-zoomed">zoomed</span>}
          </span>
          <span className="chip right" title={worktree ? `${worktree.path}/${path}` : path}>
            <span>{path}</span>
            {splits && <IconButton label="Split right" shortcut={active ? shortcut("new_terminal") : undefined} onClick={() => splitPaneById(paneId, "horizontal")}><Columns2 className="icon" /></IconButton>}
            {splits && <IconButton label="Split down" shortcut={active ? shortcut("split_vertical") : undefined} onClick={() => splitPaneById(paneId, "vertical")}><Rows2 className="icon" /></IconButton>}
            {!lastPane && <IconButton label="Close pane" shortcut={active ? shortcut("close_pane") : undefined} onClick={() => closePane(paneId)}><X className="icon" /></IconButton>}
          </span>
        </div>
        {doc && <NoticeBar paneId={paneId} doc={doc} comparing={comparing} />}
        <div className="editor-body" style={{ "--editor-font": fontFamily, "--editor-size": fontSize ? `${fontSize}px` : undefined } as CSSProperties}>
          <div className="editor-host" ref={hostRef} onMouseDown={() => !active && rpc("pane_focus", { pane_id: paneId }).catch(failQuietly("pane_focus"))} />
          {comparing && (
            <div className="editor-compare">
              <div className="editor-compare-head">
                <span>yours</span>
                <span>on disk</span>
              </div>
              <div className="editor-compare-body" ref={compareRef} />
            </div>
          )}
          {loadError && (
            <div className="editor-error" role="alert">
              <p>{loadError}</p>
              <div className="editor-error-actions">
                <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
                {pane && <Button size="sm" onClick={() => openExternalFor(pane.worktree_id, "editor", path)}>Open in external editor</Button>}
              </div>
            </div>
          )}
        </div>
        {splits && <PaneDropZone paneId={paneId} />}
      </div>
    </div>
  );
}
