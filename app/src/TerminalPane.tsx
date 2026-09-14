import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { encodeBase64, onPaneOutput, rpc } from "./api";
import { closePane, focusPane, runAction } from "./actions";
import { findAction } from "./keys";
import { getState, useStore } from "./store";
import { registerTerminal } from "./terminals";
import { KIND_LABEL, STATE_GLYPH, type Id } from "./types";
import "@xterm/xterm/css/xterm.css";

const DARK = { background: "#0f1115", foreground: "#d6d8de", cursor: "#d6d8de", selectionBackground: "#2c3446" };
const LIGHT = { background: "#ffffff", foreground: "#1d1f24", cursor: "#1d1f24", selectionBackground: "#c9d4ea" };

function isDark(theme: string): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function TerminalPane({ paneId, active }: { paneId: Id; active: boolean }) {
  const pane = useStore((s) => s.panes[paneId]);
  const config = useStore((s) => s.config);
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
      theme: isDark(config.theme) ? DARK : LIGHT,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri).catch(() => {})));
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
    termRef.current = term;
    const unregister = registerTerminal(paneId, { term, el: host });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const action = findAction(e, getState().config?.keybindings ?? {});
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

    const send = (data: string) => rpc("pane_send", { pane_id: paneId, data_base64: encodeBase64(data) }).catch(() => {});
    term.onData(send);
    term.onBinary((data) => rpc("pane_send", { pane_id: paneId, data_base64: btoa(data) }).catch(() => {}));
    term.onResize(({ cols, rows }) => rpc("pane_resize", { pane_id: paneId, cols, rows }).catch(() => {}));
    term.onTitleChange((t) => setOscTitle(t || null));
    term.onSelectionChange(() => {
      if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    });

    const unsub = onPaneOutput(paneId, (bytes) => term.write(bytes));
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    fit.fit();
    rpc("pane_attach", { pane_id: paneId }).catch(() => {});
    const onFocus = () => focusPane(paneId);
    host.addEventListener("mousedown", onFocus);

    return () => {
      host.removeEventListener("mousedown", onFocus);
      observer.disconnect();
      cancelAnimationFrame(raf);
      unsub();
      unregister();
      rpc("pane_detach", { pane_id: paneId }).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, [paneId, config?.font_family, config?.font_size, config?.theme, config?.scrollback_lines]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  const agent = pane?.agent && pane.agent.state !== "exited" ? pane.agent : null;
  const title = pane?.user_title ?? (agent ? KIND_LABEL[agent.kind] : oscTitle ?? pane?.title ?? "");
  const originNote = pane?.origin === "resumed" ? "resumed" : pane?.origin === "restored" ? "restored" : null;
  return (
    <div className={`pane${active ? " pane-active" : ""}${pane && !pane.live ? " pane-dead" : ""}`}>
      <div className="pane-header" onMouseDown={() => focusPane(paneId)}>
        {agent && <span className={`dot dot-${agent.state}`} title={`${KIND_LABEL[agent.kind]} ${agent.state}`}>{STATE_GLYPH[agent.state]}</span>}
        <span className="pane-title">{title}</span>
        {agent && <span className="pane-sub">{agent.state}</span>}
        {originNote && <span className="pane-sub" title="This pane was rebuilt after a daemon restart">{originNote}</span>}
        {pane && !pane.live && <span className="pane-sub">exited {pane.exit_code ?? ""}</span>}
        <span className="pane-cwd" title={pane?.cwd}>{shortPath(pane?.cwd ?? "")}</span>
        <button className="pane-close" title="Close pane" onClick={() => closePane(paneId)}>×</button>
      </div>
      <div className="pane-body" ref={hostRef} />
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}
