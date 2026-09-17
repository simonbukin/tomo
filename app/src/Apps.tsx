import { addonApps, sourceMenu } from "./addons";
import { addressLabel, type AppRow } from "./appsModel";
import { focusPane, openEndpoint, openWorktree } from "./actions";
import { openMenu } from "./MenuHost";
import { EmptyState } from "./states";
import { getState, repoName, useStore } from "./store";

/** Open the worktree first, then the pane, because openWorktree focuses the active pane on its own timer. */
async function focusApp(row: AppRow): Promise<void> {
  await openWorktree(row.worktreeId);
  if (row.paneId) window.setTimeout(() => focusPane(row.paneId!), 80);
}

/** Restart and stop stay with the addon that started the pane. Core only opens that addon's menu. */
function ownerMenu(e: React.MouseEvent, row: AppRow): void {
  if (!row.source) return;
  const menu = sourceMenu(row.worktreeId, row.source, getState());
  const items = [...menu.first, ...menu.last];
  if (items.length > 0) openMenu(e, items);
}

export function Apps() {
  const rows = useStore(addonApps);
  const place = useStore((s) => Object.fromEntries(s.worktrees.map((w) => [w.id, `${repoName(s, w.repo_id)} / ${w.name}`])));
  return (
    <div className="apps">
      <div className="apps-bar">
        <span className="faint">{rows.length > 0 ? `${rows.length} running` : ""}</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No apps are running." />
      ) : (
        <div className="apps-list">
          <div className="apps-head"><span>app</span><span>worktree</span><span>address</span><span /></div>
          {rows.map((row) => (
            <div key={row.id} className="apps-row" onContextMenu={(e) => ownerMenu(e, row)}>
              <span className="apps-name">{row.label}{row.detail && <span className="faint"> · {row.detail}</span>}</span>
              <span className="apps-where">{place[row.worktreeId] ?? "unknown"}</span>
              <span className="apps-address">{addressLabel(row)}</span>
              <span className="apps-actions">
                {row.url && <button className="link" onClick={() => openEndpoint(row.url!, row.worktreeId)}>open</button>}
                {row.url && <button className="link" onClick={() => openEndpoint(row.url!)}>system</button>}
                {row.paneId && <button className="link" onClick={() => focusApp(row)}>pane</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
