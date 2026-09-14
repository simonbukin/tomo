import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, MessageSquarePlus, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { browserCommand, closePane, copyText, focusPane, openExternalUrl } from "./actions";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "./components/ui";
import { openMenu } from "./MenuHost";
import { browserMenu, isLastPane } from "./menus";
import { agentsOf, notify, useStore } from "./store";
import { KIND_LABEL, type Annotation, type EvidenceBundle, type Id } from "./types";

type BrowserState = { pane_id: Id; url?: string; title?: string; loading?: boolean };
type Bounds = { x: number; y: number; width: number; height: number };

const INSTRUCTION = "Review and address these annotations.";

export function normalizeUrl(text: string): string {
  const t = text.trim();
  if (!t) return "about:blank";
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `http://${t}`;
}

export function annotationsText(notes: Annotation[]): string {
  return notes.map((a, i) => `${i + 1}. [${a.selector ?? "-"}] "${a.element_text ?? ""}" — ${a.text}`).join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function boundsOf(el: HTMLElement): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const sameBounds = (a: Bounds | null, b: Bounds) => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function BrowserPane({ paneId, active }: { paneId: Id; active: boolean }) {
  const pane = useStore((s) => s.panes[paneId]);
  const covered = useStore((s) => !!s.menu || !!s.dialog || s.paletteOpen);
  const agents = useStore((s) => (pane ? agentsOf(s, pane.worktree_id) : []));
  const lastPane = useStore(() => isLastPane(paneId));
  const hostRef = useRef<HTMLDivElement>(null);
  const lastBounds = useRef<Bounds | null>(null);
  const urlRef = useRef(pane?.url ?? "about:blank");
  const [url, setUrlState] = useState(urlRef.current);
  const [draft, setDraft] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [annotate, setAnnotate] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
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
    invoke("browser_set_bounds", { paneId, ...b }).catch(() => {});
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = boundsOf(host);
    lastBounds.current = initial;
    invoke("browser_create", { paneId, url: urlRef.current, ...initial }).catch((e) => notify("error", String(e)));
    const observer = new ResizeObserver(pushBounds);
    observer.observe(host);
    window.addEventListener("resize", pushBounds);
    const offState = listen<BrowserState>("browser://state", (e) => {
      const st = e.payload;
      if (st.pane_id !== paneId) return;
      if (st.title !== undefined) setTitle(st.title);
      if (st.url !== undefined && st.url !== urlRef.current) {
        setUrl(st.url);
        rpc("browser_navigate", { pane_id: paneId, url: st.url }).catch(() => {});
      }
    });
    const offNotes = listen<{ pane_id: Id; annotations: Annotation[] }>("browser://annotations", (e) => {
      if (e.payload.pane_id === paneId) setNotes(e.payload.annotations);
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", pushBounds);
      offState.then((off) => off());
      offNotes.then((off) => off());
      invoke("browser_close", { paneId }).catch(() => {});
    };
  }, [paneId]);

  useEffect(() => {
    pushBounds();
  });

  useEffect(() => {
    invoke("browser_set_visible", { paneId, visible: !(covered || menuOpen) }).catch(() => {});
  }, [paneId, covered, menuOpen]);

  useEffect(() => {
    if (pane?.url && pane.url !== urlRef.current) {
      setUrl(pane.url);
      invoke("browser_navigate", { paneId, url: pane.url }).catch(() => {});
    }
  }, [pane?.url]);

  useEffect(() => {
    invoke("browser_set_annotate", { paneId, enabled: annotate }).catch(() => {});
  }, [paneId, annotate, url]);

  const navigate = (text: string) => {
    const next = normalizeUrl(text);
    setDraft(null);
    setUrl(next);
    invoke("browser_navigate", { paneId, url: next }).catch((e) => notify("error", String(e)));
    rpc("browser_navigate", { pane_id: paneId, url: next }).catch(() => {});
  };

  const send = async (agentPaneId: Id, label: string) => {
    if (!pane) return;
    const bundle: EvidenceBundle = { source: "browser annotation", worktree_id: pane.worktree_id, url, action_id: null, annotations: notes, instruction: INSTRUCTION };
    try {
      await rpc("annotations_send", { pane_id: agentPaneId, bundle });
      setNotes([]);
      invoke("browser_clear_annotations", { paneId }).catch(() => {});
      notify("info", `Sent ${bundle.annotations.length} annotations to ${label}`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  };

  const sendItems = (): MenuItem[] => [
    ...(agents.length ? agents.map((a) => ({ label: `${KIND_LABEL[a.kind]} — ${a.state}`, run: () => send(a.pane_id, KIND_LABEL[a.kind]) })) : [{ label: "no live agent in this worktree", disabled: true }]),
    { separator: true },
    { label: "Copy as text", run: () => copyText(annotationsText(notes), "Annotations") },
  ];

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
              <IconButton label="Close pane" onClick={() => closePane(paneId)}>
                <X className="icon" />
              </IconButton>
            )}
          </span>
        </div>
        <div className="browser-toolbar" onMouseDown={() => focusPane(paneId)}>
          <IconButton label="Back" onClick={() => browserCommand(paneId, "browser_back")}>
            <ArrowLeft className="icon" />
          </IconButton>
          <IconButton label="Forward" onClick={() => browserCommand(paneId, "browser_forward")}>
            <ArrowRight className="icon" />
          </IconButton>
          <IconButton label="Reload" onClick={() => browserCommand(paneId, "browser_reload")}>
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
          <IconButton label={annotate ? "Stop annotating" : "Annotate"} className={annotate ? "browser-annotate-on" : undefined} aria-pressed={annotate} onClick={() => setAnnotate((v) => !v)}>
            <MessageSquarePlus className="icon" />
          </IconButton>
          <IconButton label="Open in external browser" onClick={() => openExternalUrl(url)}>
            <ExternalLink className="icon" />
          </IconButton>
          {notes.length > 0 && (
            <span className="browser-notes">
              {notes.length} {notes.length === 1 ? "annotation" : "annotations"} ·
              <DropdownMenu onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger render={<Button size="sm" />}>Send to…</DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <MenuItems items={sendItems} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )}
        </div>
        <div className="browser-host" ref={hostRef} />
      </div>
    </div>
  );
}
