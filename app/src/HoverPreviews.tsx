import { gitLines } from "./previewModel";
import type { Worktree } from "./types";
import "./styles/previews.css";

export function GitPreview({ worktree: w }: { worktree: Worktree }) {
  return (
    <div className="preview">
      <div className="preview-head mono">{w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "no branch")}</div>
      {w.git ? gitLines(w.git).map((line) => <div key={line} className="muted">{line}</div>) : <div className="muted">no git status yet</div>}
      <div className="mono faint">
        {w.head.slice(0, 7)} · {w.path}
      </div>
    </div>
  );
}
