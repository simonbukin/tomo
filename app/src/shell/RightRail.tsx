import { IconButton } from "../components/ui";
import { railSections, sectionMarkers } from "../sections";
import { setUi, useStore } from "../store";
import type { Worktree } from "../types";

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
