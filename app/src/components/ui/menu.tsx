import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx, type WithClassName } from "./cx";

/** Declarative menu description. Rendering always goes through the Base UI menu parts. */
export type MenuItem =
  | { separator: true }
  | {
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      run?: () => void;
      submenu?: MenuItem[];
    };

export type MenuEntry = Exclude<MenuItem, { separator: true }>;

export type MenuSide = "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
export type MenuAlign = "start" | "center" | "end";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

type PositionerProps = WithClassName<ComponentProps<typeof Menu.Positioner>>;

export function DropdownMenuContent({ children, className, side = "bottom", align = "start", sideOffset = 4, ...rest }: PositionerProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner className="menu-positioner" side={side} align={align} sideOffset={sideOffset} collisionPadding={8} {...rest}>
        <Menu.Popup className={cx("menu-popup", className)}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function ItemBody({ icon, shortcut, checked, children }: { icon?: ReactNode; shortcut?: string; checked?: boolean; children: ReactNode }) {
  return (
    <>
      <span className="menu-check">{checked ? <Check className="icon" /> : icon}</span>
      <span className="menu-label">{children}</span>
      {shortcut && <span className="menu-shortcut">{shortcut}</span>}
    </>
  );
}

export interface DropdownMenuItemProps extends WithClassName<ComponentProps<typeof Menu.Item>> {
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
}

export function DropdownMenuItem({ icon, shortcut, danger, className, children, ...rest }: DropdownMenuItemProps) {
  return (
    <Menu.Item className={cx("menu-item", danger && "menu-danger", className)} {...rest}>
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </Menu.Item>
  );
}

export interface DropdownMenuCheckboxItemProps extends WithClassName<ComponentProps<typeof Menu.CheckboxItem>> {
  shortcut?: string;
}

export function DropdownMenuCheckboxItem({ shortcut, className, children, checked, ...rest }: DropdownMenuCheckboxItemProps) {
  return (
    <Menu.CheckboxItem className={cx("menu-item", className)} checked={checked} {...rest}>
      <ItemBody shortcut={shortcut} checked={checked}>
        {children}
      </ItemBody>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuSeparator(props: WithClassName<ComponentProps<typeof Menu.Separator>>) {
  return <Menu.Separator className="menu-sep" {...props} />;
}

export function DropdownMenuLabel({ className, ...rest }: WithClassName<ComponentProps<typeof Menu.GroupLabel>>) {
  return <Menu.GroupLabel className={cx("menu-group-label", className)} {...rest} />;
}

export const DropdownMenuGroup = Menu.Group;

export function DropdownMenuSub({ label, icon, disabled, children }: { label: ReactNode; icon?: ReactNode; disabled?: boolean; children: ReactNode }) {
  return (
    <Menu.SubmenuRoot disabled={disabled}>
      <Menu.SubmenuTrigger className="menu-item" disabled={disabled}>
        <span className="menu-check">{icon}</span>
        <span className="menu-label">{label}</span>
        <ChevronRight className="icon menu-chevron" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" sideOffset={-4} alignOffset={-5} collisionPadding={8}>
          <Menu.Popup className="menu-popup">{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

/** Renders a declarative item list with the menu parts above. Accepts a function so items are computed when the menu opens. */
export function MenuItems({ items }: { items: MenuItem[] | (() => MenuItem[]) }) {
  const list = typeof items === "function" ? items() : items;
  return (
    <>
      {list.map((it, i) => {
        if ("separator" in it) return <DropdownMenuSeparator key={i} />;
        if (it.submenu) {
          return (
            <DropdownMenuSub key={i} label={it.label} icon={it.icon} disabled={it.disabled}>
              <MenuItems items={it.submenu} />
            </DropdownMenuSub>
          );
        }
        if (it.checked !== undefined) {
          return (
            <DropdownMenuCheckboxItem key={i} checked={it.checked} disabled={it.disabled} shortcut={it.shortcut} onCheckedChange={() => it.run?.()}>
              {it.label}
            </DropdownMenuCheckboxItem>
          );
        }
        return (
          <DropdownMenuItem key={i} icon={it.icon} shortcut={it.shortcut} danger={it.danger} disabled={it.disabled} onClick={() => it.run?.()}>
            {it.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export type MenuAnchor = { x: number; y: number } | Element;

export interface AnchoredMenuProps {
  open: boolean;
  anchor: MenuAnchor;
  items: MenuItem[] | (() => MenuItem[]);
  onOpenChange: (open: boolean, reason?: string) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  side?: MenuSide;
  align?: MenuAlign;
}

/**
 * A menu opened by code at a point or next to an element. It still renders a zero-size
 * trigger at the anchor: Base UI registers a root menu's floating node through its trigger,
 * and without one every submenu counts as a sibling and closes the root when it opens.
 */
export function AnchoredMenu({ open, anchor, items, onOpenChange, onOpenChangeComplete, side, align }: AnchoredMenuProps) {
  const point = !(anchor instanceof Element);
  const at = point ? anchor : { x: 0, y: 0 };
  return (
    <Menu.Root open={open} onOpenChange={(o, d) => onOpenChange(o, d.reason)} onOpenChangeComplete={onOpenChangeComplete}>
      <Menu.Trigger render={<span className="menu-anchor" style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} aria-hidden tabIndex={-1} />} />
      <DropdownMenuContent anchor={point ? undefined : anchor} side={side ?? (point ? "right" : "bottom")} align={align ?? "start"} sideOffset={point ? 0 : 4}>
        <MenuItems items={items} />
      </DropdownMenuContent>
    </Menu.Root>
  );
}
