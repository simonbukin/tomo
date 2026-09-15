import { useEffect, useState } from "react";
import { endpointUrl, groupByDay, httpEndpoints, mergeActivity, needsMeItem, payloadString, percentOf, resetsIn, timeLabel, shortUsageLabel, sparkCells, usageTone } from "./activityModel";
import { focusPane, openEndpoint, openWorktree, refreshUsage, resolveCheckpoint, restartWorktreeAction, restoreWorktree } from "./actions";
import { rpc } from "./api";
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "./components/ui";
import { activityStatus, GLYPH } from "./glyphs";
import "./styles/previews.css";
import { ProcessIcon } from "./ProcessIcon";
import { endpointsOf, setState, useStore, type State } from "./store";
import { KIND_LABEL, type ActivityEvent, type UsageBucket, type UsageSnapshot } from "./types";

type Filter = "all" | "needs_me" | "worktree";
const PAGE = 200;

function load(beforeMs: number | null): Promise<ActivityEvent[]> {
  return rpc<ActivityEvent[]>("activity_list", { limit: PAGE, before_ms: beforeMs, worktree_id: null, needs_me: false })
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => []);
}

export function Activity() {
  const activity = useStore((s) => s.activity);
  const activeId = useStore((s) => (s.ui.activeWorktreeId && s.worktrees.some((w) => w.id === s.ui.activeWorktreeId) ? s.ui.activeWorktreeId : null));
  const openIds = useStore((s) => s.attention.filter((a) => needsMeItem(a, Object.values(s.agents))).map((a) => a.id));
  const [filter, setFilter] = useState<Filter>("all");
  const [more, setMore] = useState(true);
  useEffect(() => {
    load(null).then((list) => {
      setMore(list.length >= PAGE);
      setState((s) => ({ activity: mergeActivity(s.activity, list) }));
    });
  }, []);
  const loadMore = () => {
    const last = activity[activity.length - 1];
    if (!last) return;
    load(last.occurred_at_ms).then((list) => {
      setMore(list.length >= PAGE && activity.length + list.length < 500);
      setState((s) => ({ activity: mergeActivity(s.activity, list) }));
    });
  };
  const shown = activity.filter((e) => (filter === "worktree" ? e.worktree_id === activeId : filter === "needs_me" ? !!e.attention_id && openIds.includes(e.attention_id) : true));
  const filters: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "needs_me", label: "Needs me" }, ...(activeId ? [{ id: "worktree" as Filter, label: "This worktree" }] : [])];
  return (
    <div className="activity">
      <div className="activity-bar">
        <span className="activity-title">activity</span>
        <span className="segmented">
          {filters.map((f) => (
            <button key={f.id} className={`seg${filter === f.id ? " seg-active" : ""}`} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </span>
        <span className="spacer" />
        <UsageStrip />
      </div>
      {shown.length === 0 && <div className="activity-empty muted">nothing yet</div>}
      {groupByDay(shown).map((g) => (
        <section key={g.label} className="activity-day">
          <div className="section-label">{g.label}</div>
          {g.items.map((e) => <EventRow key={e.id} e={e} />)}
        </section>
      ))}
      {more && shown.length > 0 && filter === "all" && <button className="link activity-more" onClick={loadMore}>load more</button>}
    </div>
  );
}

function whoOf(e: ActivityEvent, s: State): { agent: ActivityEvent["agent_kind"]; text: string } {
  if (e.agent_kind) return { agent: e.agent_kind, text: KIND_LABEL[e.agent_kind] };
  const actionId = payloadString(e, "action_id");
  if (actionId || e.kind.startsWith("action_") || e.kind === "endpoint_discovered") {
    const label = (e.worktree_id ? s.actions[e.worktree_id]?.actions : undefined)?.find((a) => a.id === actionId)?.label;
    return { agent: null, text: label ?? payloadString(e, "label") ?? actionId ?? "action" };
  }
  if (["state_changed", "annotations_sent", "archived", "restored"].includes(e.kind)) return { agent: null, text: "You" };
  return { agent: null, text: "" };
}

function EventRow({ e }: { e: ActivityEvent }) {
  const who = useStore((s) => whoOf(e, s));
  const worktree = useStore((s) => s.worktrees.find((w) => w.id === e.worktree_id) ?? null);
  const pane = useStore((s) => (e.pane_id ? (s.panes[e.pane_id] ?? null) : null));
  const open = useStore((s) => !!e.attention_id && s.attention.some((a) => a.id === e.attention_id && needsMeItem(a)));
  const endpoint = useStore((s) => (e.worktree_id ? (httpEndpoints(endpointsOf(s, e.worktree_id))[0] ?? null) : null));
  const runtimeEvent = e.kind === "endpoint_discovered" || e.kind === "checkpoint_created";
  const url = payloadString(e, "url") ?? (runtimeEvent && endpoint ? endpointUrl(endpoint) : null);
  const actionId = payloadString(e, "action_id");
  const crashed = e.kind === "action_crashed";
  const agentEvent = e.kind.startsWith("agent_") || e.kind === "checkpoint_created";
  const goTo = () => {
    if (e.worktree_id) openWorktree(e.worktree_id);
    if (pane) window.setTimeout(() => focusPane(pane.id), 80);
  };
  const line = [who.text, worktree?.name].filter(Boolean).join(" · ");
  const status = activityStatus(e.kind);
  return (
    <div className="activity-row">
      <span className="activity-time mono">{timeLabel(e.occurred_at_ms)}</span>
      <span className="activity-who">
        {status && <span className={`glyph glyph-${status}`} aria-label={status}>{GLYPH[status]}</span>}
        {who.agent && <ProcessIcon agent={who.agent} size={11} />}
        {line}
      </span>
      <span className="activity-text">
        <span className="activity-title-text">{e.title}</span>
        {e.detail && <span className="muted"> {e.detail}</span>}
      </span>
      <span className="activity-actions">
        {url && <button className="link" onClick={() => openEndpoint(url, e.worktree_id ?? undefined)}>Open App</button>}
        {pane && agentEvent && who.agent && <button className="link" onClick={goTo}>Go to {KIND_LABEL[who.agent]}</button>}
        {pane && crashed && <button className="link" onClick={goTo}>Logs</button>}
        {e.worktree_id && actionId && (crashed || e.kind === "action_stopped") && <button className="link" onClick={() => restartWorktreeAction(e.worktree_id!, actionId)}>Restart</button>}
        {open && e.attention_id && <button className="link" onClick={() => resolveCheckpoint(e.attention_id!)}>Resolve</button>}
        {e.kind === "archived" && worktree?.archived_at_ms && <button className="link" onClick={() => restoreWorktree(worktree.id)}>Restore</button>}
      </span>
    </div>
  );
}

function UsageStrip() {
  const usage = useStore((s) => s.usage.filter((u) => u.provider !== "pi"));
  if (!usage.length) return null;
  return (
    <span className="usage-strip">
      {usage.map((u) => <UsageItem key={u.provider} snapshot={u} />)}
    </span>
  );
}

function UsageItem({ snapshot: u }: { snapshot: UsageSnapshot }) {
  if (!u.available) {
    return (
      <Tooltip content={u.reason ?? "unavailable"}>
        <span className="usage-item muted">
          <span className="usage-provider">{u.provider}</span>
          <span className="usage-spark">[unavailable]</span>
        </span>
      </Tooltip>
    );
  }
  const tones = u.buckets.map(usageTone);
  const worst = tones.includes("hot") ? "hot" : tones.includes("waiting") ? "waiting" : null;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" className={`usage-item${worst ? ` usage-${worst}` : ""}`} />}>
        <span className="usage-provider">{u.provider}</span>
        {u.buckets.map((b) => (
          <Spark key={b.label} bucket={b} labelled />
        ))}
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>{u.provider} usage</PopoverTitle>
        {u.buckets.map((b) => {
          const pct = percentOf(b);
          return (
            <div key={b.label} className="usage-row" title={b.detail ?? undefined}>
              <span>{b.label}</span>
              <Spark bucket={b} />
              <span className="num">{pct == null ? "—" : `${pct}%`}</span>
              <span className="muted">{resetsIn(b.resets_at_ms) ?? ""}</span>
            </div>
          );
        })}
        <button className="link" onClick={refreshUsage}>refresh</button>
      </PopoverContent>
    </Popover>
  );
}

/** A text spark, `[█████░░░░░]`, tinted when the bucket nears its limit. */
function Spark({ bucket: b, labelled = false }: { bucket: UsageBucket; labelled?: boolean }) {
  const { filled, empty } = sparkCells(b.fraction_used);
  const tone = usageTone(b);
  return (
    <span className="usage-spark" aria-label={`${b.label} ${percentOf(b) ?? "unknown"} percent used`}>
      {labelled && <span className="usage-spark-label">{shortUsageLabel(b.label)}</span>}
      <span className={`usage-cells${tone ? ` usage-${tone}` : ""}`}>
        [<span className="on">{"█".repeat(filled)}</span>
        <span className="off">{"░".repeat(empty)}</span>]
      </span>
    </span>
  );
}
