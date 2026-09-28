import { siLinear } from "simple-icons";
import { HoverCard } from "../../components/ui";
import { useStore } from "../../store";
import type { LinearIssue } from "../../generated";
import type { Id, Worktree } from "../../types";
import { openIssue, stateTint } from "./model";
import { linearIssueOf } from "./state";

export function LinearIcon({ issue, size = 11 }: { issue: LinearIssue; size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={`Linear ${issue.state.name}`} style={{ width: size, height: size, color: stateTint(issue) }}>
      <path d={siLinear.path} fill="currentColor" />
    </svg>
  );
}

const people = (issue: LinearIssue): string => [issue.priority, issue.assignee ?? "unassigned"].join(" · ");

export function LinearPreview({ issue }: { issue: LinearIssue }) {
  return (
    <div className="preview">
      <div className="preview-head"><LinearIcon issue={issue} size={12} />{issue.identifier}</div>
      <div>{issue.title}</div>
      <div className="muted">{issue.state.name} · {people(issue)}</div>
    </div>
  );
}

export function LinearSignal({ worktreeId }: { worktreeId: Id }) {
  const issue = useStore((s) => linearIssueOf(s, worktreeId));
  if (!issue) return null;
  return (
    <HoverCard content={<LinearPreview issue={issue} />}>
      <span className="signal signal-linear"><LinearIcon issue={issue} />{issue.identifier} {issue.state.name}</span>
    </HoverCard>
  );
}

export function LinearDetail({ worktree: w }: { worktree: Worktree }) {
  const issue = useStore((s) => linearIssueOf(s, w.id));
  if (!issue) return null;
  return (
    <>
      <div className="kv"><label>linear</label><span className="pr-title" title={issue.title} onClick={openIssue(issue)}><span className="pr-number">{issue.identifier}</span> <span>{issue.title}</span></span></div>
      <div className="kv"><label>issue</label><span><LinearIcon issue={issue} /> {issue.state.name} · {people(issue)}</span></div>
    </>
  );
}
