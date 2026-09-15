import type { DaemonHealth } from "../store";
import type { Diagnostic, HookRun, IntegrationStatus, SystemStats } from "../types";

export type Tone = "quiet" | "warning" | "danger";

export const toneOf = (value: number, warn: number, danger: number): Tone => (value >= danger ? "danger" : value >= warn ? "warning" : "quiet");

export const worstTone = (tones: Tone[]): Tone => (tones.includes("danger") ? "danger" : tones.includes("warning") ? "warning" : "quiet");

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Compact memory for the strip: `8.4G`, `31G`, `512M`. */
export function compactBytes(bytes: number): string {
  if (bytes >= 100 * GB) return `${Math.round(bytes / GB)}G`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}G`;
  return `${Math.round(bytes / MB)}M`;
}

/** `8.4 / 32 GB` for the detail block. */
export function usedOfTotal(used: number, total: number): string {
  const gb = (b: number) => (b / GB >= 10 ? Math.round(b / GB).toString() : (b / GB).toFixed(1));
  return `${gb(used)} / ${gb(total)} GB`;
}

export const wholePercent = (p: number): string => `${Math.round(Math.min(100, Math.max(0, p)))}%`;

export const CPU_WARN = 85;
export const CPU_DANGER = 95;
export const MEMORY_WARN = 0.85;
export const MEMORY_DANGER = 0.95;
export const GPU_WARN = 85;
export const GPU_DANGER = 95;

export const cpuTone = (percent: number): Tone => toneOf(percent, CPU_WARN, CPU_DANGER);
export const memoryTone = (used: number, total: number): Tone => (total > 0 ? toneOf(used / total, MEMORY_WARN, MEMORY_DANGER) : "quiet");
export const gpuTone = (percent: number): Tone => toneOf(percent, GPU_WARN, GPU_DANGER);

export interface Metric {
  label: string;
  value: string;
  tone: Tone;
}

/** The strip: `CPU 12%  MEM 8.4G  GPU 3%`. GPU is left out when the machine does not report it. */
export function stripMetrics(s: SystemStats): Metric[] {
  const gpu: Metric[] = s.gpu_percent == null ? [] : [{ label: "GPU", value: wholePercent(s.gpu_percent), tone: gpuTone(s.gpu_percent) }];
  return [{ label: "CPU", value: wholePercent(s.cpu_percent), tone: cpuTone(s.cpu_percent) }, { label: "MEM", value: compactBytes(s.memory_used_bytes), tone: memoryTone(s.memory_used_bytes, s.memory_total_bytes) }, ...gpu];
}

/** The detail block. VRAM shows only when the driver reports both used and total. */
export function systemDetail(s: SystemStats): Metric[] {
  const gpu: Metric[] = s.gpu_percent == null ? [] : [{ label: "GPU", value: wholePercent(s.gpu_percent), tone: gpuTone(s.gpu_percent) }];
  const vram: Metric[] = s.vram_used_bytes == null || s.vram_total_bytes == null ? [] : [{ label: "VRAM", value: usedOfTotal(s.vram_used_bytes, s.vram_total_bytes), tone: memoryTone(s.vram_used_bytes, s.vram_total_bytes) }];
  return [{ label: "CPU", value: wholePercent(s.cpu_percent), tone: cpuTone(s.cpu_percent) }, { label: "Memory", value: usedOfTotal(s.memory_used_bytes, s.memory_total_bytes), tone: memoryTone(s.memory_used_bytes, s.memory_total_bytes) }, ...gpu, ...vram];
}

export const countOf = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface HealthView {
  label: string;
  tone: Tone;
}

/** The text that goes with the health dot, so the state never relies on color alone. */
export const HEALTH: Record<DaemonHealth, HealthView> = {
  healthy: { label: "Daemon healthy", tone: "quiet" },
  reconnecting: { label: "Daemon reconnecting", tone: "warning" },
  disconnected: { label: "Daemon disconnected", tone: "danger" },
};

export const CONNECTION_LABEL: Record<DaemonHealth, string> = { healthy: "Daemon connected", reconnecting: "Daemon reconnecting", disconnected: "Daemon disconnected" };

/** `3h 42m`, `12m`, `2d 4h`. */
export function formatUptime(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const diagnosticKey = (d: Diagnostic) => JSON.stringify([d.at_ms, d.level, d.source, d.message]);

/** One list from the daemon's history and the events this client received, newest first, without duplicates. */
export function mergeDiagnostics(fetched: Diagnostic[], local: Diagnostic[], limit = Infinity): Diagnostic[] {
  const seen = new Set<string>();
  return [...fetched, ...local]
    .filter((d) => {
      const key = diagnosticKey(d);
      return !seen.has(key) && !!seen.add(key);
    })
    .sort((a, b) => b.at_ms - a.at_ms)
    .slice(0, limit);
}

const INTEGRATION_WORD: Record<IntegrationStatus["level"], string> = { full: "healthy", partial: "partial", process_only: "process only", unavailable: "unavailable" };

export const integrationTone = (i: IntegrationStatus): Tone => (i.level === "full" ? "quiet" : i.level === "unavailable" ? "danger" : "warning");

export const integrationText = (i: IntegrationStatus): string => `${INTEGRATION_WORD[i.level]}${i.reason ? ` · ${i.reason}` : ""}`;

export const hookFailures = (runs: HookRun[]): HookRun[] => runs.filter((r) => !r.ok);
