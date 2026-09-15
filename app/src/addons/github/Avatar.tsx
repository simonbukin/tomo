import type { Repo } from "../../types";
import { githubOwner } from "./model";

export function GitHubAvatar({ repo, size }: { repo: Repo; size: number }) {
  const owner = githubOwner(repo.remote_url);
  if (!owner) return null;
  return <img className="repo-avatar" width={size} height={size} src={`https://github.com/${owner}.png?size=64`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />;
}
