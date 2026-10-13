import { openUrl } from "@tauri-apps/plugin-opener";
import type { PaletteEntry } from "../../paletteModel";
import { failToast, type State } from "../../store";
import type { Id, Worktree } from "../../types";
import type { LinearIssue } from "../../generated";
import type { SearchGroup, WorktreeLink } from "../types";
import { LinearGlyph } from "./Glyph";
import { linearLinksOf } from "./state";

/** A team's state colour, mixed toward the text colour so a pale Linear colour such as `#e2e2e2` still reads on a light theme. The daemon empties a colour of another shape. */
export const stateTint = (issue: LinearIssue): string | undefined => (issue.state.color ? `color-mix(in srgb, ${issue.state.color} 70%, var(--fg))` : undefined);

/** One link for each issue that the worktree names. Its pull requests go under it by their ticket. */
export function linearLinks(s: State, w: Worktree): WorktreeLink[] {
  return linearLinksOf(s, w.id).map(({ issue, touched_ms, current, why }) => ({
    id: `linear-issue:${issue.identifier}`,
    label: "linear",
    icon: LinearGlyph,
    color: stateTint(issue),
    text: issue.identifier,
    title: issue.title,
    facts: [{ text: issue.state.name }, { text: issue.assignee ?? "unassigned" }],
    url: issue.url,
    touchedMs: Math.max(touched_ms, issue.updated_at_ms),
    key: issue.identifier,
    current,
    why,
  }));
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
        return w ? [{ key: `linear-issue:${w.id}:${issue.identifier}`, label: `${issue.identifier} ${issue.title}`, hint: `${w.name} · ${issue.state.name}`, run: openWorktree(w.id) }] : [];
      }),
  },
];

export function paletteEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  return linearLinksOf(s, w.id).map(({ issue }) => ({ key: `linear:${w.id}:${issue.identifier}`, label: `open ${issue.identifier} in Linear`, hint: `${w.name} · ${issue.title}`, context, run: openIssue(issue) }));
}
