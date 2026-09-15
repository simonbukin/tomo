import { setRowError, useStore } from "./store";
import { Tooltip } from "./components/ui";
import type { Id } from "./types";

/** `× archive failed` on the worktree's own row. The tooltip holds the message; a click dismisses it. */
export function RowError({ worktreeId }: { worktreeId: Id }) {
  const error = useStore((s) => s.rowErrors[worktreeId] ?? null);
  if (!error) return null;
  return (
    <Tooltip content={`${error.message} (click to dismiss)`}>
      <button
        className="row-error rise"
        aria-label={`${error.op} failed: ${error.message}. Dismiss`}
        onClick={(e) => {
          e.stopPropagation();
          setRowError(worktreeId, null);
        }}
      >
        × {error.op} failed
      </button>
    </Tooltip>
  );
}
