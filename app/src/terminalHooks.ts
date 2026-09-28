import type { ILink, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { openEndpoint } from "./actions";
import { encodeBase64, rpc } from "./api";
import { containsPoint, cssPoint, dropText } from "./fileDrop";
import { candidatePaths, findLinks, type TermLink } from "./links";
import type { MenuItem } from "./components/ui";
import { openMenu } from "./MenuHost";
import {failQuietly, failToast, getState} from "./store";
import { focusTerminal } from "./terminals";
import type { Id } from "./types";

let home: Promise<string | null> | null = null;
const homePath = () => (home ??= homeDir().catch(() => null));

/**
 * The links that can open, with each file path made absolute. A file link stays only when the daemon
 * finds one of its candidate paths on disk: from the pane cwd first, then from the worktree root.
 */
async function resolveLinks(links: TermLink[], paneId: Id): Promise<TermLink[]> {
  const pane = getState().panes[paneId];
  if (!pane) return [];
  const root = getState().worktrees.find((w) => w.id === pane.worktree_id)?.path ?? null;
  const tilde = links.some((l) => l.kind === "file" && l.path.startsWith("~/")) ? await homePath() : null;
  const candidates = links.map((l) => (l.kind === "file" ? candidatePaths(l.path, pane.cwd, root, tilde) : []));
  const paths = [...new Set(candidates.flat())];
  const exists = paths.length ? await rpc<boolean[]>("paths_exist", { paths }).catch(() => []) : [];
  const found = new Set(paths.filter((_, i) => exists[i] === true));
  return links.flatMap((link, i): TermLink[] => {
    if (link.kind === "url") return [link];
    const path = candidates[i].find((p) => found.has(p));
    return path ? [{ ...link, path }] : [];
  });
}

function openLink(link: TermLink, paneId: Id): void {
  const pane = getState().panes[paneId];
  if (link.kind === "url") return openEndpoint(link.url, pane?.worktree_id);
  rpc("open_location", { path: link.path, line: link.line, col: link.col }).catch(failToast("Could not open the file"));
}

const copy = (text: string) => navigator.clipboard.writeText(text).catch(failToast("Could not copy"));

function linkMenu(link: TermLink, paneId: Id): MenuItem[] {
  if (link.kind === "url") {
    return [
      { label: "Open in pane", run: () => openEndpoint(link.url, getState().panes[paneId]?.worktree_id) },
      { label: "Open in browser", run: () => openEndpoint(link.url) },
      { separator: true },
      { label: "Copy link", run: () => void copy(link.url) },
    ];
  }
  return [
    { label: "Open in editor", run: () => openLink(link, paneId) },
    { label: "Reveal in Finder", run: () => void revealItemInDir(link.path).catch(failToast("Could not reveal the file")) },
    { separator: true },
    { label: "Copy path", run: () => void copy(link.path) },
  ];
}

/**
 * URLs and existing file paths in the terminal. Cmd-hover underlines one, Cmd-click opens it: a URL
 * in the worktree browser, a file in the editor at its line. Right-click gives a menu. Returns the disposer.
 */
export function registerTerminalLinks(term: Terminal, paneId: Id, host: HTMLElement): () => void {
  let meta = false;
  let shown: ILink[] = [];
  let hovered: TermLink | null = null;
  const setMeta = (on: boolean) => {
    if (on === meta) return;
    meta = on;
    shown.forEach((l) => {
      if (!l.decorations) return;
      l.decorations.underline = on;
      l.decorations.pointerCursor = on;
    });
  };
  const onKey = (e: KeyboardEvent | MouseEvent) => setMeta(e.metaKey);
  const onBlur = () => setMeta(false);
  const onMenu = (e: MouseEvent) => {
    if (hovered) openMenu(e, linkMenu(hovered, paneId));
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", onBlur);
  host.addEventListener("mousemove", onKey);
  host.addEventListener("contextmenu", onMenu, true);
  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const found = findLinks(text);
      if (!found.length) return callback(undefined);
      void resolveLinks(found, paneId).then((links) => {
        // ponytail: string offsets equal cell columns only without wide characters, and wrapped lines are not joined.
        shown = links.map((link) => ({
          range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
          text: text.slice(link.start, link.end),
          decorations: { underline: meta, pointerCursor: meta },
          activate: (e: MouseEvent) => {
            if (e.metaKey) openLink(link, paneId);
          },
          hover: () => {
            hovered = link;
          },
          leave: () => {
            hovered = null;
          },
        }));
        callback(shown.length ? shown : undefined);
      });
    },
  });
  return () => {
    provider.dispose();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    window.removeEventListener("blur", onBlur);
    host.removeEventListener("mousemove", onKey);
    host.removeEventListener("contextmenu", onMenu, true);
  };
}

/** Types the shell-escaped paths of Finder files dropped on this pane. Returns the unlisten function. */
export function listenFileDrop(host: HTMLElement, paneId: Id): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  try {
    getCurrentWebview()
      .onDragDropEvent(async ({ payload }) => {
        if (payload.type !== "drop" || !payload.paths.length) return;
        if (!containsPoint(host.getBoundingClientRect(), cssPoint(payload.position, getState().ui.appearance.zoom))) return;
        await rpc("pane_send", { pane_id: paneId, data_base64: encodeBase64(dropText(payload.paths)) }).catch(failQuietly("pane_send"));
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

/**
 * Pastes the clipboard text. With no text but an image, pastes the path of a PNG copy of the image,
 * which Claude Code, Codex, and other agents attach like a dropped file. A shell gets a plain path.
 */
export async function pasteClipboard(term: Pick<Terminal, "paste">): Promise<void> {
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) return term.paste(text);
  const image = await invoke<string | null>("clipboard_image").catch(() => null);
  if (image) term.paste(dropText([image]));
}
