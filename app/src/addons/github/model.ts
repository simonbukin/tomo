import type { AddonSignal } from "../../activityModel";
import { GLYPH } from "../../glyphs";
import type { RailMarker } from "../../shell/RightRail";
import type { State } from "../../store";
import type { Id, Worktree } from "../../types";
import { prOf } from "./state";

export function prMarker(s: State, w: Worktree): RailMarker | null {
  const pr = prOf(s, w.id);
  return pr && pr.checks_failed > 0 ? { glyph: GLYPH.failed, tone: "failed", text: "checks failed" } : pr?.state === "merged" ? { glyph: GLYPH.complete, tone: "complete", text: "merged" } : null;
}

export function prSignals(s: State, worktreeId: Id): AddonSignal[] {
  const pr = prOf(s, worktreeId);
  if (pr?.state === "merged") return [{ kind: "addon", text: "merged", glyph: GLYPH.complete, className: "signal-pr-merged", dot: "pr-merged" }];
  if (pr && pr.checks_failed > 0) return [{ kind: "addon", text: "checks failed", glyph: GLYPH.failed, className: "signal-pr-failed", dot: "check-failed" }];
  return [];
}
