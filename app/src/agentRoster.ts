import { repoName } from "./homeQuery";
import type { AgentKind, AgentPresence, AgentState, Id, Repo, Worktree } from "./types";

/** Most urgent first. An agent that wants me comes before one that is busy. */
const ORDER: Record<AgentState, number> = { waiting: 0, working: 1, idle: 2, unknown: 3, exited: 4 };

export interface AgentRow {
  paneId: Id;
  worktreeId: Id;
  kind: AgentKind;
  state: AgentState;
  repo: string;
  worktree: string;
  updatedAtMs: number;
}

/**
 * Where the agents are. Presence and place only: the roster carries no task,
 * no goal, and no plan, because those belong to the agent, not to Tomo.
 * An agent that exited is gone, so it leaves the roster.
 */
export function agentRoster(agents: AgentPresence[], worktrees: Worktree[], repos: Repo[]): AgentRow[] {
  return agents
    .filter((a) => a.state !== "exited")
    .map((a) => {
      const w = worktrees.find((x) => x.id === a.worktree_id);
      return {
        paneId: a.pane_id,
        worktreeId: a.worktree_id,
        kind: a.kind,
        state: a.state,
        repo: w ? repoName(repos, w.repo_id) : "?",
        worktree: w?.name ?? "unknown",
        updatedAtMs: a.updated_at_ms,
      };
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAtMs - a.updatedAtMs || a.worktree.localeCompare(b.worktree));
}

export function rosterSize(agents: AgentPresence[]): number {
  return agents.filter((a) => a.state !== "exited").length;
}
