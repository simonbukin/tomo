import type { IDisposable, Terminal } from "@xterm/xterm";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openEndpoint } from "./actions";
import { encodeBase64, rpc } from "./api";
import { containsPoint, cssPoint, dropText } from "./fileDrop";
import { findLinks, resolvePath, type TermLink } from "./links";
import { failToast, getState } from "./store";
import { focusTerminal } from "./terminals";
import type { Id } from "./types";

async function openLink(link: TermLink, paneId: Id): Promise<void> {
  const pane = getState().panes[paneId];
  if (!pane) return;
  if (link.kind === "url") return openEndpoint(link.url, pane.worktree_id);
  const home = link.path.startsWith("~/") ? await homeDir().catch(() => null) : null;
  const path = resolvePath(link.path, pane.cwd, home);
  if (path) await rpc("open_location", { path, line: link.line, col: link.col }).catch(failToast("Could not open the file"));
}

/** Cmd-click opens a URL in the worktree browser and a `path:line` in the editor. A plain click does nothing. */
export function registerTerminalLinks(term: Terminal, paneId: Id): IDisposable {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      // ponytail: string offsets equal cell columns only without wide characters, and wrapped lines are not joined.
      const links = findLinks(text).map((link) => ({
        range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
        text: text.slice(link.start, link.end),
        activate: (e: MouseEvent) => {
          if (e.metaKey) void openLink(link, paneId);
        },
      }));
      callback(links.length ? links : undefined);
    },
  });
}

/** Types the shell-escaped paths of Finder files dropped on this pane. Returns the unlisten function. */
export function listenFileDrop(host: HTMLElement, paneId: Id): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  try {
    getCurrentWebview()
      .onDragDropEvent(async ({ payload }) => {
        if (payload.type !== "drop" || !payload.paths.length) return;
        const scale = await getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio);
        if (!containsPoint(host.getBoundingClientRect(), cssPoint(payload.position, scale, getState().ui.appearance.zoom))) return;
        await rpc("pane_send", { pane_id: paneId, data_base64: encodeBase64(dropText(payload.paths)) }).catch(() => {});
        focusTerminal(paneId);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
  } catch {}
  return () => {
    disposed = true;
    unlisten?.();
  };
}
