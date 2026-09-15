import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, Copy, ExternalLink, Globe, MessageSquarePlus, RotateCw, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { browserCommand, closePane, copyText, focusPane, openExternalUrl } from "./actions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, type MenuItem } from "./components/ui";
import { openMenu } from "./MenuHost";
import { browserMenu, isLastPane } from "./menus";
import { useShortcuts } from "./shortcuts";
import { agentsOf, notify, useStore } from "./store";
import { KIND_LABEL, type EvidenceBundle, type Id } from "./types";

type BrowserState = { pane_id: Id; url?: string; title?: string; loading?: boolean };
type Bounds = { x: number; y: number; width: number; height: number };
type Feedback = { count: number; markdown: string };
type FeedbackEvent = Feedback & { pane_id: Id; kind: "change" | "copy" | "submit" };

const INSTRUCTION = "Review and address this feedback.";
const NO_FEEDBACK: Feedback = { count: 0, markdown: "" };

export function normalizeUrl(text: string): string {
  const t = text.trim();
  if (!t) return "about:blank";
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `http://${t}`;
}

const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

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
  const shortcut = useShortcuts();
  const focusedKey = (id: string) => (active ? shortcut(id) : undefined);
  const hostRef = useRef<HTMLDivElement>(null);
  const lastBounds = useRef<Bounds | null>(null);
  const urlRef = useRef(pane?.url ?? "about:blank");
  const [url, setUrlState] = useState(urlRef.current);
  const [draft, setDraft] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [annotate, setAnnotate] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);
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
        setFeedback(NO_FEEDBACK);
        rpc("browser_navigate", { pane_id: paneId, url: st.url }).catch(() => {});
      }
    });
    const offFeedback = listen<FeedbackEvent>("browser://feedback", (e) => {
      const { pane_id, kind, count, markdown } = e.payload;
      if (pane_id !== paneId) return;
      if (kind === "change") setFeedback({ count, markdown });
      if (kind === "copy") copyText(markdown, "Feedback");
      if (kind === "submit") setMenuOpen(true);
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", pushBounds);
      offState.then((off) => off());
      offFeedback.then((off) => off());
      invoke("browser_close", { paneId }).catch(() => {});
    };
  }, [paneId]);

  useEffect(() => {
    pushBounds();
  });

  const sendOpen = menuOpen && feedback.count > 0;
  useEffect(() => {
    invoke("browser_set_visible", { paneId, visible: !(covered || sendOpen) }).catch(() => {});
  }, [paneId, covered, sendOpen]);

  useEffect(() => {
    if (pane?.url && pane.url !== urlRef.current) {
      setUrl(pane.url);
      invoke("browser_navigate", { paneId, url: pane.url }).catch(() => {});
    }
  }, [pane?.url]);

  useEffect(() => {
    invoke("browser_set_annotate", { paneId, enabled: annotate }).catch(() => {});
  }, [paneId, annotate]);

  const navigate = (text: string) => {
    const next = normalizeUrl(text);
    setDraft(null);
    setUrl(next);
    invoke("browser_navigate", { paneId, url: next }).catch((e) => notify("error", String(e)));
    rpc("browser_navigate", { pane_id: paneId, url: next }).catch(() => {});
  };

  const send = async (agentPaneId: Id, label: string) => {
    if (!pane) return;
    const { count, markdown } = feedback;
    const bundle: EvidenceBundle = { source: "browser feedback", worktree_id: pane.worktree_id, url, action_id: null, annotations: [], instruction: INSTRUCTION, markdown, note_count: count };
    try {
      await rpc("annotations_send", { pane_id: agentPaneId, bundle });
      setFeedback(NO_FEEDBACK);
      invoke("browser_clear_annotations", { paneId }).catch(() => {});
      notify("info", `Sent ${notes(count)} to ${label}`);
    } catch (e) {
      notify("error", (e as Error).message);
    }
  };

  const copyFeedback = () => copyText(feedback.markdown, "Feedback");

  const sendItems = (): MenuItem[] => [
    ...(agents.length ? agents.map((a) => ({ label: `${KIND_LABEL[a.kind]} — ${a.state}`, run: () => send(a.pane_id, KIND_LABEL[a.kind]) })) : [{ label: "no live agent in this worktree", disabled: true }]),
    { separator: true },
    { label: "Copy as markdown", run: copyFeedback },
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
          <IconButton label={annotate ? "Stop annotating" : "Annotate"} className={annotate ? "browser-annotate-on" : undefined} aria-pressed={annotate} onClick={() => setAnnotate((v) => !v)}>
            <MessageSquarePlus className="icon" />
          </IconButton>
          {feedback.count > 0 && (
            <>
              <span className="browser-count" title={notes(feedback.count)}>
                {feedback.count}
              </span>
              <IconButton label="Copy feedback" onClick={copyFeedback}>
                <Copy className="icon" />
              </IconButton>
              <DropdownMenu open={sendOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger render={<IconButton label="Send feedback to an agent" />}>
                  <SendHorizontal className="icon" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <MenuItems items={sendItems} />
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <IconButton label="Open in external browser" className="browser-external" onClick={() => openExternalUrl(url)}>
            <ExternalLink className="icon" />
          </IconButton>
        </div>
        <div className="browser-host" ref={hostRef} />
      </div>
    </div>
  );
}
