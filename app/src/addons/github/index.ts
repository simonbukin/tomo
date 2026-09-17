import type { Addon } from "../types";
import { GitHubAvatar } from "./Avatar";
import { prMarker, prSignals } from "./model";
import { PrDetail } from "./PrSection";
import { applyGitHubFrame } from "./state";

export const github: Addon = {
  id: "github",
  // A pull request belongs with the branch, so these are rows in the core git section
  // rather than a section of their own. PR state still reaches a worktree card as a signal.
  gitDetail: PrDetail,
  gitMarker: prMarker,
  worktreeSignals: prSignals,
  repoAvatar: GitHubAvatar,
  onFrame: applyGitHubFrame,
};
