import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { useEffect, useRef } from "react";
import { decodeBase64, rpcParsed } from "./api";
import { focusPane, runAction, wakePane } from "./actions";
import { findAction } from "./keys";
import { paneSnapshotSchema } from "./schemas";
import { failQuietly, getState, keyBindings, useStore } from "./store";
import { registerTerminal } from "./terminals";
import { useResolvedTheme, xtermTheme } from "./theme";
import type { Id } from "./types";

const HIDE_CURSOR = "\x1b[?25l";

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** A key press wakes the agent, and is not sent. A modifier alone, a Cmd chord, and an app shortcut do not wake it. */
export function wakesOnKey(e: Pick<KeyboardEvent, "key" | "metaKey">): boolean {
  return !MODIFIERS.has(e.key) && !e.metaKey;
}

/** A click wakes the agent; a drag that selects text does not. */
export const CLICK_SLOP_PX = 4;

/**
 * The pane of a sleeping agent: its terminal as it was, in a read-only xterm that you can scroll, select, copy,
 * and search. See docs/sleeping-agents.md.
 */
export function SleepView({ paneId, waking, active }: { paneId: Id; waking: boolean; active: boolean }) {
  const config = useStore((s) => s.config);
  const theme = useResolvedTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wakingRef = useRef(waking);
  wakingRef.current = waking;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !config) return;
    const term = new Terminal({
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      fontFamily: config.font_family,
      fontSize: config.font_size,
      scrollback: config.scrollback_lines,
      macOptionIsMeta: true,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(host);
    termRef.current = term;
    const unregister = registerTerminal(paneId, { term, el: host, focus: () => term.focus() });
    const wake = () => {
      if (!wakingRef.current) wakePane(paneId);
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return false;
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
      if (wakesOnKey(e)) {
        e.preventDefault();
        wake();
      }
      return false;
    });
    let down: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY };
      void focusPane(paneId);
    };
    const onUp = (e: MouseEvent) => {
      const click = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_SLOP_PX;
      down = null;
      if (click && e.button === 0 && !term.hasSelection()) wake();
    };
    host.addEventListener("mousedown", onDown);
    host.addEventListener("mouseup", onUp);
    let live = true;
    rpcParsed("pane_snapshot", paneSnapshotSchema, { pane_id: paneId })
      .then((snap) => {
        if (!live) return;
        const rows = fit.proposeDimensions()?.rows ?? snap.rows;
        term.resize(Math.max(2, snap.cols), Math.max(2, rows));
        term.write(decodeBase64(snap.data_base64));
        term.write(HIDE_CURSOR);
      })
      .catch(failQuietly("pane_snapshot"));
    return () => {
      live = false;
      host.removeEventListener("mousedown", onDown);
      host.removeEventListener("mouseup", onUp);
      unregister();
      term.dispose();
      termRef.current = null;
    };
  }, [paneId, config?.font_family, config?.font_size, config?.scrollback_lines]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(theme);
  }, [theme]);

  return (
    <div className="pane-body pane-asleep">
      <div className={waking ? "pane-sleep-bar pane-sleep-bar-waking" : "pane-sleep-bar"} role="status">
        {waking ? "waking…" : "asleep · a key or a click wakes the agent"}
      </div>
      <div className="pane-snapshot" ref={hostRef} />
    </div>
  );
}
