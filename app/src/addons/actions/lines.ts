import type { State } from "../../store";
import type { AttentionItem, Id } from "../../types";
import type { AppLine } from "../types";

const EXITED = /^(.*) exited with code (-?\d+)$/;

/** A crash of an Action: the daemon writes `storybook exited with code 1`, and the row shows `storybook  exited 1`. */
export function crashLine(item: AttentionItem): AppLine {
  const [, label, code] = EXITED.exec(item.message) ?? [null, item.message, null];
  const detail = code === null ? "crashed" : `exited ${code}`;
  return { id: item.id, mark: "failed", label, detail, bad: true, atMs: item.created_at_ms };
}

/** Every Action of a worktree that crashed and that nobody resolved yet. */
export const crashLines = (s: State, worktreeId: Id): AppLine[] =>
  s.attention.filter((a) => a.worktree_id === worktreeId && a.kind === "crash" && a.resolved_at_ms == null).map(crashLine);
