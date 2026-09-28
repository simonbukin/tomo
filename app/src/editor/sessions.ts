import type { EditorState, StateEffect, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import type { Id } from "../types";
import type { EditorDoc } from "./model";

/**
 * The buffer of one editor pane. It outlives the pane component, because only the active tab
 * renders: a tab switch must not lose edits. CodeMirror code lives in the lazy `cm.ts` chunk,
 * and this module holds only its types, so the main bundle does not pay for the editor.
 */
export interface Session {
  readonly paneId: Id;
  readonly worktreeId: Id;
  readonly path: string;
  doc: EditorDoc;
  /** The buffer while no view shows it. */
  state: EditorState | null;
  view: EditorView | null;
  /** The text of the base version, to tell a real edit from an edit that was undone. */
  saved: Text | null;
  scroll: StateEffect<unknown> | null;
  /** Disk reads and saves of one pane run one after the other. */
  queue: Promise<void>;
  comparing: boolean;
}

const sessions = new Map<Id, Session>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const getSession = (paneId: Id): Session | undefined => sessions.get(paneId);
export const allSessions = (): Session[] => [...sessions.values()];

export function putSession(session: Session): void {
  sessions.set(session.paneId, session);
  notify();
}

/** Replaces the model of a pane and tells the views. The model is immutable, so a view re-renders only on a change. */
export function setDoc(paneId: Id, next: (doc: EditorDoc) => EditorDoc): void {
  const s = sessions.get(paneId);
  if (!s) return;
  const doc = next(s.doc);
  if (doc === s.doc) return;
  s.doc = doc;
  notify();
}

export function setComparing(paneId: Id, on: boolean): void {
  const s = sessions.get(paneId);
  if (!s || s.comparing === on) return;
  s.comparing = on;
  notify();
}

export function forgetSession(paneId: Id): void {
  if (sessions.delete(paneId)) notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const isDirty = (paneId: Id): boolean => !!sessions.get(paneId)?.doc.dirty;

export function useEditorDoc(paneId: Id): EditorDoc | null {
  return useSyncExternalStore(subscribe, () => sessions.get(paneId)?.doc ?? null);
}

export function useComparing(paneId: Id): boolean {
  return useSyncExternalStore(subscribe, () => !!sessions.get(paneId)?.comparing);
}

export function useAnyDirty(paneIds: Id[]): boolean {
  return useSyncExternalStore(subscribe, () => paneIds.some(isDirty));
}
