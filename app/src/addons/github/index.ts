import { GitPullRequest } from "lucide-react";
import type { Addon } from "../types";
import { GitHubAvatar } from "./Avatar";
import { prMarker, prSignals } from "./model";
import { PrSection } from "./PrSection";
import { applyGitHubFrame } from "./state";

export const github: Addon = {
  id: "github",
  inspectorSections: [{ id: "pr", label: "Pull request", icon: GitPullRequest, component: PrSection, marker: prMarker }],
  worktreeSignals: prSignals,
  repoAvatar: GitHubAvatar,
  onFrame: applyGitHubFrame,
};
