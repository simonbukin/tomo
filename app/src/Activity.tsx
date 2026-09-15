import { useEffect, useState } from "react";
import { activityView } from "./activityKinds";
import { groupByDay, mergeActivity, needsMeItem, payloadString, timeLabel } from "./activityModel";
import { openEndpoint, resolveCheckpoint } from "./actions";
import { rpc } from "./api";
import { SkeletonRows } from "./components/ui";
import { activityEmptyText, type ActivityFilter as Filter } from "./emptyStates";
import { GLYPH } from "./glyphs";
import "./styles/previews.css";
import { ProcessIcon } from "./ProcessIcon";
import { EmptyState } from "./states";
import { setState, useStore } from "./store";
import { KIND_LABEL, type ActivityEvent } from "./types";

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
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    load(null).then((list) => {
      setLoading(false);
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
      </div>
      {shown.length === 0 && (loading ? <SkeletonRows count={6} label="loading activity" /> : <EmptyState title={activityEmptyText(filter)} />)}
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

function EventRow({ e }: { e: ActivityEvent }) {
  const view = activityView(e.kind);
  const who = useStore((s) => (e.agent_kind ? KIND_LABEL[e.agent_kind] : (view.who?.(e, s) ?? "")));
  const worktreeName = useStore((s) => s.worktrees.find((w) => w.id === e.worktree_id)?.name ?? null);
  const url = useStore((s) => payloadString(e, "url") ?? view.url?.(e, s) ?? null);
  const labels = useStore((s) => (view.actions ?? []).map((a) => a.label(e, s)));
  const open = useStore((s) => !!e.attention_id && s.attention.some((a) => a.id === e.attention_id && needsMeItem(a)));
  const line = [who, worktreeName].filter(Boolean).join(" · ");
  const status = view.status ?? null;
  return (
    <div className="activity-row">
      <span className="activity-time mono">{timeLabel(e.occurred_at_ms)}</span>
      <span className="activity-who">
        {status && <span className={`glyph glyph-${status}`} aria-label={status}>{GLYPH[status]}</span>}
        {e.agent_kind && <ProcessIcon agent={e.agent_kind} size={11} />}
        {line}
      </span>
      <span className="activity-text">
        <span className="activity-title-text">{e.title}</span>
        {e.detail && <span className="muted"> {e.detail}</span>}
      </span>
      <span className="activity-actions">
        {url && <button className="link" onClick={() => openEndpoint(url, e.worktree_id ?? undefined)}>Open App</button>}
        {(view.actions ?? []).map((a, i) => labels[i] && <button key={i} className="link" onClick={() => a.run(e)}>{labels[i]}</button>)}
        {open && e.attention_id && <button className="link" onClick={() => resolveCheckpoint(e.attention_id!)}>Resolve</button>}
      </span>
    </div>
  );
}
