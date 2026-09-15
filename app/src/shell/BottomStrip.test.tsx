import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFrame, applySnapshot, getState, setState, type State } from "../store";
import type { Diagnostic, SidebarMode, Snapshot, SystemStats, UsageSnapshot } from "../types";

const { daemonEvents, refreshed } = vi.hoisted(() => ({
  daemonEvents: [
    { at_ms: 2_000, level: "warning", source: "usage", message: "codex usage fetch failed" },
    { at_ms: 1_000, level: "info", source: "config", message: "config reloaded" },
  ],
  refreshed: [{ provider: "claude", available: true, reason: null, fetched_at_ms: 1, buckets: [{ label: "weekly", fraction_used: 0.9, resets_at_ms: null, detail: null }] }],
}));

const rpc = vi.fn((method: string, _params?: unknown) => Promise.resolve(method === "diagnostics_list" ? daemonEvents : method === "usage_get" ? refreshed : []));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), rpc: (method: string, params?: unknown) => rpc(method, params) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("0.1.3")) }));

const { BottomStrip } = await import("./BottomStrip");
const { TooltipProvider } = await import("../components/ui");

const initial: State = getState();
const GB = 1024 ** 3;
const usage: UsageSnapshot[] = [
  { provider: "claude", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "session", fraction_used: 0.4, resets_at_ms: null, detail: null }, { label: "week", fraction_used: 0.83, resets_at_ms: null, detail: null }] },
  { provider: "codex", available: false, reason: "not signed in", buckets: [], fetched_at_ms: 0 },
  { provider: "pi", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "x", fraction_used: 0.1, resets_at_ms: null, detail: null }] },
];
const system: SystemStats = { at_ms: 0, cpu_percent: 12.4, memory_used_bytes: 8.4 * GB, memory_total_bytes: 32 * GB, gpu_percent: null, vram_used_bytes: null, vram_total_bytes: null, daemon_rss_bytes: 18 * 1024 ** 2, top_worktree: null };

const usageChanged = (snapshots: UsageSnapshot[]) => applyFrame({ seq: 1, event: "usage_changed", data: { snapshots } });

function show(leftMode: SidebarMode, patch: Partial<State> = {}, snapshots: UsageSnapshot[] = usage) {
  setState({ connected: true, daemonHealth: "healthy", system, ...patch });
  usageChanged(snapshots);
  return render(
    <TooltipProvider>
      <BottomStrip left={leftMode} />
    </TooltipProvider>,
  );
}

beforeEach(() => setState(initial));
afterEach(cleanup);

describe("bottom strip", () => {
  it("shows help, usage, metrics, and health with the left sidebar open", async () => {
    const { container } = show("open");
    expect(container.querySelector(".bottom-strip")).toHaveAttribute("data-left", "open");
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude usage 83%" })).toHaveClass("tone-warning");
    expect(screen.getByRole("button", { name: "Codex usage unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pi usage/ })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Claude usage 83%" })).toBeInTheDocument();
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
    expect(screen.getByText("Codex usage unavailable · not signed in")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    expect(getState().dialog).toEqual({ kind: "diagnostics" });
  });
});

describe("bottom strip usage", () => {
  const scoped: UsageSnapshot[] = [
    { provider: "claude", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "5-hour", fraction_used: 0.35, resets_at_ms: null, detail: null }, { label: "weekly", fraction_used: 0.64, resets_at_ms: null, detail: null }, { label: "weekly", fraction_used: 0.83, resets_at_ms: null, detail: "warning", scope: "fable" }] },
    { provider: "codex", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "weekly", fraction_used: 0.07, resets_at_ms: null, detail: null }, { label: "weekly", fraction_used: 0.96, resets_at_ms: null, detail: null, scope: "sol" }] },
  ];

  it("renders one item per plan and per model scope, in order", () => {
    const { container } = show("open", {}, scoped);
    expect([...container.querySelectorAll(".usage-meter")].map((b) => b.getAttribute("aria-label"))).toEqual(["Claude usage 64%", "Fable usage 83%", "Codex usage 7%", "Sol usage 96%"]);
    expect(screen.getByRole("button", { name: "Fable usage 83%" })).toHaveClass("tone-warning");
    expect(screen.getByRole("button", { name: "Sol usage 96%" })).toHaveClass("tone-danger");
    expect(screen.getByRole("button", { name: "Claude usage 64%" })).toHaveTextContent("Claude━━━━━───64%");
  });

  it("shows a dash, not a number, for an unavailable provider", () => {
    show("open");
    expect(screen.getByRole("button", { name: "Codex usage unavailable" })).toHaveTextContent(/^Codex—$/);
  });

  it("follows usage_changed and the subscribe snapshot", () => {
    show("open", {}, []);
    expect(document.querySelector(".usage-meter")).toBeNull();
    act(() => usageChanged(scoped));
    expect(screen.getByRole("button", { name: "Sol usage 96%" })).toBeInTheDocument();
    act(() => applySnapshot({ status: null, config: null, repos: [], worktrees: [], tabs: [], panes: [], agents: [], attention: [], resources: [], actions: [], endpoints: [], usage, ui_state: null } as unknown as Snapshot));
    expect(screen.queryByRole("button", { name: /^Sol usage/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Claude usage 83%" })).toBeInTheDocument();
  });

  it("lists every bucket in the detail and refreshes on demand", async () => {
    show("open", {}, scoped);
    await userEvent.click(screen.getByRole("button", { name: "Claude usage 64%" }));
    const labels = [...document.querySelectorAll(".bottom-pop .usage-bucket-label")].map((n) => n.textContent);
    expect(labels).toEqual(["5-hour", "weekly"]);
    rpc.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(rpc).toHaveBeenCalledWith("usage_get", { refresh: true });
    expect(await screen.findByRole("button", { name: "Claude usage 90%" })).toBeInTheDocument();
  });
});
