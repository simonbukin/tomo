import { useEffect, useRef, useState } from "react";
import { onFrame, rpc } from "./api";
import { focusPane, openWorktree, spawnAgent } from "./actions";
import { openFile } from "./editor/editor";
import { DEBOUNCE_MS, pendingFor, SOURCES, type Results, type Scope } from "./searchModel";
import { failQuietly, getState, setUi } from "./store";
import { findInTerminal } from "./terminals";
import type { SearchHit, SearchSource } from "./generated";
import type { Id } from "./types";

interface SearchFrame {
  query_id: number;
  source: SearchSource;
  hits: SearchHit[];
  total: number;
  done: boolean;
}

/**
 * The daemon results of the query on screen. It sends `search` after the typing pauses, keeps only the frames of
 * the newest query, and sends an empty query when the palette opens (to fill the daemon caches) and when it closes
 * (to cancel).
 */
export function useSearch(open: boolean, scope: Scope, text: string, worktreeId: Id | null, limit: number): Results {
  const [results, setResults] = useState<Results>({});
  const queryId = useRef(0);

  useEffect(
    () =>
      onFrame((f) => {
        if (f.event !== "search_results") return;
        const d = f.data as SearchFrame;
        if (d.query_id === queryId.current) setResults((r) => ({ ...r, [d.source]: { hits: d.hits, total: d.total, done: d.done } }));
      }),
    [],
  );

  useEffect(() => {
    const sources = SOURCES[scope];
    const query = open && sources.length > 0 ? text : "";
    const id = queryId.current + 1;
    queryId.current = id;
    setResults((r) => (query ? pendingFor(r, sources) : {}));
    const send = () => void rpc("search", { query_id: id, query, sources, limit, worktree_id: worktreeId }).catch(failQuietly("search"));
    if (!query) {
      if (open || id > 1) send();
      return;
    }
    const timer = window.setTimeout(send, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, scope, text, worktreeId, limit]);

  return results;
}

async function revealPane(paneId: Id): Promise<boolean> {
  const pane = getState().panes[paneId];
  if (!pane) return false;
  const ui = getState().ui;
  if (ui.view !== "worktree" || ui.activeWorktreeId !== pane.worktree_id) await openWorktree(pane.worktree_id);
  await focusPane(paneId);
  return true;
}

const FIND_WAITS_MS = [120, 400, 1000];

/** A terminal that was not on screen mounts and replays its scrollback first, so the find tries a few times. */
async function findSoon(paneId: Id, text: string): Promise<void> {
  for (const wait of FIND_WAITS_MS) {
    await new Promise((r) => window.setTimeout(r, wait));
    if (await findInTerminal(paneId, text)) return;
  }
}

export async function openHit(hit: SearchHit, text: string): Promise<void> {
  const t = hit.target;
  switch (t.kind) {
    case "file":
      await openFile(t.worktree_id, t.path, t.line ? { line: t.line, col: null } : null);
      return;
    case "pane":
      if (await revealPane(t.pane_id)) await findSoon(t.pane_id, text);
      return;
    case "session":
      if (t.pane_id && (await revealPane(t.pane_id))) return;
      await spawnAgent(t.agent, t.worktree_id, { resume: t.session_id, newTab: true });
      return;
    case "activity":
      if (t.pane_id && (await revealPane(t.pane_id))) return;
      if (t.worktree_id) return openWorktree(t.worktree_id);
      setUi({ view: "activity" });
  }
}
