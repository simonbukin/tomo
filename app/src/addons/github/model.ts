import type { AddonSignal } from "../../activityModel";
import { GLYPH, type BranchTone } from "../../glyphs";
import type { RailMarker } from "../../sections";
import type { State } from "../../store";
import type { Id, Worktree } from "../../types";
import { prOf } from "./state";

const GITHUB_REMOTE_PREFIXES = ["git@github.com:", "https://github.com/", "http://github.com/", "ssh://git@github.com/"];

/** The owner of an `owner/name` GitHub remote, or null for any other remote. */
export function githubOwner(remoteUrl: string | null): string | null {
  const prefix = GITHUB_REMOTE_PREFIXES.find((p) => remoteUrl?.startsWith(p));
  if (!remoteUrl || !prefix) return null;
  const [owner, ...name] = remoteUrl.slice(prefix.length).replace(/\/+$/, "").replace(/(\.git)+$/, "").split("/");
  return owner && name.length === 1 && name[0] ? owner : null;
}

export function prMarker(s: State, w: Worktree): RailMarker | null {
  const pr = prOf(s, w.id);
  return pr && pr.checks_failed > 0 ? { glyph: GLYPH.failed, tone: "failed", text: "checks failed" } : pr?.state === "merged" ? { glyph: GLYPH.complete, tone: "complete", text: "merged" } : null;
}

export function prBranchMark(s: State, w: Worktree): { tone: BranchTone; text: string } | null {
  const pr = prOf(s, w.id);
  if (!pr) return null;
  if (pr.state === "merged") return { tone: "merged", text: `#${pr.number} merged` };
  if (pr.state === "closed") return { tone: "closed", text: `#${pr.number} closed` };
  if (pr.checks_failed > 0) return { tone: "failed", text: `#${pr.number}, ${pr.checks_failed} checks failed` };
  if (pr.checks_pending > 0) return { tone: "pending", text: `#${pr.number}, ${pr.checks_pending} checks running` };
  return { tone: "open", text: `#${pr.number} open` };
}

export function prSignals(s: State, worktreeId: Id): AddonSignal[] {
  const pr = prOf(s, worktreeId);
  if (pr?.state === "merged") return [{ kind: "addon", text: "merged", glyph: GLYPH.complete, className: "signal-pr-merged", dot: "pr-merged" }];
  if (pr && pr.checks_failed > 0) return [{ kind: "addon", text: "checks failed", glyph: GLYPH.failed, className: "signal-pr-failed", dot: "check-failed" }];
  return [];
}
