import { PreviewCard as P } from "@base-ui/react/preview-card";
import type { ComponentProps, ReactElement, ReactNode, SyntheticEvent } from "react";
import { cx, type WithClassName } from "./cx";

export const PreviewCard = P.Root;

/** Opens the card after the pointer rests on the trigger. Pass the trigger element through `render`. */
export function PreviewCardTrigger({ delay = 600, closeDelay = 80, ...rest }: ComponentProps<typeof P.Trigger>) {
  return <P.Trigger delay={delay} closeDelay={closeDelay} {...rest} />;
}

export function PreviewCardContent({ children, className, side = "bottom", align = "start", sideOffset = 6, ...rest }: WithClassName<ComponentProps<typeof P.Positioner>>) {
  return (
    <P.Portal>
      <P.Positioner className="popover-positioner" side={side} align={align} sideOffset={sideOffset} collisionPadding={8} {...rest}>
        <P.Popup className={cx("popover", className)}>{children}</P.Popup>
      </P.Positioner>
    </P.Portal>
  );
}

export type HoverCardSide = "top" | "bottom" | "left" | "right";

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Shows `content` after the pointer rests on the child. The child must forward `ref` and props
 * to a DOM element. Events inside the card do not reach the trigger's parents through the portal.
 */
export function HoverCard({ content, side = "bottom", align = "start", children }: { content: ReactNode; side?: HoverCardSide; align?: "start" | "center" | "end"; children: ReactElement }) {
  if (!content) return children;
  return (
    <PreviewCard>
      <PreviewCardTrigger render={children} delay={500} closeDelay={120} />
      <PreviewCardContent side={side} align={align} className="preview-card">
        <div onClick={stop} onPointerDown={stop} onContextMenu={stop}>
          {content}
        </div>
      </PreviewCardContent>
    </PreviewCard>
  );
}
