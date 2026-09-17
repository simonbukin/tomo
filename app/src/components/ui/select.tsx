import { Select as S } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  value: V | null;
  onValueChange: (value: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}

/** A single-value select with keyboard navigation and typeahead. */
export function Select<V extends string>({ value, onValueChange, options, placeholder = "Choose...", disabled, className, size = "md", ...aria }: SelectProps<V>) {
  const items = options.map((o) => ({ value: o.value, label: o.label }));
  return (
    <S.Root<V, false> value={value} onValueChange={(v) => v !== null && onValueChange(v)} items={items} disabled={disabled}>
      <S.Trigger className={cx("select-trigger", `select-${size}`, className)} {...aria}>
        <S.Value className="select-value" placeholder={placeholder} />
        <S.Icon className="select-icon">
          <ChevronDown className="icon" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Positioner className="select-positioner" sideOffset={4} collisionPadding={8}>
          <S.Popup className="select-popup">
            <S.List className="select-list">
              {options.map((o) => (
                <S.Item key={o.value} value={o.value} disabled={o.disabled} className="select-item">
                  <S.ItemIndicator className="select-check">
                    <Check className="icon" />
                  </S.ItemIndicator>
                  <S.ItemText className="select-item-text">{o.label}</S.ItemText>
                </S.Item>
              ))}
            </S.List>
          </S.Popup>
        </S.Positioner>
      </S.Portal>
    </S.Root>
  );
}
