import { Tooltip as T } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delay={450} closeDelay={0}>
      {children}
    </T.Provider>
  );
}

/** Wraps one focusable child. The child must forward `ref` and props to a DOM element. */
export function Tooltip({ content, side = "bottom", children }: { content: ReactNode; side?: TooltipSide; children: ReactElement }) {
  if (!content) return children;
  return (
    <T.Root>
      <T.Trigger render={children} />
      <T.Portal>
        <T.Positioner side={side} sideOffset={6} collisionPadding={8} className="tip-positioner">
          <T.Popup className="tip">{content}</T.Popup>
        </T.Positioner>
      </T.Portal>
    </T.Root>
  );
}
