import { Dialog as D } from "@base-ui/react/dialog";
import type { ComponentProps, HTMLAttributes } from "react";
import { cx, type WithClassName } from "./cx";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export interface DialogContentProps extends WithClassName<ComponentProps<typeof D.Popup>> {
  /** Popup width in pixels. The popup never exceeds the viewport. */
  width?: number;
}

export function DialogContent({ className, width, style, children, ...rest }: DialogContentProps) {
  return (
    <D.Portal>
      <D.Backdrop className="dialog-backdrop" />
      <D.Popup className={cx("dialog", className)} style={width ? { width, ...style } : style} {...rest}>
        {children}
      </D.Popup>
    </D.Portal>
  );
}

export function DialogTitle({ className, ...rest }: WithClassName<ComponentProps<typeof D.Title>>) {
  return <D.Title className={cx("dialog-title", className)} {...rest} />;
}

export function DialogDescription({ className, ...rest }: WithClassName<ComponentProps<typeof D.Description>>) {
  return <D.Description className={cx("dialog-desc", className)} {...rest} />;
}

export function DialogActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("dialog-actions", className)} {...rest} />;
}
