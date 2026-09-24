import type { Addon } from "../types";
import { GitHubAvatar } from "./Avatar";
import { prBranchMark, prMarker, prSignals } from "./model";
import { PrDetail } from "./PrSection";
import { applyGitHubFrame } from "./state";

export const github: Addon = {
  id: "github",
  label: "GitHub",
  description: "The pull request of a branch, its checks and its review state, beside the branch in the inspector.",
  gitDetail: PrDetail,
  gitMarker: prMarker,
  branchMark: prBranchMark,
  worktreeSignals: prSignals,
  repoAvatar: GitHubAvatar,
  onFrame: applyGitHubFrame,
};
