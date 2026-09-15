import { sparkCells } from "../activityModel";
import type { DaemonHealth } from "../store";
import { KIND_LABEL, type Diagnostic, type HookRun, type IntegrationStatus, type SystemStats, type UsageBucket, type UsageSnapshot } from "../types";

export type Tone = "quiet" | "warning" | "danger";

export const toneOf = (value: number, warn: number, danger: number): Tone => (value >= danger ? "danger" : value >= warn ? "warning" : "quiet");

export const worstTone = (tones: Tone[]): Tone => (tones.includes("danger") ? "danger" : tones.includes("warning") ? "warning" : "quiet");

export const USAGE_WARN = 0.8;
export const USAGE_DANGER = 0.95;

/** Pi runs on the Claude allowance, so it has no usage of its own. */
export const stripUsage = (usage: UsageSnapshot[]): UsageSnapshot[] => usage.filter((u) => u.provider !== "pi");

export interface UsageRow {
  key: string;
  name: string;
  snapshot: UsageSnapshot;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One row for the whole plan and one per model scope, for example Claude, Fable, Codex, Sol. */
export function usageRows(usage: UsageSnapshot[]): UsageRow[] {
  return stripUsage(usage).flatMap((u) => {
    const scopes = [...new Set(u.buckets.flatMap((b) => (b.scope ? [b.scope] : [])))];
    const plan = u.buckets.filter((b) => !b.scope);
    const planRow: UsageRow[] = plan.length || !scopes.length ? [{ key: u.provider, name: KIND_LABEL[u.provider], snapshot: { ...u, buckets: plan } }] : [];
    return [...planRow, ...scopes.map((scope) => ({ key: `${u.provider}:${scope}`, name: titleCase(scope), snapshot: { ...u, buckets: u.buckets.filter((b) => b.scope === scope) } }))];
  });
}

const knownBuckets = (u: UsageSnapshot): (UsageBucket & { fraction_used: number })[] => (u.available ? u.buckets.filter((b): b is UsageBucket & { fraction_used: number } => b.fraction_used != null) : []);

/** The most used bucket of a provider, whatever the adapter calls it. Null when no bucket has a value. */
export function headlineBucket(u: UsageSnapshot): (UsageBucket & { fraction_used: number }) | null {
  return knownBuckets(u).reduce<(UsageBucket & { fraction_used: number }) | null>((top, b) => (!top || b.fraction_used > top.fraction_used ? b : top), null);
}

export const bucketTone = (b: UsageBucket): Tone => (b.fraction_used == null ? "quiet" : toneOf(b.fraction_used, USAGE_WARN, USAGE_DANGER));

export const usageTone = (u: UsageSnapshot): Tone => worstTone(knownBuckets(u).map(bucketTone));

export const percentText = (fraction: number | null): string => (fraction == null ? "—" : `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`);

/** `━━━━━━──` for a used fraction; an unknown value draws only the empty track. */
export function microBar(fraction: number | null, width = 8): { on: string; off: string } {
  const { filled, empty } = sparkCells(fraction, width);
  return { on: "━".repeat(filled), off: "─".repeat(empty) };
}

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

export const usageIssues = (usage: UsageSnapshot[]): UsageSnapshot[] => stripUsage(usage).filter((u) => !u.available);
