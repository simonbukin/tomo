import type { IBufferRange, ILink, Terminal } from "@xterm/xterm";
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
import { openFile, worktreeRelative } from "./editor/editor";
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

type FileLink = Extract<TermLink, { kind: "file" }>;

const openInExternalEditor = (link: FileLink) => rpc("open_location", { path: link.path, line: link.line, col: link.col }).catch(failToast("Could not open the file"));

/** The worktree of the pane when the file is inside it: only such a file opens in an editor pane. */
function editorWorktree(link: FileLink, paneId: Id): Id | null {
  const pane = getState().panes[paneId];
  const root = getState().worktrees.find((w) => w.id === pane?.worktree_id)?.path;
  return pane && root && worktreeRelative(root, link.path) !== null ? pane.worktree_id : null;
}

function openInPane(link: FileLink, worktreeId: Id): void {
  void openFile(worktreeId, link.path, link.line ? { line: link.line, col: link.col } : null);
}

/** A file inside the worktree opens in an editor pane; any other file opens in the external editor. */
function openLink(link: TermLink, paneId: Id): void {
  if (link.kind === "url") return openEndpoint(link.url, getState().panes[paneId]?.worktree_id);
  const worktreeId = editorWorktree(link, paneId);
  if (worktreeId) openInPane(link, worktreeId);
  else void openInExternalEditor(link);
}

const copy = (text: string) => navigator.clipboard.writeText(text).catch(failToast("Could not copy"));

function linkMenu(link: TermLink, paneId: Id): MenuItem[] {
  if (link.kind === "url") {
    return [
      { label: "open in pane", run: () => openEndpoint(link.url, getState().panes[paneId]?.worktree_id) },
      { label: "open in external browser", run: () => openEndpoint(link.url) },
      { separator: true },
      { label: "copy link", run: () => void copy(link.url) },
    ];
  }
  const worktreeId = editorWorktree(link, paneId);
  return [
    ...(worktreeId ? [{ label: "open in pane", run: () => openInPane(link, worktreeId) }] : []),
    { label: "open in editor", run: () => void openInExternalEditor(link) },
    { label: "reveal in finder", run: () => void revealItemInDir(link.path).catch(failToast("Could not reveal the file")) },
    { separator: true },
    { label: "copy path", run: () => void copy(link.path) },
  ];
}

/**
 * The dotted underline of a link under a plain hover. xterm draws only a solid underline, and the WebGL
 * renderer draws it on its canvas, so this line is an element over the cells of the link.
 */
function linkHint(term: Terminal): { show: (range: IBufferRange) => void; hide: () => void } {
  const hint = document.createElement("div");
  hint.className = "term-link-hint";
  return {
    show: (range) => {
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      const cell = { width: screen.clientWidth / term.cols, height: screen.clientHeight / term.rows };
      const row = range.start.y - 1 - term.buffer.active.viewportY;
      Object.assign(hint.style, {
        left: `${(range.start.x - 1) * cell.width}px`,
        top: `${row * cell.height}px`,
        width: `${(range.end.x - range.start.x + 1) * cell.width}px`,
        height: `${cell.height}px`,
      });
      screen.appendChild(hint);
    },
    hide: () => hint.remove(),
  };
}

/**
 * URLs and existing file paths in the terminal. A plain hover draws a dotted underline; Cmd-hover draws a solid one, Cmd-click opens it: a URL
 * in the worktree browser, a file in an editor pane at its line. Right-click gives a menu. Returns the disposer.
 */
export function registerTerminalLinks(term: Terminal, paneId: Id, host: HTMLElement): () => void {
  let meta = false;
  let shown: ILink[] = [];
  let hovered: { link: TermLink; range: IBufferRange } | null = null;
  const hint = linkHint(term);
  const showHint = () => (hovered && !meta ? hint.show(hovered.range) : hint.hide());
  const setMeta = (on: boolean) => {
    if (on === meta) return;
    meta = on;
    showHint();
    shown.forEach((l) => {
      if (!l.decorations) return;
      l.decorations.underline = on;
      l.decorations.pointerCursor = on;
    });
  };
  const onKey = (e: KeyboardEvent | MouseEvent) => setMeta(e.metaKey);
  const onBlur = () => setMeta(false);
  const onMenu = (e: MouseEvent) => {
    if (hovered) openMenu(e, linkMenu(hovered.link, paneId));
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
        shown = links.map((link): ILink => {
          const range = { start: { x: link.start + 1, y }, end: { x: link.end, y } };
          return {
            range,
            text: text.slice(link.start, link.end),
            decorations: { underline: meta, pointerCursor: meta },
            activate: (e: MouseEvent) => {
              if (e.metaKey) openLink(link, paneId);
            },
            hover: () => {
              hovered = { link, range };
              showHint();
            },
            leave: () => {
              hovered = null;
              showHint();
            },
          };
        });
        callback(shown.length ? shown : undefined);
      });
    },
  });
  const scroll = term.onScroll(() => {
    hovered = null;
    showHint();
  });
  return () => {
    provider.dispose();
    scroll.dispose();
    hint.hide();
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
