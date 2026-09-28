import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { pasteClipboard } from "./terminalHooks";

const withClipboardText = (read: () => Promise<string>) => Object.defineProperty(navigator, "clipboard", { value: { readText: read }, configurable: true });

describe("pasteClipboard", () => {
  afterEach(() => invoke.mockReset());

  it("pastes text and leaves the image path alone", async () => {
    withClipboardText(async () => "echo hi");
    const term = { paste: vi.fn() };
    await pasteClipboard(term);
    expect(term.paste).toHaveBeenCalledWith("echo hi");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("pastes the escaped path of a saved clipboard image when there is no text", async () => {
    withClipboardText(async () => "");
    invoke.mockResolvedValue("/tmp/tomo paste/clipboard-1.png");
    const term = { paste: vi.fn() };
    await pasteClipboard(term);
    expect(invoke).toHaveBeenCalledWith("clipboard_image");
    expect(term.paste).toHaveBeenCalledWith("'/tmp/tomo paste/clipboard-1.png' ");
  });

  it("pastes nothing when the clipboard holds neither text nor an image", async () => {
    withClipboardText(() => Promise.reject(new Error("denied")));
    invoke.mockResolvedValue(null);
    const term = { paste: vi.fn() };
    await pasteClipboard(term);
    expect(term.paste).not.toHaveBeenCalled();
  });
});
