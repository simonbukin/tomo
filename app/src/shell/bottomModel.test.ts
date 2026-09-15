import { describe, expect, it } from "vitest";
import type { Diagnostic, HookRun, IntegrationStatus, SystemStats } from "../types";
import { compactBytes, countOf, cpuTone, formatUptime, HEALTH, hookFailures, integrationText, integrationTone, memoryTone, mergeDiagnostics, stripMetrics, systemDetail, usedOfTotal, wholePercent } from "./bottomModel";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const stats = (patch: Partial<SystemStats> = {}): SystemStats => ({ at_ms: 0, cpu_percent: 12.4, memory_used_bytes: 8.4 * GB, memory_total_bytes: 32 * GB, gpu_percent: null, vram_used_bytes: null, vram_total_bytes: null, daemon_rss_bytes: 18 * MB, top_worktree: null, ...patch });

describe("system metrics", () => {
  it("formats pressure without false precision", () => {
    expect(wholePercent(12.427)).toBe("12%");
    expect(wholePercent(-1)).toBe("0%");
    expect(compactBytes(8.378291 * GB)).toBe("8.4G");
    expect(compactBytes(30.8 * GB)).toBe("30.8G");
    expect(compactBytes(128.4 * GB)).toBe("128G");
    expect(compactBytes(512 * MB)).toBe("512M");
    expect(usedOfTotal(8.4 * GB, 32 * GB)).toBe("8.4 / 32 GB");
    expect(usedOfTotal(1.8 * GB, 8 * GB)).toBe("1.8 / 8.0 GB");
  });

  it("warns near CPU and memory pressure", () => {
    expect([cpuTone(12), cpuTone(85), cpuTone(96)]).toEqual(["quiet", "warning", "danger"]);
    expect([memoryTone(8 * GB, 32 * GB), memoryTone(28 * GB, 32 * GB), memoryTone(30.8 * GB, 32 * GB), memoryTone(1, 0)]).toEqual(["quiet", "warning", "danger", "quiet"]);
  });

  it("omits GPU and VRAM when the machine does not report them", () => {
    expect(stripMetrics(stats()).map((m) => `${m.label} ${m.value}`)).toEqual(["CPU 12%", "MEM 8.4G"]);
    expect(stripMetrics(stats({ gpu_percent: 3 })).map((m) => `${m.label} ${m.value}`)).toEqual(["CPU 12%", "MEM 8.4G", "GPU 3%"]);
    expect(systemDetail(stats({ gpu_percent: 3, vram_used_bytes: 1.8 * GB })).map((m) => m.label)).toEqual(["CPU", "Memory", "GPU"]);
    expect(systemDetail(stats({ gpu_percent: 3, vram_used_bytes: 1.8 * GB, vram_total_bytes: 8 * GB })).map((m) => `${m.label} ${m.value}`)).toEqual(["CPU 12%", "Memory 8.4 / 32 GB", "GPU 3%", "VRAM 1.8 / 8.0 GB"]);
  });
});

describe("daemon health", () => {
  it("gives every state a text label and a distinct tone", () => {
    expect(HEALTH.healthy).toEqual({ label: "Daemon healthy", tone: "quiet" });
    expect(HEALTH.reconnecting).toEqual({ label: "Daemon reconnecting", tone: "warning" });
    expect(HEALTH.disconnected).toEqual({ label: "Daemon disconnected", tone: "danger" });
  });

  it("formats uptime and counts", () => {
    expect(formatUptime(12 * 60_000)).toBe("12m");
    expect(formatUptime((3 * 60 + 42) * 60_000)).toBe("3h 42m");
    expect(formatUptime(52 * 3_600_000)).toBe("2d 4h");
    expect(formatUptime(-5)).toBe("0m");
    expect([countOf(1, "pane"), countOf(12, "pane"), countOf(0, "agent")]).toEqual(["1 pane", "12 panes", "0 agents"]);
  });
});

describe("diagnostics", () => {
  const d = (at_ms: number, message: string, source = "daemon", level: Diagnostic["level"] = "info"): Diagnostic => ({ at_ms, level, source, message });

  it("merges the daemon history with local events, newest first, without duplicates", () => {
    const fetched = [d(3, "usage refreshed", "usage"), d(1, "config reloaded", "config")];
    const local = [d(1, "config reloaded", "config"), d(2, "reconnected"), d(3, "usage refreshed", "usage", "warning")];
    expect(mergeDiagnostics(fetched, local).map((x) => `${x.at_ms} ${x.level} ${x.message}`)).toEqual(["3 info usage refreshed", "3 warning usage refreshed", "2 info reconnected", "1 info config reloaded"]);
    expect(mergeDiagnostics(fetched, local, 2)).toHaveLength(2);
    expect(mergeDiagnostics([], [])).toEqual([]);
  });

  it("labels integrations and hook failures", () => {
    const i = (level: IntegrationStatus["level"], reason: string | null = null): IntegrationStatus => ({ kind: "claude", level, binary: null, lifecycle: true, resume: true, reason });
    expect([integrationText(i("full")), integrationText(i("process_only", "hooks missing"))]).toEqual(["healthy", "process only · hooks missing"]);
    expect([i("full"), i("partial"), i("process_only"), i("unavailable")].map(integrationTone)).toEqual(["quiet", "warning", "warning", "danger"]);
    const run = (ok: boolean): HookRun => ({ event: "worktree_created", command: "x", worktree_id: null, started_at_ms: 0, duration_ms: 1, exit_code: ok ? 0 : 1, ok, output_tail: "" });
    expect(hookFailures([run(true), run(false)])).toHaveLength(1);
  });
});
