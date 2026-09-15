import { Cpu, Folder, GitBranch, GitPullRequest, MessagesSquare, Tag, type LucideIcon } from "lucide-react";
import { IconButton } from "../components/ui";
import { GLYPH, type Status } from "../glyphs";
import { setUi, useStore, type State } from "../store";
import type { RightSection, Worktree } from "../types";
import { RIGHT_SECTIONS } from "../uiState";

export interface RailMarker {
  glyph: string;
  tone: Status | "dirty";
  text: string;
}

const SECTIONS: Record<RightSection, { label: string; icon: LucideIcon }> = {
  worktree: { label: "Worktree", icon: Tag },
  git: { label: "Git", icon: GitBranch },
  pr: { label: "Pull request", icon: GitPullRequest },
  processes: { label: "Processes", icon: Cpu },
  sessions: { label: "Sessions", icon: MessagesSquare },
  files: { label: "Files", icon: Folder },
};

/** Exceptional state per inspector section. Only what fits in one glyph; the open inspector has the detail. */
export function sectionMarkers(s: State, w: Worktree): Partial<Record<RightSection, RailMarker>> {
  const pr = s.prs[w.id]?.pr ?? null;
  const procs = s.resources[w.id]?.process_count ?? 0;
  return {
    ...(w.git?.dirty ? { git: { glyph: "*", tone: "dirty", text: "dirty" } } : {}),
    ...(pr && pr.checks_failed > 0 ? { pr: { glyph: GLYPH.failed, tone: "failed", text: "checks failed" } } : pr?.state === "merged" ? { pr: { glyph: GLYPH.complete, tone: "complete", text: "merged" } } : {}),
    ...(procs > 0 ? { processes: { glyph: GLYPH.working, tone: "working", text: `${procs} running` } } : {}),
  };
}

/** The minimal inspector: one icon per section. A click opens the inspector at that section. */
export function RightRail({ worktree: w }: { worktree: Worktree }) {
  const markers = useStore((s) => sectionMarkers(s, w));
  return (
    <nav className="rail rail-right" aria-label="Inspector">
      {RIGHT_SECTIONS.map((id) => {
        const { label, icon: Icon } = SECTIONS[id];
        const marker = markers[id];
        return (
          <IconButton key={id} label={marker ? `${label}, ${marker.text}` : label} tooltipSide="left" className="rail-btn" onClick={() => setUi({ rightMode: "open", rightSection: id })}>
            <Icon className="icon" />
            {marker && <span className={`rail-marker glyph-${marker.tone}`} aria-hidden>{marker.glyph}</span>}
          </IconButton>
        );
      })}
    </nav>
  );
}
