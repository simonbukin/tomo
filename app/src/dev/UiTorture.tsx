import { Bold, Ellipsis, Info, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  IconButton,
  MenuItems,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Select,
  Separator,
  Tooltip,
  type MenuItem,
} from "../components/ui";

/**
 * Dev-only fixture: every primitive, every state, at every viewport edge.
 * Open the dev server with `#ui-torture` in the URL. Never linked from the product.
 */
export function UiTorture() {
  const [log, setLog] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [fruit, setFruit] = useState<string | null>("plum");
  const [checked, setChecked] = useState(true);
  const say = (m: string) => setLog((l) => [m, ...l].slice(0, 8));
  const items: MenuItem[] = [
    { label: "open", shortcut: "⌘O", run: () => say("open") },
    { label: "checked item", checked, run: () => setChecked((c) => !c) },
    { label: "disabled item", disabled: true, run: () => say("never") },
    { separator: true },
    { label: "submenu", submenu: [{ label: "child one", run: () => say("child one") }, { label: "nested", submenu: [{ label: "grandchild", run: () => say("grandchild") }, { separator: true }, { label: "danger inside", danger: true, run: () => say("danger inside") }] }] },
    { label: "long menu", submenu: Array.from({ length: 40 }, (_, i) => ({ label: `entry ${i + 1}`, run: () => say(`entry ${i + 1}`) })) },
    { separator: true },
    { label: "delete", danger: true, icon: <Trash2 className="icon" />, run: () => say("delete") },
  ];
  const corner = (label: string, style: React.CSSProperties) => (
    <div style={{ position: "fixed", ...style }}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" />}>{label}</DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={items} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  return (
    <div style={{ padding: "48px 24px", display: "flex", flexDirection: "column", gap: 16, height: "100%", overflow: "auto" }}>
      <h1 style={{ margin: 0, fontSize: 14 }}>ui torture</h1>
      <p className="muted" style={{ margin: 0 }}>
        Right-click the box, tab through controls, open menus at each corner, resize the window.
      </p>

      <section style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="default" onClick={() => say("default")}>default</Button>
        <Button onClick={() => say("subtle")}>subtle</Button>
        <Button variant="ghost" onClick={() => say("ghost")}>ghost</Button>
        <Button variant="danger" onClick={() => say("danger")}>danger</Button>
        <Button variant="link" onClick={() => say("link")}>link</Button>
        <Button size="sm">small</Button>
        <Button disabled>disabled</Button>
        <IconButton label="Bold" onClick={() => say("bold")}>
          <Bold className="icon" />
        </IconButton>
        <Tooltip content="A tooltip on a text button">
          <Button variant="ghost">hover me</Button>
        </Tooltip>
        <Separator orientation="vertical" />
        <span className="kbd">⌘K</span>
        <code>mono code</code>
      </section>

      <Separator />

      <section style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <DropdownMenu>
          <DropdownMenuTrigger render={<IconButton label="Dropdown menu" />}>
            <Ellipsis className="icon" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <MenuItems items={items} />
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" />}>
            <Info className="icon" /> popover
          </PopoverTrigger>
          <PopoverContent>
            <PopoverTitle>Popover</PopoverTitle>
            <PopoverDescription>Dismiss with Escape or an outside click. Focus returns to the trigger.</PopoverDescription>
            <input placeholder="focusable inside" />
          </PopoverContent>
        </Popover>
        <Button onClick={() => setDialog(true)}>dialog</Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>confirm (destructive)</Button>
        <div style={{ width: 160 }}>
          <Select value={fruit} onValueChange={(v) => { setFruit(v); say(`select ${v}`); }} options={[{ value: "apple", label: "apple" }, { value: "plum", label: "plum" }, { value: "yuzu", label: "yuzu" }, { value: "durian", label: "durian (disabled)", disabled: true }]} aria-label="Fruit" />
        </div>
      </section>

      <ContextMenu>
        <ContextMenuTrigger style={{ border: "1px dashed var(--line-strong)", borderRadius: 4, padding: 32, textAlign: "center", color: "var(--fg-2)" }}>right-click here</ContextMenuTrigger>
        <ContextMenuContent>
          <MenuItems items={items} />
        </ContextMenuContent>
      </ContextMenu>

      <pre className="mono" style={{ margin: 0, fontSize: 11, color: "var(--fg-2)", minHeight: 120 }}>{log.join("\n") || "(events show here)"}</pre>

      {corner("top-left", { top: 8, left: 8 })}
      {corner("top-right", { top: 8, right: 8 })}
      {corner("bottom-left", { bottom: 8, left: 8 })}
      {corner("bottom-right", { bottom: 8, right: 8 })}

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogTitle>Plain dialog</DialogTitle>
          <DialogDescription>Tab cycles inside. Escape closes. Focus returns to the button that opened it.</DialogDescription>
          <input placeholder="first field" />
          <input placeholder="second field" />
          <DialogActions>
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button variant="default" onClick={() => { setDialog(false); say("dialog ok"); }}>OK</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete the thing?" description="This cannot be undone." confirmLabel="Delete" destructive check="also delete the backup" onConfirm={(c) => say(`confirmed, checkbox=${c}`)} />
    </div>
  );
}
