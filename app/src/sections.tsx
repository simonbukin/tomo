import { Cpu, Folder, GitBranch, MessagesSquare, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { inspectorSections } from "./addons";
import type { InspectorSection } from "./addons/types";
import { GLYPH, type Status } from "./glyphs";
import type { State } from "./store";
import type { Worktree } from "./types";

export interface RailMarker {
  glyph: string;
  tone: Status | "dirty";
  text: string;
}

export type RailSection = Omit<InspectorSection, "component">;

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

/** Every inspector section in rail and inspector order. The addon sections come after `git`. */
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

/** One inspector heading: the rail icon, the lowercase label, then the control of the section. */
export function SectionLabel({ id, children }: { id: string; children?: ReactNode }) {
  const section = railSections().find((s) => s.id === id);
  const Icon = section?.icon;
  return (
    <div className="section-label">
      {Icon && <Icon className="icon" aria-hidden />}
      {section?.label.toLowerCase() ?? id}
      {children}
    </div>
  );
}
