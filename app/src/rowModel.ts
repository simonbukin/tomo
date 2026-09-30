import type { AppLine } from "./addons/types";
import { agentMark, effectiveState, subagentStatus, type Mark } from "./glyphs";
import { durationLabel } from "./previewModel";
import { formatBytes, type RowError } from "./store";
import { KIND_LABEL, type AgentPresence, type AttentionItem, type Id, type Subagent, type Worktree } from "./types";

export type Tone = "warn" | "bad" | "mute";

/**
 * One line of a worktree row or its hover card: `[mark] label  text`. A `sub` line is one level in, with a small mark.
 * `kind` (mono, muted, before the text) and `meta` (at the right) show only in the hover card.
 */
export interface Line {
  key: string;
  mark: Mark;
  title?: string;
  label?: string;
  text?: string;
  tone?: Tone;
  sub?: boolean;
  kind?: string;
  meta?: string;
}

/** What a row knows about one worktree. The row reads it from the store; the rules below only read it. */
export interface RowInput {
  worktree: Worktree;
  agents: readonly AgentPresence[];
  /** The attention items of this worktree. */
  attention: readonly AttentionItem[];
  /** The exit code of the pane of each agent, by pane id. */
  exitCodes: Readonly<Record<Id, number | null>>;
  rssBytes: number | null;
  warnBytes: number;
  rowError: RowError | null;
  apps: readonly AppLine[];
}

/** The three groups of a row, in this order. An empty group draws nothing. */
export interface RowGroups {
  problems: Line[];
  agents: Line[];
  apps: Line[];
}

const open = (a: AttentionItem) => a.resolved_at_ms == null;

const bytes = (n: number) => formatBytes(n).replace(".0 ", " ");

/** What an agent asks, when it asked something. Tomo's own "Claude is waiting for you" says no more than the mark does. */
export function question(agent: AgentPresence, attention: readonly AttentionItem[]): string | null {
  const generic = `${KIND_LABEL[agent.kind]} is waiting for you`;
  const asked = attention.filter((a) => open(a) && a.kind === "waiting" && a.pane_id === agent.pane_id && a.message !== generic);
  return asked.sort((a, b) => b.created_at_ms - a.created_at_ms)[0]?.message ?? null;
}

export function problemLines(input: RowInput): Line[] {
  const w = input.worktree;
  if (w.archived_at_ms) return [];
  const e = input.rowError;
  const over = input.rssBytes != null && input.rssBytes >= input.warnBytes;
  const reviews = input.attention.filter((a) => open(a) && a.kind === "checkpoint");
  const lines: (Line | false)[] = [
    !!w.archiving && { key: "archiving", mark: "archiving", label: "archiving" },
    !!e && { key: "row-error", mark: "failed", label: `${e.op} failed`, text: e.message, tone: "bad" },
    over && { key: "memory", mark: "needs", label: "memory", text: `${bytes(input.rssBytes!)}, over the ${bytes(input.warnBytes)} warning`, tone: "warn" },
    ...reviews.map((a): Line => ({ key: `review:${a.id}`, mark: "needs", label: "review", text: a.message, tone: "warn" })),
    !w.exists && { key: "missing", mark: "unknown", label: "folder missing", text: "not found on disk", tone: "mute" },
  ];
  return lines.filter((l) => l !== false);
}

/** The words of an agent where its mark cannot say it: the question, the exit code, no signal, waking. */
function agentWords(agent: AgentPresence, input: RowInput): Pick<Line, "text" | "tone"> {
  if (agent.sleep === "waking") return { text: "waking", tone: "mute" };
  const state = effectiveState(agent);
  if (state === "waiting") {
    const asked = question(agent, input.attention);
    return asked ? { text: asked, tone: "warn" } : {};
  }
  if (state === "dead") {
    const code = input.exitCodes[agent.pane_id];
    return { text: code == null ? "exited" : `exited ${code}`, tone: "bad" };
  }
  if (state === "unknown") return { text: "no signal", tone: "mute" };
  return {};
}

const QUIET: readonly Mark[] = ["idle", "sleeping", "sleeping-done", "complete"];

const subTone = (s: Subagent): Tone | undefined => (s.state === "waiting" ? "warn" : s.state === "dead" ? "bad" : undefined);

const agentMarkOf = (agent: AgentPresence): Pick<Line, "mark" | "title"> => (agent.sleep === "waking" ? { mark: "archiving", title: "waking" } : { mark: agentMark(agent) });

/**
 * One line per agent that has something to say, then every subagent of it one level in. An idle or sleeping agent
 * has no line of its own, because the row mark says it; it keeps one when it has subagents to hold.
 */
export function agentLines(input: RowInput): Line[] {
  if (input.worktree.archived_at_ms) return [];
  return input.agents.flatMap((a) => {
    const subs = a.subagents ?? [];
    const mark = agentMarkOf(a);
    if (QUIET.includes(mark.mark) && subs.length === 0) return [];
    const head: Line = { key: a.pane_id, ...mark, label: a.kind, ...agentWords(a, input) };
    const lines = subs.map((s, i): Line => ({ key: `${a.pane_id}:${s.id ?? `launch-${i}`}`, mark: subagentStatus(s.state), sub: true, text: s.description ?? s.label, tone: subTone(s) }));
    return [head, ...lines];
  });
}

export const appLinesOf = (input: RowInput): Line[] =>
  input.worktree.archived_at_ms ? [] : input.apps.map((l) => ({ key: l.id, mark: l.mark, label: l.label, text: l.detail, tone: l.bad ? "bad" : "mute" }));

export const rowGroups = (input: RowInput): RowGroups => ({ problems: problemLines(input), agents: agentLines(input), apps: appLinesOf(input) });

/**
 * The line whose mark the row mark shows instead of the lead agent: a problem outranks every agent, and an app shows
 * only on a worktree with no agent. Null keeps the mark of the lead agent.
 */
export const leadLine = (groups: RowGroups, hasAgent: boolean): Line | null => groups.problems[0] ?? (hasAgent ? null : (groups.apps[0] ?? null));

/** A session id as the hover card shows it: `a5a5…12cc`. */
export const shortSession = (ref: string): string => (ref.length > 10 ? `${ref.slice(0, 4)}…${ref.slice(-4)}` : ref);

/** The state of an agent in words, for the hover card, where there is room for them. */
function stateWords(agent: AgentPresence, input: RowInput): Pick<Line, "text" | "tone"> {
  const words = agentWords(agent, input);
  if (words.text) return words;
  if (agent.sleep) return { text: "sleeping" };
  const state = effectiveState(agent);
  if (state === "waiting") return { text: "needs you", tone: "warn" };
  if (state === "done") return { text: agent.seen ? "done" : "done, not seen yet" };
  return { text: state === "working" && agent.estimated ? "working (estimated from CPU)" : state };
}

/** Every agent, idle ones too, with its session, its state, and for how long; its subagents with their kind and age. */
export function hoverAgentLines(input: RowInput, now: number): Line[] {
  return input.agents.flatMap((a) => {
    const head: Line = { key: a.pane_id, ...agentMarkOf(a), label: a.kind, kind: a.session_ref ? `session ${shortSession(a.session_ref)}` : undefined, ...stateWords(a, input), meta: durationLabel(a.updated_at_ms, now) };
    const subs = (a.subagents ?? []).map((s, i): Line => ({
      key: `${a.pane_id}:${s.id ?? `launch-${i}`}`,
      mark: subagentStatus(s.state),
      sub: true,
      kind: s.label,
      text: s.description ?? "",
      tone: subTone(s),
      meta: durationLabel(s.started_at_ms, now),
    }));
    return [head, ...subs];
  });
}

const appTime = (l: AppLine, now: number): string | undefined =>
  l.upSinceMs != null ? `up ${durationLabel(l.upSinceMs, now)}` : l.atMs != null ? `${durationLabel(l.atMs, now)} ago` : undefined;

export const hoverAppLines = (apps: readonly AppLine[], now: number): Line[] =>
  apps.map((l) => ({ key: l.id, mark: l.mark, label: l.label, text: l.full ?? l.detail, tone: l.bad ? "bad" : undefined, meta: appTime(l, now) }));

/** The branch line: the branch, or the detached head, after `archived` on an archived row. */
export function branchText(w: Worktree): string {
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  return w.archived_at_ms ? ["archived", branch].filter(Boolean).join(" · ") : branch;
}

/** `*` for uncommitted changes and `!2` for two conflicts, after the branch. */
export function branchFlags(w: Worktree): { text: string; bad?: boolean }[] {
  const g = w.git;
  if (!g || w.archived_at_ms) return [];
  return [g.dirty ? { text: "*" } : null, g.conflicts > 0 ? { text: `!${g.conflicts}`, bad: true } : null].filter((f) => f !== null);
}

export type Fact = { text: string; tone?: Tone | "ok" };

/** A labelled row of the hover card: `upstream  origin/main ↑3 ↓0`. */
export interface Detail {
  key: string;
  facts: Fact[];
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** The git section of the hover card: the branch, how it stands with its upstream, the changes, and the conflicts. */
export function gitDetails(w: Worktree): Detail[] {
  const g = w.git;
  const branch: Detail = { key: "branch", facts: [{ text: w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "no branch") }] };
  if (!g) return [branch];
  const ahead = g.ahead ?? 0;
  const behind = g.behind ?? 0;
  const upstream: Fact[] = g.upstream
    ? [{ text: g.upstream }, { text: ahead || behind ? `↑${ahead} ↓${behind}` : "up to date", tone: "mute" }]
    : [{ text: "no upstream", tone: "mute" }];
  const changed = g.files_changed > 0 || g.insertions > 0 || g.deletions > 0;
  const changes: Fact[] = [
    ...(changed ? [{ text: files(g.files_changed) }, { text: `+${g.insertions}`, tone: "ok" as const }, { text: `−${g.deletions}`, tone: "bad" as const }] : []),
    ...(g.untracked > 0 ? [{ text: `${changed ? "· " : ""}${g.untracked} untracked`, tone: "mute" as const }] : []),
  ];
  return [
    branch,
    { key: "upstream", facts: upstream },
    { key: "changes", facts: changes.length ? changes : [{ text: "clean" }] },
    ...(g.conflicts > 0 ? [{ key: "conflicts", facts: [{ text: files(g.conflicts), tone: "bad" as const }] }] : []),
  ];
}

/** The last block of the hover card: the tags, and when Tomo first saw the worktree. */
export function aboutDetails(w: Worktree, now: number): Detail[] {
  const tags = w.metadata.tags.length ? [{ key: "tags", facts: [{ text: w.metadata.tags.map((t) => `#${t}`).join(" ") }] }] : [];
  const seen = w.is_main ? "the main worktree" : w.first_seen_ms != null ? `created ${durationLabel(w.first_seen_ms, now)} ago` : null;
  return [...tags, ...(seen ? [{ key: "worktree", facts: [{ text: seen }] }] : [])];
}

/** A path under the home folder as `~/...`. */
export const homePath = (path: string): string => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
