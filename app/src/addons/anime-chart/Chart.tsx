import { useEffect, useState } from "react";
import { timeLabel } from "../../activityModel";
import { rpc } from "../../api";
import { SkeletonRows } from "../../components/ui";
import type { ArchivedShow } from "../../generated";

export default function Chart() {
  const [shows, setShows] = useState<ArchivedShow[] | null>(null);

  useEffect(() => {
    let live = true;
    const done = (list: ArchivedShow[]) => {
      if (live) setShows(list);
    };
    rpc<ArchivedShow[]>("anime_chart_list")
      .then((list) => done(Array.isArray(list) ? list : []))
      .catch(() => done([]));
    return () => {
      live = false;
    };
  }, []);

  if (!shows) return <SkeletonRows count={6} label="loading the chart" />;

  return (
    <div className="activity">
      <div className="activity-bar">
        <span className="activity-title">anime chart</span>
      </div>
      {shows.length === 0 ? (
        <div className="section-label">no archived worktrees yet</div>
      ) : (
        shows.map((show) => (
          <div key={show.worktree_id} className="activity-row">
            <span className="activity-time mono">{timeLabel(show.archived_at_ms)}</span>
            <span className="activity-text">{show.name}</span>
          </div>
        ))
      )}
    </div>
  );
}
