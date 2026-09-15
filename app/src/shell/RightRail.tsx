import { Cpu, Folder, GitBranch, MessagesSquare, Tag } from "lucide-react";
import { inspectorSections } from "../addons";
import type { InspectorSection } from "../addons/types";
import { IconButton } from "../components/ui";
import { GLYPH, type Status } from "../glyphs";
import { setUi, useStore, type State } from "../store";
import type { Worktree } from "../types";

export interface RailMarker {
  glyph: string;
  tone: Status | "dirty";
  text: string;
}

type RailSection = Omit<InspectorSection, "component">;

const BEFORE_ADDONS: readonly RailSection[] = [
  { id: "worktree", label: "Worktree", icon: Tag },
  { id: "git", label: "Git", icon: GitBranch, marker: (_s, w) => (w.git?.dirty ? { glyph: "*", tone: "dirty", text: "dirty" } : null) },
];

const AFTER_ADDONS: readonly RailSection[] = [
  { id: "processes", label: "Processes", icon: Cpu, marker: (s, w) => processMarker(s.resources[w.id]?.process_count ?? 0) },
  { id: "sessions", label: "Sessions", icon: MessagesSquare },
  { id: "files", label: "Files", icon: Folder },
];

const processMarker = (procs: number): RailMarker | null => (procs > 0 ? { glyph: GLYPH.working, tone: "working", text: `${procs} running` } : null);

/** Every inspector section in rail order. The addon sections come after `git`. */
export const railSections = (): RailSection[] => [...BEFORE_ADDONS, ...inspectorSections(), ...AFTER_ADDONS];

/** Exceptional state per inspector section. Only what fits in one glyph; the open inspector has the detail. */
export function sectionMarkers(s: State, w: Worktree): Record<string, RailMarker> {
  return Object.fromEntries(
    railSections().flatMap((section) => {
      const marker = section.marker?.(s, w);
      return marker ? [[section.id, marker]] : [];
    }),
  );
}

/** The minimal inspector: one icon per section. A click opens the inspector at that section. */
export function RightRail({ worktree: w }: { worktree: Worktree }) {
  const markers = useStore((s) => sectionMarkers(s, w));
  return (
    <nav className="rail rail-right" aria-label="Inspector">
      {railSections().map(({ id, label, icon: Icon }) => {
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
