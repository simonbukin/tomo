import type { ActionDef, ActivityEvent, AgentKind, AgentPresence, AgentState, AttentionItem, RuntimeEndpoint, UsageBucket, UsageSnapshot } from "./types";

/**
 * The one "Needs me" rule. An item needs a person when it is unresolved. A waiting item also must be
 * unviewed, and an agent in its pane must still wait: once the agent moves on, the user already answered it.
 * `Store::activity_list` in the daemon applies the same rule to `tomo activity --needs-me`.
 */
export function needsMeItem(a: AttentionItem, agents: AgentPresence[]): boolean {
  if (a.resolved_at_ms != null) return false;
  if (a.kind !== "waiting") return true;
  if (a.viewed_at_ms != null) return false;
  return agents.some((g) => g.pane_id === a.pane_id && g.state === "waiting");
}

/** Unresolved items, least recently viewed first, so `next_attention` cycles through them. */
export function needsMeItems(list: AttentionItem[], agents: AgentPresence[]): AttentionItem[] {
  return list.filter((a) => needsMeItem(a, agents)).sort((a, b) => (a.viewed_at_ms ?? 0) - (b.viewed_at_ms ?? 0) || a.created_at_ms - b.created_at_ms);
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function endpointUrl(e: RuntimeEndpoint): string {
  return `${e.protocol === "tcp" ? "http" : e.protocol}://${e.host}:${e.port}`;
}

export function httpEndpoints(list: RuntimeEndpoint[]): RuntimeEndpoint[] {
  return list.filter((e) => e.protocol !== "tcp");
}

export function endpointLabel(e: RuntimeEndpoint, actions: ActionDef[]): string {
  return e.label ?? actions.find((a) => a.id === e.action_id)?.label ?? e.process;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function groupByDay(events: ActivityEvent[], now = Date.now()): { label: string; items: ActivityEvent[] }[] {
  return events.reduce<{ label: string; items: ActivityEvent[] }[]>((groups, e) => {
    const label = dayLabel(e.occurred_at_ms, now);
    const last = groups[groups.length - 1];
    return last?.label === label ? [...groups.slice(0, -1), { label, items: [...last.items, e] }] : [...groups, { label, items: [e] }];
  }, []);
}

export function timeLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function mergeActivity(existing: ActivityEvent[], incoming: ActivityEvent[], cap = 500): ActivityEvent[] {
  const seen = new Set<string>();
  return [...incoming, ...existing]
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => b.occurred_at_ms - a.occurred_at_ms)
    .slice(0, cap);
}

export type Signal =
  | { kind: "attention"; text: string }
  | { kind: "crash"; text: string }
  | { kind: "agent"; agent: AgentKind; state: AgentState }
  | { kind: "runtime"; label: string; port: number; url: string }
  | { kind: "warn"; bytes: number }
  | AddonSignal;

/** A signal from an addon. `className` styles the line, `dot` is the class of its state dot, and `glyph` stands for the dot in plain text. */
export type AddonSignal = { kind: "addon"; text: string; glyph: string; className: string; dot: string };

export interface SignalInput {
  attention: AttentionItem[];
  agents: AgentPresence[];
  endpoints: RuntimeEndpoint[];
  actions: ActionDef[];
  rssBytes: number | null;
  warnBytes: number;
  addon: readonly AddonSignal[];
}

/** The few things worth a glance on a NOW card, in priority order, at most three. */
export function nowSignals(input: SignalInput): Signal[] {
  const live = input.agents.filter((a) => a.state !== "exited");
  const open = input.attention.filter((a) => needsMeItem(a, input.agents));
  const checkpoint: Signal[] = open.some((a) => a.kind === "checkpoint") ? [{ kind: "attention", text: "review requested" }] : [];
  const waiting: Signal[] = live.filter((a) => a.state === "waiting").map((a) => ({ kind: "agent", agent: a.kind, state: a.state }));
  const crash: Signal[] = open.filter((a) => a.kind === "crash").map((a) => ({ kind: "crash", text: a.message }));
  const agents: Signal[] = live.filter((a) => a.state !== "waiting").map((a) => ({ kind: "agent", agent: a.kind, state: a.state }));
  const primary = httpEndpoints(input.endpoints)[0];
  const runtime: Signal[] = primary ? [{ kind: "runtime", label: endpointLabel(primary, input.actions), port: primary.port, url: endpointUrl(primary) }] : [];
  const warn: Signal[] = input.rssBytes != null && input.rssBytes >= input.warnBytes ? [{ kind: "warn", bytes: input.rssBytes }] : [];
  return [...checkpoint, ...waiting, ...crash, ...agents, ...runtime, ...warn, ...input.addon].slice(0, 3);
}

export function percentOf(b: UsageBucket): number | null {
  return b.fraction_used == null ? null : Math.round(b.fraction_used * 100);
}

export const SPARK_WIDTH = 10;

/** Filled and empty cells of a `[█████     ]` spark for a used fraction; null means no data. */
export function sparkCells(fraction: number | null, width = SPARK_WIDTH): { filled: number; empty: number } {
  if (fraction == null) return { filled: 0, empty: width };
  const filled = Math.min(width, Math.max(0, Math.round(fraction * width)));
  return { filled, empty: width - filled };
}

export function usageSummary(s: UsageSnapshot): string {
  const parts = s.buckets.filter((b) => b.fraction_used != null).map((b) => `${percentOf(b)}% ${b.label}`);
  return `${s.provider} ${parts.join(" · ")}`.trim();
}

export function resetsIn(resetsAtMs: number | null, now = Date.now()): string | null {
  if (resetsAtMs == null) return null;
  const min = Math.max(0, Math.round((resetsAtMs - now) / 60_000));
  if (min < 60) return `resets in ${min}m`;
  if (min < 48 * 60) return `resets in ${Math.round(min / 60)}h`;
  return `resets in ${Math.round(min / (24 * 60))}d`;
}

export function payloadOf(e: ActivityEvent): Record<string, unknown> {
  return e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {};
}

export function payloadString(e: ActivityEvent, key: string): string | null {
  const v = payloadOf(e)[key];
  return typeof v === "string" ? v : null;
}
