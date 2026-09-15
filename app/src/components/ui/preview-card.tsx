import { PreviewCard as P } from "@base-ui/react/preview-card";
import type { ComponentProps } from "react";
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
