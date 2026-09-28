/** What the buffer was read from or last saved to. */
export type Base = { kind: "file"; version: string } | { kind: "missing" };

/** A fresh read of the file on disk. */
export type DiskRead = { kind: "file"; version: string; text: string } | { kind: "missing" };

/** The disk moved away from the base while the buffer had edits, or the file went away. */
export type Notice = { kind: "changed"; version: string; text: string } | { kind: "deleted" };

export interface EditorDoc {
  /** Null until the first read ends. */
  base: Base | null;
  dirty: boolean;
  notice: Notice | null;
  /** Set by "Keep mine": the disk version that the next save replaces after a confirm. */
  overwrite: string | null;
  error: string | null;
}

export const initialDoc: EditorDoc = { base: null, dirty: false, notice: null, overwrite: null, error: null };

export type Step = { doc: EditorDoc; reload?: string };

export const loaded = (version: string): EditorDoc => ({ ...initialDoc, base: { kind: "file", version } });

/** A file that does not exist yet opens empty, and Save creates it. */
export const opened = (read: DiskRead): Step =>
  read.kind === "file" ? { doc: loaded(read.version), reload: read.text } : { doc: { ...initialDoc, base: { kind: "missing" }, notice: { kind: "deleted" } }, reload: "" };

export const edited = (doc: EditorDoc, dirty: boolean): EditorDoc => (doc.dirty === dirty ? doc : { ...doc, dirty });

const sameAsBase = (base: Base | null, read: DiskRead): boolean =>
  !!base && (read.kind === "missing" ? base.kind === "missing" : base.kind === "file" && base.version === read.version);

/**
 * The disk after a change event. A clean buffer follows the disk silently. A buffer with edits keeps
 * them, and the notice asks the user what to do. A disk that went back to the base clears the notice.
 */
export function diskRead(doc: EditorDoc, read: DiskRead): Step {
  const calm = { ...doc, error: null };
  if (sameAsBase(doc.base, read)) return { doc: doc.notice?.kind === "changed" ? { ...calm, notice: null, overwrite: null } : calm };
  if (read.kind === "missing") return { doc: { ...calm, base: { kind: "missing" }, notice: { kind: "deleted" }, overwrite: null } };
  if (!doc.dirty) return { doc: loaded(read.version), reload: read.text };
  if (doc.overwrite === read.version) return { doc: calm };
  return { doc: { ...calm, notice: { kind: "changed", version: read.version, text: read.text }, overwrite: null } };
}

/** "Reload": the disk text replaces the buffer. */
export function reload(doc: EditorDoc): Step {
  if (doc.notice?.kind !== "changed") return { doc };
  return { doc: loaded(doc.notice.version), reload: doc.notice.text };
}

/** "Keep mine": the notice goes away, and the next save replaces this disk version after a confirm. */
export function keepMine(doc: EditorDoc): EditorDoc {
  if (doc.notice?.kind !== "changed") return doc;
  return { ...doc, notice: null, overwrite: doc.notice.version };
}

export const dismiss = (doc: EditorDoc): EditorDoc => (doc.notice?.kind === "deleted" ? { ...doc, notice: null } : doc);

export type SavePlan = { kind: "write"; expected: string | null } | { kind: "confirm"; expected: string } | { kind: "none"; why: string };

/** A save writes against the base version. Over a change that the user did not merge, it asks first. */
export function planSave(doc: EditorDoc): SavePlan {
  if (!doc.base) return { kind: "none", why: "the file is not loaded" };
  if (doc.notice?.kind === "changed") return { kind: "confirm", expected: doc.notice.version };
  if (doc.overwrite) return { kind: "confirm", expected: doc.overwrite };
  return { kind: "write", expected: doc.base.kind === "file" ? doc.base.version : null };
}

/** `dirty` is true when the buffer changed again while the save ran. */
export const saved = (version: string, dirty: boolean): EditorDoc => ({ ...initialDoc, base: { kind: "file", version }, dirty });

export const failed = (doc: EditorDoc, message: string): EditorDoc => ({ ...doc, error: message });

/** The smallest single replacement that turns `a` into `b`, so a reload keeps the cursor and the scroll. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

/** The label of the pane and the tab: the file name with a dot while the buffer has edits. */
export const titleOf = (path: string, dirty: boolean): string => `${dirty ? "● " : ""}${path.split("/").pop() || path}`;
