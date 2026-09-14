import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Tooltip, type TooltipSide } from "./tooltip";

export type ButtonVariant = "default" | "subtle" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "subtle", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)} {...rest} />;
}

export interface IconButtonProps extends Omit<ButtonProps, "size" | "aria-label"> {
  /** Accessible name; also the tooltip text. */
  label: string;
  tooltipSide?: TooltipSide;
  children?: ReactNode;
}

/** An icon-only control. Every one gets a tooltip and an accessible name. */
export function IconButton({ label, tooltipSide, variant = "ghost", ...rest }: IconButtonProps) {
  return (
    <Tooltip content={label} side={tooltipSide}>
      <Button aria-label={label} variant={variant} size="icon" {...rest} />
    </Tooltip>
  );
}
