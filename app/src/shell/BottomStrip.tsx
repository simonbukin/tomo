import { DROPPED_MS, useFrameRate } from "../frameRate";
import { CircleHelp, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "../actions";
import { builtins } from "../addons";
import { rpcParsed } from "../api";
import { systemStatsSchema } from "../schemas";
import { openSettings } from "../commands/settings";
import { IconButton } from "../components/ui";
import { useShortcuts } from "../shortcuts";
import {failQuietly, formatBytes, setState, useStore} from "../store";
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

/** Frames, on demand. Click it to start counting; it counts nothing until you do. */
function FrameMeter() {
  const [on, setOn] = useState(false);
  const report = useFrameRate(on);
  const late = report ? report.worstMs > DROPPED_MS : false;
  return (
    <button
      type="button"
      className={`bottom-item metric frame-meter${late ? " tone-warning" : ""}`}
      aria-label={report ? `Frame rate ${report.fps} per second, worst frame ${report.worstMs} milliseconds. Click to stop counting.` : "Count frames"}
      onClick={() => setOn((was) => !was)}
    >
      <span className="metric-label">fps</span>
      <span className="num">{report ? report.fps : "\u2014"}</span>
      {report && <span className="metric-label">{report.worstMs}ms</span>}
    </button>
  );
}

function SystemMetrics() {
  const stats = useStore((s) => (s.connected ? s.system : null));
  const nonce = useStore((s) => s.connectionNonce);
  useEffect(() => {
    if (!nonce) return;
    rpcParsed("system_stats", systemStatsSchema)
      .then((system) => system?.memory_total_bytes && setState({ system }))
      .catch(failQuietly("system_stats"));
  }, [nonce]);
  if (!stats) return <div className="bottom-metrics" />;
  const metrics = stripMetrics(stats);
  return (
    <div className="bottom-metrics">
      <FrameMeter />
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
