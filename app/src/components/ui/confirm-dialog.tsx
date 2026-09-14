import { useRef, useState } from "react";
import { Button } from "./button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "./dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Optional checkbox shown under the description. Its value is passed to `onConfirm`. */
  check?: string;
  onConfirm: (checked: boolean) => void;
}

/** The one confirmation pattern. Focus starts on the confirm button; Escape cancels. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "OK", cancelLabel = "Cancel", destructive = false, check, onConfirm }: ConfirmDialogProps) {
  const [checked, setChecked] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirm = () => {
    onOpenChange(false);
    onConfirm(checked);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(o) => !o && setChecked(false)}>
      <DialogContent width={420} initialFocus={confirmRef}>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        {check && (
          <label className="check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {check}
          </label>
        )}
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
          <Button ref={confirmRef} variant={destructive ? "danger" : "default"} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
