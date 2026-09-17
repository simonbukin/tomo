import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { closePane, focusPane, openExternalUrl } from "../actions";
import { browserToolbarItems } from "../addons";
import { rpc } from "../api";
import { IconButton } from "../components/ui";
import { openMenu } from "../MenuHost";
import { browserMenu, isLastPane } from "../menus";
import { useShortcuts } from "../shortcuts";
import {failQuietly, getState, useStore} from "../store";
import type { Id } from "../types";
import { browserCommand, browserHostFailed, browserPaneIds, normalizeUrl } from "./browser";

type BrowserState = { pane_id: Id; url?: string; title?: string; loading?: boolean };
type Bounds = { x: number; y: number; width: number; height: number };

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Child webviews take window points, but CSS pixels grow and shrink with the webview zoom. */
function boundsOf(el: HTMLElement): Bounds {
  const r = el.getBoundingClientRect();
  const zoom = getState().ui.appearance.zoom;
  return { x: r.left * zoom, y: r.top * zoom, width: r.width * zoom, height: r.height * zoom };
}

const sameBounds = (a: Bounds | null, b: Bounds) => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Mounted for the whole session. A sleeping webview has no component, so the close of a pane that left the store happens here. */
export function BrowserHost() {
  const ids = useStore(browserPaneIds);
  const known = useRef(ids);
  useEffect(() => {
    known.current.filter((id) => !ids.includes(id)).forEach((id) => invoke("browser_close", { paneId: id }).catch(browserHostFailed("browser_close")));
    known.current = ids;
  }, [ids]);
  return null;
}

export function BrowserPane({ paneId, active }: { paneId: Id; active: boolean }) {
  const pane = useStore((s) => s.panes[paneId]);
  const covered = useStore((s) => !!s.menu || !!s.dialog || s.paletteOpen);
  const lastPane = useStore(() => isLastPane(paneId));
  const shortcut = useShortcuts();
  const focusedKey = (id: string) => (active ? shortcut(id) : undefined);
  const hostRef = useRef<HTMLDivElement>(null);
  const lastBounds = useRef<Bounds | null>(null);
  const urlRef = useRef(pane?.url ?? "about:blank");
  const [url, setUrlState] = useState(urlRef.current);
  const [draft, setDraft] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const toolbarItems = browserToolbarItems();
  const [covering, setCovering] = useState<Readonly<Record<string, boolean>>>({});
  const coverSetters = useMemo(
    () => Object.fromEntries(toolbarItems.map(({ id }) => [id, (on: boolean) => setCovering((prev) => (!!prev[id] === on ? prev : { ...prev, [id]: on }))])),
    [],
  );
  const setUrl = (u: string) => {
    urlRef.current = u;
    setUrlState(u);
  };

  const pushBounds = () => {
    const host = hostRef.current;
    if (!host) return;
    const b = boundsOf(host);
    if (sameBounds(lastBounds.current, b)) return;
    lastBounds.current = b;
    invoke("browser_set_bounds", { paneId, ...b }).catch(browserHostFailed("browser_set_bounds"));
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = boundsOf(host);
    lastBounds.current = initial;
    invoke("browser_create", { paneId, url: urlRef.current, ...initial }).catch(browserHostFailed("browser_create", "Browser failed to open"));
    // A sidebar or header change moves the pane without resizing it, which a ResizeObserver never reports.
    let frame = requestAnimationFrame(function follow() {
      pushBounds();
      frame = requestAnimationFrame(follow);
    });
    const offState = listen<BrowserState>("browser://state", (e) => {
      const st = e.payload;
      if (st.pane_id !== paneId) return;
      if (st.title !== undefined) setTitle(st.title);
      if (st.url !== undefined && st.url !== urlRef.current) {
        setUrl(st.url);
        rpc("browser_navigate", { pane_id: paneId, url: st.url }).catch(failQuietly("browser_navigate"));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      offState.then((off) => off());
      // The pane owns the webview, not this component: unmount puts the page to sleep, and BrowserHost closes it when the pane goes.
      invoke("browser_set_visible", { paneId, visible: false }).catch(browserHostFailed("browser_set_visible"));
    };
  }, [paneId]);

  const itemCovering = Object.values(covering).some(Boolean);
  useEffect(() => {
    invoke("browser_set_visible", { paneId, visible: !(covered || itemCovering) }).catch(browserHostFailed("browser_set_visible"));
  }, [paneId, covered, itemCovering]);

  useEffect(() => {
    if (pane?.url && pane.url !== urlRef.current) {
      setUrl(pane.url);
      invoke("browser_navigate", { paneId, url: pane.url }).catch(browserHostFailed("browser_navigate"));
    }
  }, [pane?.url]);

  const navigate = (text: string) => {
    const next = normalizeUrl(text);
    setDraft(null);
    setUrl(next);
    invoke("browser_navigate", { paneId, url: next }).catch(browserHostFailed("browser_navigate", "Navigation failed"));
    rpc("browser_navigate", { pane_id: paneId, url: next }).catch(failQuietly("browser_navigate"));
  };

  const legendTitle = pane?.user_title ?? (title || hostOf(url));
  return (
    <div className="pane-wrap">
      <div className={`pane pane-browser${active ? " pane-active" : ""}`}>
        <div className="pane-legend" onMouseDown={() => focusPane(paneId)} onContextMenu={(e) => openMenu(e, browserMenu(paneId))}>
          <span className="chip">
            <span className="state state-none" />
            <Globe className="icon proc-icon" aria-hidden />
            <strong>{legendTitle}</strong>
          </span>
          <span className="chip right" title={url}>
            <span>{hostOf(url)}</span>
            {!lastPane && (
              <IconButton label="Close pane" shortcut={focusedKey("close_pane")} onClick={() => closePane(paneId)}>
                <X className="icon" />
              </IconButton>
            )}
          </span>
        </div>
        <div className="browser-toolbar" onMouseDown={() => focusPane(paneId)}>
          <IconButton label="Back" shortcut={focusedKey("browser_back")} onClick={() => browserCommand(paneId, "browser_back")}>
            <ArrowLeft className="icon" />
          </IconButton>
          <IconButton label="Forward" shortcut={focusedKey("browser_forward")} className="browser-forward" onClick={() => browserCommand(paneId, "browser_forward")}>
            <ArrowRight className="icon" />
          </IconButton>
          <IconButton label="Reload" shortcut={focusedKey("browser_reload")} onClick={() => browserCommand(paneId, "browser_reload")}>
            <RotateCw className="icon" />
          </IconButton>
          <input
            className="browser-url"
            value={draft ?? url}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(e.currentTarget.value);
              if (e.key === "Escape") setDraft(null);
            }}
          />
          {pane && toolbarItems.map(({ id, component: Item }) => <Item key={id} paneId={paneId} worktreeId={pane.worktree_id} url={url} setCovering={coverSetters[id]} />)}
          <IconButton label="Open in external browser" className="browser-external" onClick={() => openExternalUrl(url)}>
            <ExternalLink className="icon" />
          </IconButton>
        </div>
        <div className="browser-host" ref={hostRef} />
      </div>
    </div>
  );
}
