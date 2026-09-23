import { ChevronDown, Cpu, Folder, GitBranch, MessagesSquare, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { gitMarkers, inspectorSections } from "./addons";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./components/ui";
import type { InspectorSection } from "./addons/types";
import { GLYPH, type Status } from "./glyphs";
import { getState, setUi, useStore, type State } from "./store";
import type { RightSection, Worktree } from "./types";

export interface RailMarker {
  glyph: string;
  tone: Status | "dirty";
  text: string;
}

export type RailSection = Omit<InspectorSection, "component">;

const dirtyMarker = (w: Worktree): RailMarker | null => (w.git?.dirty ? { glyph: "*", tone: "dirty", text: "dirty" } : null);

const gitSectionMarker = (s: State, w: Worktree): RailMarker | null => gitMarkers(s, w) ?? dirtyMarker(w);

const BEFORE_ADDONS: readonly RailSection[] = [
  { id: "worktree", label: "Worktree", icon: Tag },
  { id: "git", label: "Git", icon: GitBranch, marker: gitSectionMarker },
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

export function toggleSection(id: RightSection, open: boolean): void {
  const folded = getState().ui.collapsedSections ?? [];
  setUi({ collapsedSections: open ? folded.filter((x) => x !== id) : [...new Set([...folded, id])] });
}

export function InspectorSection({ id, control, className, children }: { id: RightSection; control?: ReactNode; className?: string; children: ReactNode }) {
  const open = useStore((s) => !(s.ui.collapsedSections ?? []).includes(id));
  const section = railSections().find((x) => x.id === id);
  const Icon = section?.icon;
  return (
    <Collapsible open={open} onOpenChange={(next) => toggleSection(id, next)}>
      <section className={className ? `side-section ${className}` : "side-section"} data-section={id}>
        <div className="section-label">
          <CollapsibleTrigger className="section-fold">
            {Icon && <Icon className="icon" aria-hidden />}
            {section?.label.toLowerCase() ?? id}
          </CollapsibleTrigger>
          {control}
          <ChevronDown className="icon chevron" data-open={open} aria-hidden onClick={() => toggleSection(id, !open)} />
        </div>
        <CollapsiblePanel>{children}</CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
