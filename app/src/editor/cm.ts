import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Text, type Extension, type TransactionSpec } from "@codemirror/state";
import { crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { onFrame, rpc, RpcFailure, rpcParsed } from "../api";
import { findAction } from "../keys";
import { errorText, failQuietly, getState, keyBindings, setState, toast } from "../store";
import { registerTerminal } from "../terminals";
import { fileTextSchema, fileWrittenSchema } from "../schemas";
import type { EditorTarget, Frame, Id } from "../types";
import * as model from "./model";
import { allSessions, getSession, putSession, setComparing, setDoc, type Session } from "./sessions";

const language = new Compartment();

const slabHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--fg)", fontWeight: "600" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: "var(--fg-3)", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], color: "var(--working)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--waiting)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--fg)", fontWeight: "500" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.macroName], color: "var(--fg-1)", fontWeight: "500" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--fg-1)" },
  { tag: [t.punctuation, t.operator, t.bracket, t.separator], color: "var(--fg-2)" },
  { tag: t.heading, fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** The slab tokens change with the theme on :root, so one CodeMirror theme serves dark and light. */
const slabTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "var(--editor-size, 13px)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--editor-font, var(--mono))", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--fg)", padding: "var(--sp-1) 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--accent-soft)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-3)", border: "none", boxShadow: "inset -1px 0 0 var(--line)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--sp-2) 0 var(--inset)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 var(--sp-1)", color: "var(--fg-3)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLineGutter": { color: "var(--fg)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--fg) 10%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--waiting) 28%, transparent)", outline: "1px solid color-mix(in srgb, var(--waiting) 60%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--waiting)", color: "var(--bg)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "transparent", outline: "1px solid var(--fg-3)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--danger-soft)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-1)", border: "none", boxShadow: "inset 0 0 0 1px var(--line-strong)", color: "var(--fg-2)", borderRadius: "0" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", border: "none", boxShadow: "var(--shadow-pop)", color: "var(--fg)" },
  ".cm-panels": { backgroundColor: "var(--bg-1)", color: "var(--fg)", fontFamily: "var(--font-ui)", fontSize: "var(--fs-1)" },
  ".cm-panels.cm-panels-top": { borderBottom: "none", boxShadow: "inset 0 -1px 0 var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "none", boxShadow: "inset 0 1px 0 var(--line)" },
  ".cm-panel": { padding: "0 var(--sp-2) 0 var(--inset)", minHeight: "var(--u)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0 var(--sp-2)" },
  ".cm-panel label": { display: "inline-flex", alignItems: "center", gap: "var(--sp-1)", color: "var(--fg-2)", fontSize: "var(--fs-1)", whiteSpace: "nowrap" },
  ".cm-panel input[type=checkbox]": { appearance: "none", width: "10px", height: "10px", margin: "0", boxShadow: "inset 0 0 0 1px var(--fg-3)", background: "var(--bg)" },
  ".cm-panel input[type=checkbox]:checked": { background: "var(--fg)", boxShadow: "none" },
  ".cm-panel .cm-textfield": { height: "20px", margin: "0", padding: "0 var(--sp-1)", border: "none", borderRadius: "0", boxShadow: "inset 0 0 0 1px var(--line-strong)", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: "var(--fs-1)" },
  ".cm-panel .cm-textfield:focus": { outline: "none", boxShadow: "inset 0 0 0 1px var(--fg)" },
  ".cm-panel .cm-button": { height: "20px", margin: "0", padding: "0 var(--sp-2)", border: "none", borderRadius: "0", backgroundImage: "none", background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--line-strong)", color: "var(--fg)", fontFamily: "var(--font-ui)", fontSize: "var(--fs-1)", fontWeight: "500" },
  ".cm-panel .cm-button:hover": { background: "var(--bg-2)" },
  ".cm-panel .cm-button:active": { backgroundImage: "none", background: "var(--fg)", color: "var(--bg)" },
  ".cm-panel.cm-search [name=close]": { position: "static", marginLeft: "auto", padding: "0 var(--sp-1)", fontSize: "var(--fs-3)", color: "var(--fg-2)", background: "none", cursor: "default" },
  ".cm-panel.cm-search br": { display: "none" },
  ".cm-panel.cm-dialog": { position: "relative", paddingRight: "var(--u)" },
  ".cm-panel .cm-dialog-close": { position: "absolute", top: "0", right: "0", width: "var(--u)", height: "var(--u)", padding: "0", fontSize: "var(--fs-3)", color: "var(--fg-2)", background: "none", cursor: "default" },
});

/** Shift with an arrow extends a selection in text, so the editor keeps those keys even when a Tomo command has one. */
const editorChord = (e: KeyboardEvent) => e.key.startsWith("Arrow") && e.shiftKey && !e.altKey && !e.ctrlKey;

/**
 * A Tomo key goes to the window handler, not to the editor: Cmd+D splits the pane and does not select the
 * next match. Returning true skips the CodeMirror keymaps; the event still bubbles to `App`.
 */
const tomoKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (e) => {
      if (editorChord(e)) {
        e.stopPropagation();
        return false;
      }
      return findAction(e, keyBindings(getState())) !== null;
    },
  }),
);

const current = (s: Session): EditorState | null => s.view?.state ?? s.state;

function apply(s: Session, spec: TransactionSpec): void {
  const state = current(s);
  if (!state) return;
  if (s.view) s.view.dispatch(spec);
  else s.state = state.update(spec).state;
}

function posOf(doc: Text, line: number, col: number): number {
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  return l.from + Math.min(Math.max(0, col - 1), l.length);
}

const cursorTimers = new Map<Id, number>();

function keepCursor(s: Session, state: EditorState): void {
  window.clearTimeout(cursorTimers.get(s.paneId));
  cursorTimers.set(
    s.paneId,
    window.setTimeout(() => {
      cursorTimers.delete(s.paneId);
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      rpc("editor_cursor", { pane_id: s.paneId, line: line.number, col: head - line.from + 1 }).catch(failQuietly("editor_cursor"));
    }, 800),
  );
}

/** A file with CRLF line ends keeps them: without this, a save would rewrite every line. */
const lineEndsOf = (text: string): Extension => (text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : []);

function extensionsFor(s: Session, text: string): Extension[] {
  return [
    lineEndsOf(text),
    tomoKeys,
    lineNumbers(),
    foldGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(slabHighlight),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      { key: "Mod-l", run: gotoLine, preventDefault: true },
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    language.of([]),
    slabTheme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) setDoc(s.paneId, (d) => model.edited(d, !!s.saved && !u.state.doc.eq(s.saved)));
      if (u.selectionSet) keepCursor(s, u.state);
    }),
  ];
}

function loadLanguage(s: Session): void {
  LanguageDescription.matchFilename(languages, s.path)
    ?.load()
    .then((support) => apply(s, { effects: language.reconfigure(support) }))
    .catch(failQuietly("editor language"));
}

type Read = model.DiskRead | { kind: "error"; message: string };

async function readDisk(s: Session): Promise<Read> {
  try {
    const f = await rpcParsed("fs_read", fileTextSchema, { worktree_id: s.worktreeId, path: s.path });
    return { kind: "file", version: f.version, text: f.content };
  } catch (e) {
    if (e instanceof RpcFailure && e.code === "not_found" && !e.message.includes("worktree")) return { kind: "missing" };
    return { kind: "error", message: errorText(e) };
  }
}

/** Replaces the buffer text with the smallest change, so the cursor and the scroll stay. Undo brings the old text back. */
function replaceText(s: Session, text: string): void {
  const state = current(s);
  if (!state) return;
  const change = model.minimalChange(state.sliceDoc(), text);
  const tr = state.update({ changes: change ?? [] });
  s.saved = tr.state.doc;
  if (s.view) s.view.dispatch(tr);
  else s.state = tr.state;
}

const pendingReveal = new Map<Id, { line: number; col: number }>();

/** Reads the disk and applies the model: the first read makes the buffer, a later one follows the disk. */
async function syncDisk(s: Session, target: EditorTarget | null): Promise<void> {
  const read = await readDisk(s);
  if (read.kind === "error") return setDoc(s.paneId, (d) => model.failed(d, read.message));
  if (!current(s)) {
    const step = model.opened(read);
    const at = pendingReveal.get(s.paneId) ?? target ?? { line: 1, col: 1 };
    pendingReveal.delete(s.paneId);
    const text = step.reload ?? "";
    const state = EditorState.create({ doc: text, extensions: extensionsFor(s, text) });
    s.state = state.update({ selection: { anchor: posOf(state.doc, at.line, at.col) } }).state;
    s.saved = s.state.doc;
    setDoc(s.paneId, () => step.doc);
    loadLanguage(s);
    return;
  }
  const step = model.diskRead(s.doc, read);
  if (step.reload !== undefined) replaceText(s, step.reload);
  if (read.kind === "missing") s.saved = Text.empty;
  const doc = current(s)?.doc;
  setDoc(s.paneId, () => (read.kind === "missing" && doc ? model.edited(step.doc, !doc.eq(Text.empty)) : step.doc));
}

function enqueue(s: Session, job: () => Promise<void>): Promise<void> {
  s.queue = s.queue.then(job).catch((e) => setDoc(s.paneId, (d) => model.failed(d, errorText(e))));
  return s.queue;
}

function onFileChanged(frame: Frame): void {
  if (frame.event !== "file_changed") return;
  const { worktree_id, path } = frame.data as { worktree_id: Id; path: string };
  allSessions()
    .filter((s) => s.worktreeId === worktree_id && s.path === path)
    .forEach((s) => void enqueue(s, () => syncDisk(s, null)).then(() => s.show?.()));
}

onFrame(onFileChanged);

/** Test and dev hook: the same path as a `file_changed` event from the daemon. */
export const fileChanged = (worktreeId: Id, path: string): void => onFileChanged({ event: "file_changed", data: { worktree_id: worktreeId, path } } as Frame);

/**
 * Shows the buffer of `paneId` in `host`. The first mount reads the file; a later mount takes the buffer
 * that the last view left, and checks the disk for a change that it missed. Returns the unmount.
 */
export function mount(paneId: Id, host: HTMLElement, worktreeId: Id, target: EditorTarget): () => void {
  const started = performance.now();
  const known = getSession(paneId);
  const s: Session = known ?? { paneId, worktreeId, path: target.path, doc: model.initialDoc, state: null, view: null, show: null, saved: null, scroll: null, queue: Promise.resolve(), comparing: false };
  if (!known) putSession(s);
  let view: EditorView | null = null;
  let disposed = false;
  let unregister = () => {};
  const show = () => {
    if (disposed || view || !s.state) return;
    view = new EditorView({ state: s.state, parent: host, scrollTo: s.scroll ?? EditorView.scrollIntoView(s.state.selection.main.head, { y: "center" }) });
    s.view = view;
    s.state = null;
    const v = view;
    unregister = registerTerminal(paneId, { el: host, focus: () => v.focus() });
    if (host.closest(".pane-active")) v.focus();
    requestAnimationFrame(() => performance.measure(`editor paint ${s.path}`, { start: started, end: performance.now() }));
  };
  s.show = show;
  if (s.state) show();
  void enqueue(s, () => syncDisk(s, target)).then(show);
  return () => {
    disposed = true;
    if (s.show === show) s.show = null;
    unregister();
    if (!view) return;
    s.scroll = view.scrollSnapshot();
    s.state = view.state;
    s.view = null;
    view.destroy();
  };
}

export function reveal(paneId: Id, line: number, col: number): void {
  const s = getSession(paneId);
  const state = s && current(s);
  if (!s || !state) {
    pendingReveal.set(paneId, { line, col });
    return;
  }
  const pos = posOf(state.doc, line, col);
  s.scroll = null;
  apply(s, { selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
}

function write(s: Session, expected: string | null): Promise<void> {
  return enqueue(s, async () => {
    const state = current(s);
    if (!state) return;
    const snapshot = state.doc;
    try {
      const r = await rpcParsed("fs_write", fileWrittenSchema, { worktree_id: s.worktreeId, path: s.path, content: snapshot.sliceString(0, snapshot.length, state.lineBreak), expected_version: expected });
      s.saved = snapshot;
      const now = current(s);
      setDoc(s.paneId, () => model.saved(r.version, !!now && !now.doc.eq(snapshot)));
    } catch (e) {
      if (e instanceof RpcFailure && e.code === "conflict") {
        toast({ level: "warning", title: "Not saved", detail: `${e.message}. Your edits are still here.` });
        await syncDisk(s, null);
        return;
      }
      toast({ level: "error", title: "Could not save", detail: errorText(e) });
      setDoc(s.paneId, (d) => model.failed(d, `Not saved: ${errorText(e)}`));
    }
  });
}

/** Cmd+S. A save over a change on disk that the user did not look at asks first. */
export function save(paneId: Id): void {
  const s = getSession(paneId);
  if (!s) return;
  const plan = model.planSave(s.doc);
  if (plan.kind === "none") return;
  if (plan.kind === "write") return void write(s, plan.expected);
  setState({
    dialog: {
      kind: "confirm",
      title: "Replace the file on disk?",
      body: `${s.path} changed on disk after you opened it. Save replaces that version with yours.`,
      confirmLabel: "Replace",
      destructive: true,
      onConfirm: () => void write(s, plan.expected),
    },
  });
}

export function reloadFromDisk(paneId: Id): void {
  const s = getSession(paneId);
  if (!s) return;
  void enqueue(s, async () => {
    const step = model.reload(s.doc);
    if (step.reload !== undefined) replaceText(s, step.reload);
    setDoc(paneId, () => step.doc);
    setComparing(paneId, false);
  });
}

export function keepMine(paneId: Id): void {
  setDoc(paneId, model.keepMine);
  setComparing(paneId, false);
}

export const dismiss = (paneId: Id): void => setDoc(paneId, model.dismiss);

export function retry(paneId: Id): void {
  const s = getSession(paneId);
  if (s) void enqueue(s, () => syncDisk(s, null)).then(() => s.show?.());
}

/** A side-by-side view of the buffer and the disk text, both read-only. */
export async function mountCompare(paneId: Id, host: HTMLElement): Promise<() => void> {
  const s = getSession(paneId);
  const state = s && current(s);
  if (!s || !state || s.doc.notice?.kind !== "changed") return () => {};
  const { MergeView } = await import("@codemirror/merge");
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), syntaxHighlighting(slabHighlight), slabTheme, language.of(language.get(state) ?? [])];
  const merge = new MergeView({ a: { doc: state.doc, extensions: readOnly }, b: { doc: s.doc.notice.text, extensions: readOnly }, parent: host, gutter: true, highlightChanges: true });
  return () => merge.destroy();
}
