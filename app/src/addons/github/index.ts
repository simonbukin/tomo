import type { Addon } from "../types";
import { GitHubAvatar } from "./Avatar";
import { prBranchMark, prMarker, prSignals } from "./model";
import { PrDetail } from "./PrSection";
import { applyGitHubFrame } from "./state";

export const github: Addon = {
  id: "github",
  gitDetail: PrDetail,
  gitMarker: prMarker,
  branchMark: prBranchMark,
  worktreeSignals: prSignals,
  repoAvatar: GitHubAvatar,
  onFrame: applyGitHubFrame,
};
