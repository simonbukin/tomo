import { openUrl } from "@tauri-apps/plugin-opener";
import type { PaletteEntry } from "../../paletteModel";
import { failToast, type State } from "../../store";
import type { Id, Worktree } from "../../types";
import type { LinearIssue } from "../../generated";
import type { SearchGroup, WorktreeLink } from "../types";
import { LinearGlyph } from "./Glyph";
import { linearIssueOf } from "./state";

/** A team's state colour, mixed toward the text colour so a pale Linear colour such as `#e2e2e2` still reads on a light theme. The daemon empties a colour of another shape. */
export const stateTint = (issue: LinearIssue): string | undefined => (issue.state.color ? `color-mix(in srgb, ${issue.state.color} 70%, var(--fg))` : undefined);

export function linearLinks(s: State, w: Worktree): WorktreeLink[] {
  const issue = linearIssueOf(s, w.id);
  return issue
    ? [{ id: "linear-issue", label: "linear", icon: LinearGlyph, color: stateTint(issue), text: issue.identifier, title: issue.title, facts: [{ text: issue.state.name }, { text: issue.assignee ?? "unassigned" }] }]
    : [];
}

export const openIssue = (issue: LinearIssue) => (): void => void openUrl(issue.url).catch(failToast("Could not open the link"));

const openWorktree = (id: Id) => (): void => void import("../../actions").then((a) => a.openWorktree(id));

/** The linked issue of each worktree, by its identifier and title. Enter opens the worktree. */
export const searchSources: SearchGroup[] = [
  {
    id: "linear",
    label: "Linear",
    entries: (s) =>
      (s.linear?.links ?? []).flatMap(({ worktree_id, issue }) => {
        const w = s.worktrees.find((x) => x.id === worktree_id);
        return w ? [{ key: `linear-issue:${w.id}`, label: `${issue.identifier} ${issue.title}`, hint: `${w.name} · ${issue.state.name}`, run: openWorktree(w.id) }] : [];
      }),
  },
];

export function paletteEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  const issue = linearIssueOf(s, w.id);
  return issue ? [{ key: `linear:${w.id}`, label: `open ${issue.identifier} in Linear`, hint: `${w.name} · ${issue.title}`, context, run: openIssue(issue) }] : [];
}
