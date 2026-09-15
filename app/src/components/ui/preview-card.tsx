import { PreviewCard as P } from "@base-ui/react/preview-card";
import type { ReactElement, ReactNode, SyntheticEvent } from "react";

export type HoverCardSide = "top" | "bottom" | "left" | "right";

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Shows `content` after the pointer rests on the child. The child must forward `ref` and props
 * to a DOM element. Events inside the card do not reach the trigger's parents through the portal.
 */
export function HoverCard({ content, side = "bottom", align = "start", children }: { content: ReactNode; side?: HoverCardSide; align?: "start" | "center" | "end"; children: ReactElement }) {
  if (!content) return children;
  return (
    <P.Root>
      <P.Trigger render={children} delay={500} closeDelay={120} />
      <P.Portal>
        <P.Positioner className="popover-positioner" side={side} align={align} sideOffset={6} collisionPadding={8}>
          <P.Popup className="popover preview-card" onClick={stop} onPointerDown={stop} onContextMenu={stop}>
            {content}
          </P.Popup>
        </P.Positioner>
      </P.Portal>
    </P.Root>
  );
}
