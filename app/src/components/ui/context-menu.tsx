import { ContextMenu as C } from "@base-ui/react/context-menu";
import type { ComponentProps } from "react";
import { cx, type WithClassName } from "./cx";

/** Right-click area. Use `render` on the trigger to make an existing element the area. */
export const ContextMenu = C.Root;
export const ContextMenuTrigger = C.Trigger;

export function ContextMenuContent({ children, className, ...rest }: WithClassName<ComponentProps<typeof C.Positioner>>) {
  return (
    <C.Portal>
      <C.Positioner className="menu-positioner" collisionPadding={8} {...rest}>
        <C.Popup className={cx("menu-popup", className)}>{children}</C.Popup>
      </C.Positioner>
    </C.Portal>
  );
}
