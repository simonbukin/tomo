import { useEffect, useState } from "react";
import { BottomStrip } from "../shell/BottomStrip";
import { getState, setState } from "../store";
import { TerminalPane } from "../TerminalPane";
import { getTerminal } from "../terminals";
import type { Config, Pane } from "../types";

const PANE: Pane = {
  id: "lab",
  tab_id: "t1",
  worktree_id: "w1",
  title: "zsh",
  user_title: null,
  cwd: "/Users/you/Projects/tomo",
  cols: 80,
  rows: 24,
  pid: null,
  live: true,
  origin: "live",
  exit_code: null,
  agent: null,
  created_at_ms: 0,
  source: null,
  process_cmd: null,
  kind: "terminal",
  url: null,
};

const config = (scheme: "dark" | "light") =>
  ({ font_family: "Menlo, monospace", font_size: 13, scrollback_lines: 1000, editor_command: [], keybindings: {}, theme: { name: `slab-${scheme}`, light: "slab-light", dark: "slab-dark", colors: {} } }) as unknown as Config;

declare global {
  interface Window {
    lab?: { write: (text: string) => void; size: (width: number, height: number) => void; theme: (scheme: "dark" | "light") => void };
  }
}

/**
 * Dev-only fixture: one real terminal pane in a box of a set size, above the bottom strip.
 * Open the dev server with `#terminal-lab`. `window.lab` writes text and resizes the box.
 */
export function TerminalLab() {
  const [ready, setReady] = useState(false);
  const [box, setBox] = useState({ width: 900, height: 420 });
  useEffect(() => {
    setState({
      ...getState(),
      loaded: true,
      connected: true,
      config: config("dark"),
      panes: { [PANE.id]: PANE },
      system: { at_ms: 0, cpu_percent: 23, memory_used_bytes: 21e9, memory_total_bytes: 64e9, gpu_percent: 7, vram_used_bytes: null, vram_total_bytes: null, daemon_rss_bytes: 0, top_worktree: null },
    });
    window.lab = {
      write: (text) => getTerminal(PANE.id)?.term.write(text),
      size: (width, height) => setBox({ width, height }),
      theme: (scheme) => {
        document.documentElement.dataset.theme = scheme;
        setState({ config: config(scheme) });
      },
    };
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", ["--left-col" as string]: "240px", ["--right-col" as string]: "280px" }}>
      <div className="lab-box" style={{ display: "flex", width: box.width, height: box.height, boxShadow: "0 0 0 1px var(--line)" }}>
        <TerminalPane paneId={PANE.id} active />
      </div>
      <div style={{ flex: 1 }} />
      <BottomStrip left="open" />
    </div>
  );
}
