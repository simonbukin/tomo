import { CircleHelp, Settings2 } from "lucide-react";
import { useEffect } from "react";
import { resetsIn } from "../activityModel";
import { refreshUsage, runAction } from "../actions";
import { rpc } from "../api";
import { openSettings } from "../commands/settings";
import { IconButton } from "../components/ui";
import { useShortcuts } from "../shortcuts";
import { formatBytes, setState, useStore } from "../store";
import type { SidebarMode, SystemStats, UsageSnapshot } from "../types";
import { bucketTone, headlineBucket, microBar, percentText, stripMetrics, systemDetail, usageRows, usageTone } from "./bottomModel";
import { HealthArea } from "./Diagnostics";
import { HoverPopover } from "./HoverPopover";
import { StatusSlot } from "./StatusSlot";

/**
 * The fixed bottom strip, aligned to the shell columns: help and settings, usage, the status message, system metrics,
 * and daemon health. `left` is the mode on screen from `shellLayout`, which can differ from the saved mode.
 */
export function BottomStrip({ left }: { left: SidebarMode }) {
  return (
    <footer className="bottom-strip" data-left={left}>
      {left !== "closed" && <HelpControls />}
      <div className="bottom-middle">
        <UsageStrip />
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

function MicroBar({ fraction, width }: { fraction: number | null; width?: number }) {
  const bar = microBar(fraction, width);
  return (
    <span className="micro-bar" aria-hidden="true">
      <span className="on">{bar.on}</span>
      <span className="off">{bar.off}</span>
    </span>
  );
}

function UsageStrip() {
  const usage = useStore((s) => s.usage);
  return (
    <div className="bottom-usage">
      {usageRows(usage).map((row) => (
        <UsageMeter key={row.key} name={row.name} snapshot={row.snapshot} />
      ))}
    </div>
  );
}

function UsageMeter({ name, snapshot: u }: { name: string; snapshot: UsageSnapshot }) {
  const head = headlineBucket(u);
  return (
    <HoverPopover
      title={name}
      preview={<UsageBuckets snapshot={u} />}
      detail={
        <>
          <UsageBuckets snapshot={u} wide />
          <button type="button" className="link" onClick={refreshUsage}>
            refresh
          </button>
        </>
      }
      trigger={
        <button type="button" className={`bottom-item usage-meter tone-${usageTone(u)}`} aria-label={`${name} usage ${head ? percentText(head.fraction_used) : "unavailable"}`}>
          <span className="usage-name">{name}</span>
          {head ? (
            <>
              <MicroBar fraction={head.fraction_used} />
              <span className="num">{percentText(head.fraction_used)}</span>
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </button>
      }
    />
  );
}

function UsageBuckets({ snapshot: u, wide = false }: { snapshot: UsageSnapshot; wide?: boolean }) {
  if (!u.available) return <div className="muted">{u.reason ?? "Usage unavailable"}</div>;
  if (!u.buckets.length) return <div className="muted">No usage data</div>;
  return (
    <div className="usage-buckets">
      {u.buckets.map((b) => (
        <div key={b.label} className={`usage-bucket tone-${bucketTone(b)}`} title={b.detail ?? undefined}>
          <span className="usage-bucket-label">{b.label}</span>
          <MicroBar fraction={b.fraction_used} width={wide ? 16 : 10} />
          <span className="num">{percentText(b.fraction_used)}</span>
          <span className="faint">{resetsIn(b.resets_at_ms) ?? ""}</span>
        </div>
      ))}
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
