import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { useEffect, useRef, useState } from "react";
import { encodeBase64, onPaneOutput, rpc } from "./api";
import { applyZoom, closePane, focusPane, runAction, splitPaneById } from "./actions";
import { keyOverride, zoomKey } from "./appearance";
import { useResolvedTheme, xtermTheme } from "./theme";
import { findAction } from "./keys";
import {failQuietly, getState, keyBindings, splitsAllowed, useStore} from "./store";
import { registerTerminal } from "./terminals";
import { listenFileDrop, registerTerminalLinks } from "./terminalHooks";
import { Columns2, Rows2, X } from "lucide-react";
import { openMenu } from "./MenuHost";
import { IconButton } from "./components/ui";
import { isLastPane, paneMenu } from "./menus";
import { ProcessIcon } from "./ProcessIcon";
import { useShortcuts } from "./shortcuts";
import { PaneDropZone, usePaneDrag } from "./LayoutDnd";
import type { Id } from "./types";
import "@xterm/xterm/css/xterm.css";

export function TerminalPane({ paneId, active }: { paneId: Id; active: boolean }) {
  const pane = useStore((s) => s.panes[paneId]);
  const zoomed = useStore((s) => !!pane && s.zoomed[pane.tab_id] === paneId);
  const config = useStore((s) => s.config);
  const theme = useResolvedTheme();
  const connectionNonce = useStore((s) => s.connectionNonce);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [oscTitle, setOscTitle] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !config) return;
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: config.font_family,
      fontSize: config.font_size,
      scrollback: config.scrollback_lines,
      cursorBlink: true,
      macOptionIsMeta: true,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(host);
    const links = registerTerminalLinks(term, paneId);
    const stopFileDrop = listenFileDrop(host, paneId);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
    termRef.current = term;
    const unregister = registerTerminal(paneId, { term, el: host });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const zoom = zoomKey(e);
      if (zoom) {
        e.preventDefault();
        applyZoom(zoom);
        return false;
      }
      const override = keyOverride(e);
      if (override !== null) {
        e.preventDefault();
        rpc("pane_send", { pane_id: paneId, data_base64: encodeBase64(override) }).catch(failQuietly("pane_send"));
        return false;
      }
      const action = findAction(e, keyBindings(getState()));
      if (action) {
        e.preventDefault();
        runAction(action);
        return false;
      }
      if (e.metaKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (e.metaKey && e.key.toLowerCase() === "v") {
        navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
        return false;
      }
      return true;
    });

    const send = (data: string) => rpc("pane_send", { pane_id: paneId, data_base64: encodeBase64(data) }).catch(failQuietly("pane_send"));
    term.onData(send);
    term.onBinary((data) => rpc("pane_send", { pane_id: paneId, data_base64: btoa(data) }).catch(failQuietly("pane_send")));
    term.onResize(({ cols, rows }) => rpc("pane_resize", { pane_id: paneId, cols, rows }).catch(failQuietly("pane_resize")));
    term.onTitleChange((t) => setOscTitle(t || null));
    term.onSelectionChange(() => {
      if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    });

    const unsub = onPaneOutput(paneId, (bytes) => term.write(bytes));
    let raf = 0;
    let settle = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        raf = requestAnimationFrame(() => {
          if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
          fit.fit();
          const screen = host.querySelector(".xterm-screen");
          const limit = host.getBoundingClientRect().bottom - parseFloat(getComputedStyle(host).paddingBottom);
          if (screen && screen.getBoundingClientRect().bottom > limit + 0.5 && term.rows > 2) term.resize(term.cols, term.rows - 1);
        });
      }, 90);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    fit.fit();
    rpc("pane_attach", { pane_id: paneId }).catch(failQuietly("pane_attach"));
    const onFocus = () => focusPane(paneId);
    host.addEventListener("mousedown", onFocus);

    return () => {
      host.removeEventListener("mousedown", onFocus);
      links.dispose();
      stopFileDrop();
      observer.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      unsub();
      unregister();
      rpc("pane_detach", { pane_id: paneId }).catch(failQuietly("pane_detach"));
      term.dispose();
      termRef.current = null;
    };
  }, [paneId, connectionNonce, config?.font_family, config?.font_size, config?.scrollback_lines]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(theme);
  }, [theme]);

  const agent = pane?.agent && pane.agent.state !== "exited" ? pane.agent : null;
  const title = pane?.user_title ?? (agent ? agent.kind : (oscTitle ?? pane?.title ?? ""));
  const originNote = pane?.origin === "resumed" ? "resumed" : pane?.origin === "restored" ? "restored" : null;
  const stateClass = agent ? `state-${agent.state}` : pane && !pane.live ? "state-exited" : "state-none";
  const lastPane = useStore(() => isLastPane(paneId));
  const shortcut = useShortcuts();
  const splits = useStore(splitsAllowed);
  const drag = usePaneDrag(paneId, pane?.tab_id ?? "", title, splits);
  return (
    <div className="pane-wrap">
    <div className={`pane${active ? " pane-active" : ""}${pane && !pane.live ? " pane-dead" : ""}`}>
      <div className="pane-legend" onMouseDown={() => focusPane(paneId)} onContextMenu={(e) => openMenu(e, paneMenu(paneId))}>
        <span className={splits ? "chip pane-grip" : "chip"} ref={drag.ref} {...drag.props}>
          <span className={`state ${stateClass}`} />
          <ProcessIcon agent={agent?.kind} cmd={pane?.process_cmd} />
          <strong>{title}</strong>
          {agent && <span className="agent-state">{agent.state}</span>}
          {zoomed && <span className="pane-note pane-zoomed" title="Only this pane is shown. Press the zoom key again to unzoom.">zoomed</span>}
          {originNote && <span className="pane-note" title="This pane was rebuilt after a daemon restart">{originNote}</span>}
          {pane && !pane.live && <span className="pane-note">exited {pane.exit_code ?? ""}</span>}
        </span>
        <span className="chip right" title={pane?.cwd}>
          <span>{shortPath(pane?.cwd ?? "")}</span>
          {splits && <IconButton label="Split right" shortcut={active ? shortcut("new_terminal") : undefined} onClick={() => splitPaneById(paneId, "horizontal")}><Columns2 className="icon" /></IconButton>}
          {splits && <IconButton label="Split down" shortcut={active ? shortcut("split_vertical") : undefined} onClick={() => splitPaneById(paneId, "vertical")}><Rows2 className="icon" /></IconButton>}
          {!lastPane && <IconButton label="Close pane" shortcut={active ? shortcut("close_pane") : undefined} onClick={() => closePane(paneId)}><X className="icon" /></IconButton>}
        </span>
      </div>
      <div className="pane-body" ref={hostRef} />
      {splits && <PaneDropZone paneId={paneId} />}
    </div>
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
}
