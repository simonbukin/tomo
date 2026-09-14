import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredMenu, Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, MenuItems, Popover, PopoverContent, PopoverTrigger, Select, TooltipProvider, type MenuItem } from "./index";

afterEach(cleanup);

function items(run: (label: string) => void): MenuItem[] {
  return [
    { label: "open", run: () => run("open") },
    { label: "locked", disabled: true, run: () => run("locked") },
    { label: "flag", checked: true, run: () => run("flag") },
    { separator: true },
    { label: "more", submenu: [{ label: "child", run: () => run("child") }] },
  ];
}

describe("menu", () => {
  it("opens from a trigger, runs an item, and closes", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={items(run)} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "open" }));
    expect(run).toHaveBeenCalledWith("open");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("a disabled item cannot activate", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={items(run)} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "menu" }));
    const locked = await screen.findByRole("menuitem", { name: "locked" });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await user.click(locked);
    expect(run).not.toHaveBeenCalled();
  });

  it("keyboard: arrows move, right arrow opens the submenu, Escape closes and returns focus", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={items(run)} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole("button", { name: "menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "more" })).toHaveAttribute("data-highlighted"));
    await user.keyboard("{ArrowRight}");
    const child = await screen.findByRole("menuitem", { name: "child" });
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledWith("child");
    expect(child).not.toBeInTheDocument();
    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("a checked item shows its checked state", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={items(() => {})} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "menu" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "flag" })).toHaveAttribute("aria-checked", "true");
  });

  it("an anchored menu opens at a point without a trigger and reports close", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<AnchoredMenu open anchor={{ x: 40, y: 40 }} items={items(() => {})} onOpenChange={onOpenChange} />);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});

describe("dialog", () => {
  it("confirm focuses the confirm button, Escape cancels, and focus returns to the opener", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>archive</Button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title="Archive?" description="Sure?" confirmLabel="Archive" onConfirm={onConfirm} />
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "archive" });
    await user.click(opener);
    const ok = await screen.findByRole("button", { name: "Archive" });
    await waitFor(() => expect(ok).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());
    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});

describe("popover", () => {
  it("dismisses on outside click", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Popover>
          <PopoverTrigger render={<Button />}>info</PopoverTrigger>
          <PopoverContent>hello</PopoverContent>
        </Popover>
        <Button>elsewhere</Button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "info" }));
    expect(await screen.findByText("hello")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    await waitFor(() => expect(screen.queryByText("hello")).toBeNull());
  });
});

describe("select", () => {
  it("changes the value from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Host() {
      const [v, setV] = useState<string | null>("a");
      return <Select aria-label="Pick" value={v} onValueChange={(x) => { setV(x); onChange(x); }} options={[{ value: "a", label: "alpha" }, { value: "b", label: "beta" }]} />;
    }
    render(<Host />);
    const trigger = screen.getByRole("combobox", { name: "Pick" });
    await act(async () => trigger.focus());
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("b"));
  });
});

describe("tooltip", () => {
  it("icon buttons expose their label", () => {
    render(
      <TooltipProvider>
        <Button aria-label="Close" />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
