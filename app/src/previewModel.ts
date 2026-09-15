import type { GitSummary } from "./types";

export function durationLabel(sinceMs: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - sinceMs) / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / (24 * 60))} d`;
}

export function gitLines(g: GitSummary): string[] {
  const files = g.files_changed ? `${g.files_changed} ${g.files_changed === 1 ? "file" : "files"} changed` : null;
  const untracked = g.untracked ? `${g.untracked} untracked` : null;
  return [
    `+${g.insertions} −${g.deletions}`,
    [files, untracked].filter(Boolean).join(" · ") || "clean",
    ...(g.conflicts ? [`${g.conflicts} conflicts`] : []),
    g.upstream ? `↑${g.ahead ?? 0} ↓${g.behind ?? 0} ${g.upstream}` : "no upstream",
  ];
}
