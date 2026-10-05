import { GitPullRequest } from "lucide-react";
import type { PullRequest } from "../../generated";
import { GLYPH, type BranchTone } from "../../glyphs";
import type { RailMarker } from "../../sections";
import type { State } from "../../store";
import type { Id, Worktree } from "../../types";
import type { SearchGroup, WorktreeLink } from "../types";
import { prOf } from "./state";

const openWorktree = (id: Id) => (): void => void import("../../actions").then((a) => a.openWorktree(id));

/** The pull request of each worktree that the inspector asked about, by number and title. Enter opens the worktree. */
export const searchSources: SearchGroup[] = [
  {
    id: "github",
    label: "Pull requests",
    entries: (s) =>
      s.worktrees.flatMap((w) => {
        const pr = prOf(s, w.id);
        return pr ? [{ key: `github-pr:${w.id}`, label: `#${pr.number} ${pr.title}`, hint: `${w.name} · ${pr.draft ? "draft" : pr.state}`, run: openWorktree(w.id) }] : [];
      }),
  },
];

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

/** GitHub's own purple for a merged pull request. The status palette has no purple, and gray would read as a draft. */
const MERGED = "#8a6fd1";

type PrTone = "open" | "draft" | "merged" | "closed" | "failing";

const PR_COLOR: Record<PrTone, string> = { open: "var(--working)", draft: "var(--fg-3)", merged: MERGED, closed: "var(--danger)", failing: "var(--danger)" };

function prTone(pr: PullRequest): PrTone {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.checks_failed > 0) return "failing";
  return pr.draft ? "draft" : "open";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function checksFact(pr: PullRequest): { text: string; bad?: boolean } | null {
  if (pr.checks_failed > 0) return { text: `${plural(pr.checks_failed, "check")} failing`, bad: true };
  if (pr.checks_pending > 0) return { text: `${plural(pr.checks_pending, "check")} running` };
  return pr.checks_passed > 0 ? { text: "checks passing" } : null;
}

const REVIEW: Record<string, string> = { approved: "approved", changes_requested: "changes requested", review_required: "review requested" };

export function prFacts(pr: PullRequest): { text: string; bad?: boolean }[] {
  const state = pr.state === "open" && pr.draft ? "draft" : pr.state;
  const review = pr.review_decision ? (REVIEW[pr.review_decision] ?? pr.review_decision.replace(/_/g, " ")) : null;
  return [{ text: state }, checksFact(pr), review ? { text: review } : null].filter((f) => f !== null);
}

export function prLinks(s: State, w: Worktree): WorktreeLink[] {
  const pr = prOf(s, w.id);
  return pr ? [{ id: "github-pr", label: "PR", icon: GitPullRequest, color: PR_COLOR[prTone(pr)], text: `#${pr.number}`, title: pr.title, facts: prFacts(pr) }] : [];
}
