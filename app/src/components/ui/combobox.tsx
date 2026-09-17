import { Autocomplete } from "@base-ui/react/autocomplete";
import type { KeyboardEvent, ReactNode } from "react";
import { cx, plainTextInput } from "./cx";

export interface ComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  /** The list to filter. A value that matches nothing stays in the box. */
  items: string[];
  /** Runs when the user picks an item with the pointer or with Enter. */
  onSelect?: (value: string) => void;
  /** Runs when the arrow keys or the pointer move the highlight. */
  onHighlight?: (value: string | undefined) => void;
  /** A quiet second column for one item, such as a time or a remote. */
  detail?: (value: string) => ReactNode;
  placeholder?: string;
  empty?: ReactNode;
  className?: string;
  onKeyDown?: (event: KeyboardEvent) => void;
  onBlur?: () => void;
  "aria-label"?: string;
}

/** A text box that filters a list and still accepts text that no item matches. */
export function Combobox({ value, onValueChange, items, onSelect, onHighlight, detail, placeholder, empty, className, onKeyDown, onBlur, ...aria }: ComboboxProps) {
  return (
    <Autocomplete.Root items={items} value={value} onValueChange={onValueChange} onItemHighlighted={(item) => onHighlight?.(item)}>
      <Autocomplete.Input className={cx("combobox-input", className)} placeholder={placeholder} onKeyDown={onKeyDown} onBlur={onBlur} {...plainTextInput} {...aria} />
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="combobox-positioner" sideOffset={4} collisionPadding={8}>
          <Autocomplete.Popup className="combobox-popup">
            {empty && <Autocomplete.Empty className="combobox-empty">{empty}</Autocomplete.Empty>}
            <Autocomplete.List className="combobox-list">
              {(item: string) => (
                <Autocomplete.Item key={item} value={item} className="combobox-item" onClick={() => onSelect?.(item)}>
                  <span className="combobox-item-text">{item}</span>
                  {detail && <span className="combobox-item-detail">{detail(item)}</span>}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
