import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, UsageBucket, UsageSnapshot } from "../../generated";
import { applyFrame, applySnapshot, getState, setState, type State } from "../../store";
import { headlineBucket, microBar, percentText, stripUsage, usageIssues, usageRows, usageTone } from "./model";

const { refreshed } = vi.hoisted(() => ({
  refreshed: [{ provider: "claude", available: true, reason: null, fetched_at_ms: 1, buckets: [{ label: "weekly", fraction_used: 0.9, resets_at_ms: null, detail: null }] }],
}));

const rpc = vi.fn((method: string, _params?: unknown) => Promise.resolve(method === "usage_get" ? refreshed : []));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), rpc: (method: string, params?: unknown) => rpc(method, params) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("0.1.3")) }));

const { BottomStrip } = await import("../../shell/BottomStrip");
const { TooltipProvider } = await import("../../components/ui");

const bucket = (label: string, fraction_used: number | null): UsageBucket => ({ label, fraction_used, resets_at_ms: null, detail: null });
const snap = (provider: UsageSnapshot["provider"], buckets: UsageBucket[], available = true): UsageSnapshot => ({ provider, available, reason: available ? null : "not signed in", buckets, fetched_at_ms: 0 });

describe("usage model", () => {
  it("picks the most used bucket whatever the adapter calls it", () => {
    expect(headlineBucket(snap("claude", [bucket("anything", 0.4), bucket("other", 0.83), bucket("unknown", null)]))?.label).toBe("other");
    expect(headlineBucket(snap("codex", [bucket("a", null)]))).toBeNull();
    expect(headlineBucket(snap("codex", [bucket("a", 0.9)], false))).toBeNull();
  });

  it("stays quiet below 80 percent and warns at the thresholds", () => {
    expect(usageTone(snap("claude", [bucket("a", 0.79)]))).toBe("quiet");
    expect(usageTone(snap("claude", [bucket("a", 0.1), bucket("b", 0.8)]))).toBe("warning");
    expect(usageTone(snap("claude", [bucket("a", 0.95), bucket("b", 0.85)]))).toBe("danger");
    expect(usageTone(snap("claude", [bucket("a", 0.99)], false))).toBe("quiet");
    expect(usageTone(snap("claude", [bucket("a", null)]))).toBe("quiet");
  });

  it("keeps pi out of the strip and its issues", () => {
    const usage = [snap("claude", []), snap("pi", [], false), snap("codex", [], false)];
    expect(stripUsage(usage).map((u) => u.provider)).toEqual(["claude", "codex"]);
    expect(usageIssues(usage).map((u) => u.provider)).toEqual(["codex"]);
  });

  it("draws a micro-bar and a percent that never guess", () => {
    expect(microBar(0.5)).toEqual({ on: "━━━━", off: "────" });
    expect(microBar(null)).toEqual({ on: "", off: "────────" });
    expect(microBar(1.4, 4)).toEqual({ on: "━━━━", off: "" });
    expect(percentText(0.834)).toBe("83%");
    expect(percentText(null)).toBe("—");
    expect(percentText(1.2)).toBe("100%");
  });

  it("splits the plan from model scopes and keeps pi out", () => {
    const claude = snap("claude", [bucket("5-hour", 0.35), bucket("weekly", 0.64), { ...bucket("weekly", 0.83), scope: "fable" }]);
    const codex = snap("codex", [bucket("weekly", 0.07), { ...bucket("weekly", 0.4), scope: "sol" }]);
    const rows = usageRows([claude, codex, snap("pi", [bucket("x", 0.1)])]);
    expect(rows.map((r) => r.name)).toEqual(["Claude", "Fable", "Codex", "Sol"]);
    expect(rows.map((r) => headlineBucket(r.snapshot)?.fraction_used)).toEqual([0.64, 0.83, 0.07, 0.4]);
  });

  it("keeps one row for an unavailable provider and drops an empty plan row next to scopes", () => {
    expect(usageRows([snap("codex", [], false)]).map((r) => r.name)).toEqual(["Codex"]);
    expect(usageRows([snap("claude", [{ ...bucket("weekly", 0.5), scope: "fable" }])]).map((r) => r.name)).toEqual(["Fable"]);
  });
});

describe("usage in the bottom strip", () => {
  const initial: State = getState();
  const usage: UsageSnapshot[] = [
    { provider: "claude", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "session", fraction_used: 0.4, resets_at_ms: null, detail: null }, { label: "week", fraction_used: 0.83, resets_at_ms: null, detail: null }] },
    { provider: "codex", available: false, reason: "not signed in", buckets: [], fetched_at_ms: 0 },
    { provider: "pi", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "x", fraction_used: 0.1, resets_at_ms: null, detail: null }] },
  ];
  const scoped: UsageSnapshot[] = [
    { provider: "claude", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "5-hour", fraction_used: 0.35, resets_at_ms: null, detail: null }, { label: "weekly", fraction_used: 0.64, resets_at_ms: null, detail: null }, { label: "weekly", fraction_used: 0.83, resets_at_ms: null, detail: "warning", scope: "fable" }] },
    { provider: "codex", available: true, reason: null, fetched_at_ms: 0, buckets: [{ label: "weekly", fraction_used: 0.07, resets_at_ms: null, detail: null }, { label: "weekly", fraction_used: 0.96, resets_at_ms: null, detail: null, scope: "sol" }] },
  ];
  const usageChanged = (snapshots: UsageSnapshot[]) => applyFrame({ seq: 1, event: "usage_changed", data: { snapshots } });

  function show(snapshots: UsageSnapshot[], left: "open" | "closed" = "open") {
    setState({ connected: true, daemonHealth: "healthy" });
    usageChanged(snapshots);
    return render(
      <TooltipProvider>
        <BottomStrip left={left} />
      </TooltipProvider>,
    );
  }

  beforeEach(() => setState(initial));
  afterEach(cleanup);

  it("shows the plan with its tone, a dash for an unavailable provider, and no Pi", () => {
    show(usage);
    expect(screen.getByRole("button", { name: "Claude usage 83%" })).toHaveClass("tone-warning");
    expect(screen.getByRole("button", { name: "Codex usage unavailable" })).toHaveTextContent(/^Codex—$/);
    expect(screen.queryByRole("button", { name: /^Pi usage/ })).toBeNull();
  });

  it("stays in the strip when the left sidebar is closed", () => {
    show(usage, "closed");
    expect(screen.getByRole("button", { name: "Claude usage 83%" })).toBeInTheDocument();
  });

  it("renders one item per plan and per model scope, in order", () => {
    const { container } = show(scoped);
    expect([...container.querySelectorAll(".usage-meter")].map((b) => b.getAttribute("aria-label"))).toEqual(["Claude usage 64%", "Fable usage 83%", "Codex usage 7%", "Sol usage 96%"]);
    expect(screen.getByRole("button", { name: "Fable usage 83%" })).toHaveClass("tone-warning");
    expect(screen.getByRole("button", { name: "Sol usage 96%" })).toHaveClass("tone-danger");
    expect(screen.getByRole("button", { name: "Claude usage 64%" })).toHaveTextContent("Claude━━━━━───64%");
  });

  it("follows usage_changed and the subscribe snapshot", () => {
    show([]);
    expect(document.querySelector(".usage-meter")).toBeNull();
    act(() => usageChanged(scoped));
    expect(screen.getByRole("button", { name: "Sol usage 96%" })).toBeInTheDocument();
    act(() => applySnapshot({ status: null, config: null, repos: [], worktrees: [], tabs: [], panes: [], agents: [], attention: [], resources: [], actions: [], endpoints: [], usage, ui_state: null } as unknown as Snapshot));
    expect(screen.queryByRole("button", { name: /^Sol usage/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Claude usage 83%" })).toBeInTheDocument();
  });

  it("lists every bucket in the detail and refreshes on demand", async () => {
    show(scoped);
    await userEvent.click(screen.getByRole("button", { name: "Claude usage 64%" }));
    const labels = [...document.querySelectorAll(".bottom-pop .usage-bucket-label")].map((n) => n.textContent);
    expect(labels).toEqual(["5-hour", "weekly"]);
    rpc.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(rpc).toHaveBeenCalledWith("usage_get", { refresh: true });
    expect(await screen.findByRole("button", { name: "Claude usage 90%" })).toBeInTheDocument();
  });

  it("reports an unavailable provider in diagnostics", async () => {
    show(usage);
    await userEvent.click(await screen.findByRole("button", { name: /^Daemon healthy/ }));
    expect(await screen.findByText("Codex usage unavailable · not signed in")).toBeInTheDocument();
  });
});
