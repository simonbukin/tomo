import { Collapsible as Base } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CollapsibleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/** A disclosure. The caller owns `open`, so a section can remember its state between sessions. */
export function Collapsible({ open, onOpenChange, children, className }: CollapsibleProps) {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange} className={className}>
      {children}
    </Base.Root>
  );
}

export function CollapsibleTrigger({ children, className }: { children: ReactNode; className?: string }) {
  return <Base.Trigger className={cx("collapsible-trigger", className)}>{children}</Base.Trigger>;
}

export function CollapsiblePanel({ children, className }: { children: ReactNode; className?: string }) {
  return <Base.Panel className={cx("collapsible-panel", className)}>{children}</Base.Panel>;
}
