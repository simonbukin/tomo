import { useEffect, useState } from "react";
import { runAction } from "../actions";
import { Dialogs } from "../Dialogs";
import { findAction } from "../keys";
import { TabLayout } from "../Layout";
import { LayoutDnd } from "../LayoutDnd";
import { Palette } from "../Palette";
import { getState, keyBindings, setState, useStore } from "../store";
import { TabBar } from "../Tabs";
import type { Config, Pane, Tab, Worktree } from "../types";
import { aPane, aWorktree } from "../test-fixtures";
import { getSession } from "../editor/sessions";

const ROOT = "/Users/you/tomo/worktrees/tomo/kobe";

const RUST = `use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A worktree that Tomo knows about.
#[derive(Debug, Clone)]
pub struct Worktree {
    pub id: String,
    pub path: PathBuf,
    pub branch: Option<String>,
}

const MAX_BYTES: u64 = 2 * 1024 * 1024;

impl Worktree {
    pub fn new(id: &str, path: &Path) -> Self {
        Self { id: id.to_string(), path: path.to_path_buf(), branch: None }
    }

    // Counts the files under the root, skipping .git.
    pub fn count(&self) -> usize {
        let mut seen: HashMap<String, bool> = HashMap::new();
        for entry in std::fs::read_dir(&self.path).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != ".git" && entry.metadata().map_or(false, |m| m.len() < MAX_BYTES) {
                seen.insert(name, true);
            }
        }
        seen.len()
    }
}
`;

const normal = Array.from({ length: 12 }, (_, i) => RUST.replace("Worktree", `Worktree${i || ""}`)).join("\n");

type Disk = Map<string, { text: string; version: number } | "binary">;

const disk: Disk = new Map<string, { text: string; version: number } | "binary">([
  ["src/main.rs", { text: RUST, version: 1 }],
  ["src/normal.rs", { text: normal, version: 1 }],
  ["data/big.json", { text: JSON.stringify(Array.from({ length: 16000 }, (_, i) => ({ id: i, name: `row ${i}`, tags: ["a", "b"], ok: i % 3 === 0 })), null, 1), version: 1 }],
  ["logo.png", "binary"],
]);

const fail = (code: string, message: string) => Promise.reject({ code, message });

async function fakeRpc(method: string, p: Record<string, unknown>): Promise<unknown> {
  const path = p.path as string;
  const f = disk.get(path);
  if (method === "fs_read") {
    if (!f) return fail("not_found", `${path} does not exist`);
    if (f === "binary") return fail("unsupported", `${path} is a binary file; the editor opens UTF-8 text only`);
    return { path, content: f.text, version: `v${f.version}`, mtime_ms: 0 };
  }
  if (method === "fs_write") {
    const current = f && f !== "binary" ? `v${f.version}` : null;
    if (current !== p.expected_version) return fail("conflict", `${path} changed on disk since it was read`);
    const version = (f && f !== "binary" ? f.version : 0) + 1;
    disk.set(path, { text: p.content as string, version });
    return { version: `v${version}`, mtime_ms: 0 };
  }
  if (method === "fs_recent") return [...disk.keys()].map((rel) => ({ name: rel.split("/").pop(), rel_path: rel, is_dir: false, size: 1, modified_ms: 0 }));
  return null;
}

declare global {
  interface Window {
    editorLab?: {
      agentWrite: (path: string, text: string) => void;
      remove: (path: string) => void;
      disk: (path: string) => string | undefined;
      theme: (scheme: "dark" | "light") => void;
      show: (tab: string) => void;
      selection: (paneId: string) => unknown;
    };
  }
}

const editor = (id: string, tab: string, path: string): Pane => aPane({ id, tab_id: tab, title: path.split("/").pop()!, cwd: ROOT, kind: "editor", editor: { path, line: 14, col: 5 } });

const tab = (id: string, title: string, position: number, layout: Tab["layout"], active: string): Tab => ({ id, worktree_id: "w1", title, position, is_active: position === 0, active_pane_id: active, layout });

const TABS: Tab[] = [
  tab("t1", "main.rs", 0, { type: "split", id: "s1", direction: "horizontal", ratio: 0.55, first: { type: "leaf", pane_id: "e1" }, second: { type: "leaf", pane_id: "e2" } }, "e1"),
  tab("t2", "normal.rs", 1, { type: "leaf", pane_id: "e3" }, "e3"),
  tab("t3", "big.json", 2, { type: "leaf", pane_id: "e4" }, "e4"),
  tab("t4", "logo.png", 3, { type: "leaf", pane_id: "e5" }, "e5"),
];

const config = (scheme: "dark" | "light") =>
  ({ font_family: "Menlo, monospace", font_size: 13, scrollback_lines: 1000, max_panes_per_tab: 4, editor_command: ["zed", "{path}"], keybindings: { editor_save: "mod+s", open_file: "mod+p", close_pane: "mod+w", palette: "mod+k", new_terminal: "mod+d", next_tab: "mod+shift+right", prev_tab: "mod+shift+left" }, theme: { name: `slab-${scheme}`, light: "slab-light", dark: "slab-dark", colors: {} } }) as unknown as Config;

/**
 * Dev-only fixture: editor panes on a fake disk, with no daemon. Open the dev server with `#editor-lab`.
 * `window.editorLab` changes the disk the way an agent does, so the reload and conflict paths show.
 */
export function EditorLab() {
  const [ready, setReady] = useState(false);
  const active = useStore((s) => s.tabs.w1?.find((t) => t.is_active) ?? null);
  useEffect(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: (cmd: string, args: { method: string; params: Record<string, unknown> }) => (cmd === "rpc" ? fakeRpc(args.method, args.params ?? {}) : Promise.resolve(null)) };
    const w: Worktree = aWorktree({ id: "w1", name: "kobe", path: ROOT });
    const panes = [editor("e1", "t1", "src/main.rs"), editor("e2", "t1", "notes/todo.md"), editor("e3", "t2", "src/normal.rs"), editor("e4", "t3", "data/big.json"), editor("e5", "t4", "logo.png")];
    setState({
      ...getState(),
      loaded: true,
      connected: true,
      config: config("dark"),
      worktrees: [w],
      tabs: { w1: TABS },
      panes: Object.fromEntries(panes.map((p) => [p.id, p])),
      ui: { ...getState().ui, view: "worktree", activeWorktreeId: "w1" },
    });
    const change = async (path: string) => (await import("../editor/cm")).fileChanged("w1", path);
    window.editorLab = {
      agentWrite: (path, text) => {
        const f = disk.get(path);
        disk.set(path, { text, version: (f && f !== "binary" ? f.version : 0) + 1 });
        void change(path);
      },
      remove: (path) => {
        disk.delete(path);
        void change(path);
      },
      disk: (path) => {
        const f = disk.get(path);
        return f && f !== "binary" ? f.text : undefined;
      },
      theme: (scheme) => {
        document.documentElement.dataset.theme = scheme;
        setState({ config: config(scheme) });
      },
      selection: (paneId) => getSession(paneId)?.view?.state.selection.toJSON(),
      show: (id) => setState((s) => ({ tabs: { w1: (s.tabs.w1 ?? []).map((t) => ({ ...t, is_active: t.id === id })) } })),
    };
    const onKey = (e: KeyboardEvent) => {
      const action = findAction(e, keyBindings(getState()));
      if (!action) return;
      e.preventDefault();
      runAction(action);
    };
    window.addEventListener("keydown", onKey);
    setReady(true);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!ready) return null;
  return (
    <LayoutDnd>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
        <TabBar worktreeId="w1" />
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>{active && <TabLayout tab={active} />}</div>
        <Palette />
        <Dialogs />
      </div>
    </LayoutDnd>
  );
}
