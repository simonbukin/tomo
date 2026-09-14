import { Popover as P } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cx, type WithClassName } from "./cx";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

export function PopoverContent({ children, className, side = "bottom", align = "start", sideOffset = 6, ...rest }: WithClassName<ComponentProps<typeof P.Positioner>>) {
  return (
    <P.Portal>
      <P.Positioner className="popover-positioner" side={side} align={align} sideOffset={sideOffset} collisionPadding={8} {...rest}>
        <P.Popup className={cx("popover", className)}>{children}</P.Popup>
      </P.Positioner>
    </P.Portal>
  );
}

export function PopoverTitle({ className, ...rest }: WithClassName<ComponentProps<typeof P.Title>>) {
  return <P.Title className={cx("popover-title", className)} {...rest} />;
}

export function PopoverDescription({ className, ...rest }: WithClassName<ComponentProps<typeof P.Description>>) {
  return <P.Description className={cx("popover-desc", className)} {...rest} />;
}
