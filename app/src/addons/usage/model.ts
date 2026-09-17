import { resetsIn, sparkCells } from "../../activityModel";
import type { UsageBucket, UsageSnapshot } from "../../generated";
import { toneOf, worstTone, type Tone } from "../../shell/bottomModel";
import { KIND_LABEL } from "../../types";

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

/** The strip form of a reset: `2h`, not `resets in 2h`. Null when the bucket has no reset. */
export const resetShort = (resetsAtMs: number | null): string | null => resetsIn(resetsAtMs)?.replace("resets in ", "") ?? null;

export const usageIssues = (usage: UsageSnapshot[]): UsageSnapshot[] => stripUsage(usage).filter((u) => !u.available);
