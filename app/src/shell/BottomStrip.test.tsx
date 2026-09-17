import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState, type State } from "../store";
import type { Diagnostic, SidebarMode, SystemStats } from "../types";

const { daemonEvents } = vi.hoisted(() => ({
  daemonEvents: [
    { at_ms: 2_000, level: "warning", source: "usage", message: "codex usage fetch failed" },
    { at_ms: 1_000, level: "info", source: "config", message: "config reloaded" },
  ],
}));

vi.mock("../api", async (importOriginal) => (await import("../test-api")).mockApi(await importOriginal<typeof import("../api")>(), vi.fn((method: string) => Promise.resolve(method === "diagnostics_list" ? daemonEvents : []))));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("0.1.3")) }));

const { BottomStrip } = await import("./BottomStrip");
const { TooltipProvider } = await import("../components/ui");

const initial: State = getState();
const GB = 1024 ** 3;
const system: SystemStats = { at_ms: 0, cpu_percent: 12.4, memory_used_bytes: 8.4 * GB, memory_total_bytes: 32 * GB, gpu_percent: null, vram_used_bytes: null, vram_total_bytes: null, daemon_rss_bytes: 18 * 1024 ** 2, top_worktree: null };

function show(leftMode: SidebarMode, patch: Partial<State> = {}) {
  setState({ connected: true, daemonHealth: "healthy", system, ...patch });
  return render(
    <TooltipProvider>
      <BottomStrip left={leftMode} />
    </TooltipProvider>,
  );
}

beforeEach(() => setState(initial));
afterEach(cleanup);

describe("bottom strip", () => {
  it("shows help, addon items, metrics, and health with the left sidebar open", async () => {
    const { container } = show("open");
    expect(container.querySelector(".bottom-strip")).toHaveAttribute("data-left", "open");
    expect(container.querySelector(".bottom-middle > .bottom-items")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CPU 12%, MEM 8.4G" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Daemon healthy, Tomo 0.1.3" })).toBeInTheDocument();
    expect(screen.queryByText(/GPU/)).toBeNull();
  });

  it("keeps both controls in the minimal rail", () => {
    const { container } = show("minimal");
    expect(container.querySelector(".bottom-strip")).toHaveAttribute("data-left", "minimal");
    expect(container.querySelector(".bottom-left")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("drops the bottom-left section when the left sidebar is closed", () => {
    const { container } = show("closed");
    expect(container.querySelector(".bottom-left")).toBeNull();
    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    expect(container.querySelector(".bottom-items")).not.toBeNull();
  });

  it("names the disconnected state in text and hides stale metrics", async () => {
    show("open", { connected: false, daemonHealth: "disconnected", system: { ...system, gpu_percent: 3 } });
    expect(await screen.findByRole("button", { name: /^Daemon disconnected/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^CPU/ })).toBeNull();
  });

  it("shows GPU only when the machine reports it", () => {
    show("open", { system: { ...system, gpu_percent: 3 } });
    expect(screen.getByRole("button", { name: "CPU 12%, MEM 8.4G, GPU 3%" })).toBeInTheDocument();
  });

  it("opens diagnostics from the health dot with merged system events", async () => {
    const local: Diagnostic[] = [daemonEvents[0] as Diagnostic, { at_ms: 3_000, level: "info", source: "daemon", message: "reconnected" }];
    show("open", { diagnostics: local });
    await userEvent.click(await screen.findByRole("button", { name: /^Daemon healthy/ }));
    expect(await screen.findByText("Tomo diagnostics")).toBeInTheDocument();
    expect(await screen.findByText("config reloaded")).toBeInTheDocument();
    const messages = [...document.querySelectorAll(".diagnostics .diag-message")].map((n) => n.textContent);
    expect(messages.filter((m) => m && ["reconnected", "codex usage fetch failed", "config reloaded"].includes(m))).toEqual(["reconnected", "codex usage fetch failed", "config reloaded"]);
    await userEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    expect(getState().dialog).toEqual({ kind: "diagnostics" });
  });
});
