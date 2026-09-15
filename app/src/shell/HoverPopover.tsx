import { useState, type ReactElement, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger, PreviewCard, PreviewCardContent, PreviewCardTrigger } from "../components/ui";

type Align = "start" | "center" | "end";

/** A bottom strip item: a short preview on hover and a larger popover on click. The preview closes while the popover is open. */
export function HoverPopover({ trigger, title, detailTitle = title, preview, detail, align = "start", className }: { trigger: ReactElement; title: string; detailTitle?: string; preview: ReactNode; detail: ReactNode; align?: Align; className?: string }) {
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setHover(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PreviewCard open={hover && !open} onOpenChange={(next) => setHover(next)}>
        <PreviewCardTrigger render={<PopoverTrigger render={trigger} />} delay={500} closeDelay={120} />
        <PreviewCardContent side="top" align={align} className="preview-card bottom-pop">
          <div className="bottom-pop-title">{title}</div>
          {preview}
        </PreviewCardContent>
      </PreviewCard>
      <PopoverContent side="top" align={align} className={`bottom-pop${className ? ` ${className}` : ""}`}>
        <PopoverTitle className="bottom-pop-title">{detailTitle}</PopoverTitle>
        {detail}
      </PopoverContent>
    </Popover>
  );
}
