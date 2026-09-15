import { SortableContext } from "@dnd-kit/sortable";
import { Bold, Ellipsis, Info, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { keepInPlace, LayoutDnd, PaneDropZone, usePaneDrag, useTabSortable } from "../LayoutDnd";
import { movePane, reorder } from "../layoutModel";
import type { LayoutNode } from "../types";
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

      <LayoutTorture say={say} />

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

const leaf = (pane_id: string): LayoutNode => ({ type: "leaf", pane_id });
const INITIAL_LAYOUT: LayoutNode = {
  type: "split", id: "s1", direction: "horizontal", ratio: 0.5,
  first: leaf("claude"),
  second: { type: "split", id: "s2", direction: "vertical", ratio: 0.5, first: leaf("shell"), second: { type: "split", id: "s3", direction: "horizontal", ratio: 0.5, first: leaf("app"), second: leaf("a pane with a very long name that must truncate") } },
};

/** Tab strip and pane grid on local state: drag tabs to reorder, drag a pane chip onto a pane or a tab. */
function LayoutTorture({ say }: { say: (m: string) => void }) {
  const [tabs, setTabs] = useState(["Claude", "shell", "App", "Sampler", "a tab with a very long title that must truncate"]);
  const [layout, setLayout] = useState(INITIAL_LAYOUT);
  const splits = useRef(0);
  return (
    <LayoutDnd
      onTabMove={(id, position) => {
        setTabs((t) => reorder(t, id, position));
        say(`tab_move ${id} → ${position}`);
      }}
      onPaneMove={(pane, target, place) => {
        if ("tabId" in target) return say(`pane_move ${pane} → tab ${target.tabId}`);
        splits.current += 1;
        setLayout((l) => movePane(l, pane, target.paneId, place, `m${splits.current}`) ?? l);
        say(`pane_move ${pane} → ${target.paneId} ${place}`);
      }}
    >
      <div style={{ border: "1px dashed var(--line-strong)", borderRadius: 4, display: "flex", flexDirection: "column", height: 380, resize: "both", overflow: "hidden", minWidth: 240, minHeight: 160 }}>
        <div className="tabbar" role="tablist">
          <SortableContext items={tabs} strategy={keepInPlace}>
            {tabs.map((t, i) => <TortureTab key={t} id={t} active={i === 0} />)}
          </SortableContext>
          <button className="link" onClick={() => setLayout(INITIAL_LAYOUT)}>reset panes</button>
        </div>
        <div className="layout-root">
          <TortureNode node={layout} />
        </div>
      </div>
    </LayoutDnd>
  );
}

function TortureTab({ id, active }: { id: string; active: boolean }) {
  const drag = useTabSortable(id);
  return (
    <div ref={drag.ref} {...drag.props} role="tab" aria-selected={active} style={drag.style} className={`tab${active ? " tab-active" : ""} ${drag.className}`}>
      <span className="tab-title">{id}</span>
    </div>
  );
}

function TortureNode({ node }: { node: LayoutNode }) {
  if (node.type === "leaf") return <TorturePane id={node.pane_id} />;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="split-child" style={{ flexBasis: `${node.ratio * 100}%` }}><TortureNode node={node.first} /></div>
      <div className={`splitter splitter-${node.direction}`} />
      <div className="split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}><TortureNode node={node.second} /></div>
    </div>
  );
}

function TorturePane({ id }: { id: string }) {
  const drag = usePaneDrag(id, "torture", id);
  return (
    <div className="pane-wrap">
      <div className="pane">
        <div className="pane-legend">
          <span className="chip pane-grip" ref={drag.ref} {...drag.props}><strong>{id}</strong></span>
        </div>
        <div className="pane-body mono">{`select this text\n${id}`}</div>
        <PaneDropZone paneId={id} />
      </div>
    </div>
  );
}
