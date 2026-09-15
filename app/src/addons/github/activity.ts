import type { GitHubActivity } from "../../generated";
import type { ActivityKindView } from "../types";

export const githubActivity: Record<GitHubActivity, ActivityKindView> = {
  pr_merged: { status: "complete" },
};
