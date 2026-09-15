import { CircleHelp, Settings2 } from "lucide-react";
import { useEffect } from "react";
import { runAction } from "../actions";
import { builtins } from "../addons";
import { rpc } from "../api";
import { openSettings } from "../commands/settings";
import { IconButton } from "../components/ui";
import { useShortcuts } from "../shortcuts";
import { formatBytes, setState, useStore } from "../store";
import type { SidebarMode, SystemStats } from "../types";
import { stripMetrics, systemDetail } from "./bottomModel";
import { HealthArea } from "./Diagnostics";
import { HoverPopover } from "./HoverPopover";
import { StatusSlot } from "./StatusSlot";

/**
 * The fixed bottom strip, aligned to the shell columns: help and settings, addon items, the status message, system metrics,
 * and daemon health. `left` is the mode on screen from `shellLayout`, which can differ from the saved mode.
 */
export function BottomStrip({ left }: { left: SidebarMode }) {
  return (
    <footer className="bottom-strip" data-left={left}>
      {left !== "closed" && <HelpControls />}
      <div className="bottom-middle">
        <div className="bottom-items">{builtins.map(({ id, bottomItem: Item }) => Item && <Item key={id} />)}</div>
        <div className="bottom-status">
          <StatusSlot />
        </div>
        <SystemMetrics />
      </div>
      <div className="bottom-right">
        <HealthArea />
      </div>
    </footer>
  );
}

function HelpControls() {
  const shortcut = useShortcuts();
  return (
    <div className="bottom-left">
      <IconButton label="Keyboard shortcuts" shortcut={shortcut("keyboard_shortcuts")} tooltipSide="top" onClick={() => runAction("keyboard_shortcuts")}>
        <CircleHelp className="icon" />
      </IconButton>
      <IconButton label="Settings" shortcut={shortcut("settings")} tooltipSide="top" onClick={() => openSettings()}>
        <Settings2 className="icon" />
      </IconButton>
    </div>
  );
}

function SystemMetrics() {
  const stats = useStore((s) => (s.connected ? s.system : null));
  const nonce = useStore((s) => s.connectionNonce);
  useEffect(() => {
    if (!nonce) return;
    rpc<SystemStats>("system_stats")
      .then((system) => system?.memory_total_bytes && setState({ system }))
      .catch(() => {});
  }, [nonce]);
  if (!stats) return <div className="bottom-metrics" />;
  const metrics = stripMetrics(stats);
  return (
    <div className="bottom-metrics">
      <HoverPopover
        align="end"
        title="System"
        preview={<SystemDetail stats={stats} />}
        detail={<SystemDetail stats={stats} />}
        trigger={
          <button type="button" className="bottom-item metrics" aria-label={metrics.map((m) => `${m.label} ${m.value}`).join(", ")}>
            {metrics.map((m) => (
              <span key={m.label} className={`metric tone-${m.tone}`}>
                <span className="metric-label">{m.label}</span>
                <span className="num">{m.value}</span>
              </span>
            ))}
          </button>
        }
      />
    </div>
  );
}

function SystemDetail({ stats }: { stats: SystemStats }) {
  const top = stats.top_worktree;
  const name = useStore((s) => (top ? (s.worktrees.find((w) => w.id === top.worktree_id)?.name ?? null) : null));
  return (
    <div className="kv-list">
      {systemDetail(stats).map((m) => (
        <div key={m.label} className={`kv-line tone-${m.tone}`}>
          <span className="kv-key">{m.label}</span>
          <span className="num">{m.value}</span>
        </div>
      ))}
      {top && name && (
        <>
          <div className="bottom-pop-label">Top worktree</div>
          <div className="kv-line">
            <span className="kv-key">{name}</span>
            <span className="num">{formatBytes(top.rss_bytes)}</span>
          </div>
        </>
      )}
      {stats.daemon_rss_bytes > 0 && (
        <div className="kv-line muted">
          <span className="kv-key">Tomo daemon</span>
          <span className="num">{formatBytes(stats.daemon_rss_bytes)}</span>
        </div>
      )}
    </div>
  );
}
