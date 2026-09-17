import { configIssueSchema, diagnosticSchema, hookRunSchema, integrationStatusSchema } from "../schemas";
import { z, type ZodType } from "zod";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { timeLabel } from "../activityModel";
import { builtins } from "../addons";
import { rpcParsed } from "../api";
import { openDiagnostics } from "../commands/diagnostics";
import { Button, DialogActions, DialogTitle, PopoverClose, SkeletonRows } from "../components/ui";
import { useStore } from "../store";
import { KIND_LABEL, type Diagnostic } from "../types";
import { CONNECTION_LABEL, countOf, formatUptime, HEALTH, hookFailures, integrationText, integrationTone, mergeDiagnostics, type Tone } from "./bottomModel";
import { HoverPopover } from "./HoverPopover";

const TONE_DOT: Record<Tone, string> = { quiet: "state state-ok", warning: "state state-warning", danger: "state state-error" };
const LEVEL_DOT: Record<Diagnostic["level"], string> = { info: "state state-idle", warning: "state state-warning", error: "state state-error" };

function useAppVersion(): string | null {
  const daemonVersion = useStore((s) => s.daemonStatus?.version ?? null);
  const [app, setApp] = useState<string | null>(null);
  useEffect(() => {
    Promise.resolve()
      .then(getVersion)
      .then(setApp)
      .catch(() => {});
  }, []);
  return app ?? daemonVersion;
}

/** The bottom-right health dot and version. Hover shows the daemon summary; a click opens diagnostics. */
export function HealthArea() {
  const health = useStore((s) => s.daemonHealth);
  const version = useAppVersion();
  const view = HEALTH[health];
  return (
    <HoverPopover
      align="end"
      title="Tomo"
      detailTitle="Tomo diagnostics"
      className="diagnostics-popover"
      preview={<DaemonSummary />}
      detail={<DiagnosticsReport eventLimit={6} compact />}
      trigger={
        <button type="button" className="bottom-item health" data-health={health} aria-label={`${view.label}${version ? `, Tomo ${version}` : ""}`}>
          <span className={TONE_DOT[view.tone]} aria-hidden="true" />
          {version && <span className="mono">{version}</span>}
        </button>
      }
    />
  );
}

function DaemonSummary() {
  const health = useStore((s) => s.daemonHealth);
  const status = useStore((s) => (s.daemonHealth === "healthy" ? s.daemonStatus : null));
  const panes = useStore((s) => Object.keys(s.panes).length);
  const agents = useStore((s) => Object.values(s.agents).filter((a) => a.state !== "exited").length);
  return (
    <div className="kv-list">
      <div>{HEALTH[health].label}</div>
      {status && (
        <>
          <div>
            PID <span className="mono">{status.daemon_pid}</span>
          </div>
          <div>Uptime {formatUptime(Date.now() - status.started_at_ms)}</div>
          <div>Protocol {status.protocol}</div>
        </>
      )}
      <div className="muted">
        {countOf(panes, "pane")} · {countOf(agents, "agent")}
      </div>
    </div>
  );
}

type Loaded<T> = T[] | "loading" | "failed";

function useDaemonList<T>(method: string, item: ZodType<T>, params: unknown, nonce: number): Loaded<T> {
  const [value, setValue] = useState<Loaded<T>>("loading");
  useEffect(() => {
    let live = true;
    rpcParsed(method, z.array(item), params)
      .then((r) => live && setValue(r))
      .catch(() => live && setValue("failed"));
    return () => {
      live = false;
    };
  }, [method, nonce]);
  return value;
}

const listOf = <T,>(loaded: Loaded<T>): T[] => (Array.isArray(loaded) ? loaded : []);

/** Daemon connection, integrations, recent system events, config issues, hook failures, and the addon sections. Never work events. */
export function DiagnosticsReport({ eventLimit, compact = false }: { eventLimit: number; compact?: boolean }) {
  const health = useStore((s) => s.daemonHealth);
  const nonce = useStore((s) => s.connectionNonce);
  const local = useStore((s) => s.diagnostics);
  const fetched = useDaemonList("diagnostics_list", diagnosticSchema, { limit: 200 }, nonce);
  const integrations = useDaemonList("integrations_status", integrationStatusSchema, undefined, nonce);
  const config = useDaemonList("config_check", configIssueSchema, undefined, nonce);
  const hooks = useDaemonList("hook_log", hookRunSchema, { limit: 50 }, nonce);
  const events = mergeDiagnostics(listOf(fetched), local, eventLimit);
  const failures = hookFailures(listOf(hooks)).slice(0, eventLimit);
  const issues = listOf(config);
  return (
    <div className="diagnostics">
      <div className="diag-row">
        <span className={TONE_DOT[HEALTH[health].tone]} />
        <span>{CONNECTION_LABEL[health]}</span>
      </div>
      {integrations === "loading" && <SkeletonRows count={2} className="compact" label="checking integrations" />}
      {integrations === "failed" && <div className="diag-row faint">Integration status unavailable</div>}
      {listOf(integrations).map((i) => (
        <div key={i.kind} className="diag-row" title={i.binary ?? undefined}>
          <span className={TONE_DOT[integrationTone(i)]} />
          <span className="diag-message">
            {KIND_LABEL[i.kind]} integration {integrationText(i)}
          </span>
        </div>
      ))}

      <div className="bottom-pop-label">Recent system events</div>
      {events.length === 0 && (fetched === "loading" ? <SkeletonRows count={2} className="compact" label="loading system events" /> : <div className="diag-row faint">No system events</div>)}
      {events.map((d) => (
        <div key={`${d.at_ms}-${d.level}-${d.source}-${d.message}`} className="diag-row">
          <span className="mono faint">{timeLabel(d.at_ms)}</span>
          <span className={LEVEL_DOT[d.level]} aria-label={d.level} />
          <span className="faint">{d.source}</span>
          <span className="diag-message" title={d.message}>
            {d.message}
          </span>
        </div>
      ))}

      {(issues.length > 0 || config === "failed") && <div className="bottom-pop-label">Config issues</div>}
      {config === "failed" && <div className="diag-row faint">Config check unavailable</div>}
      {issues.map((i, n) => (
        <div key={`${i.key}-${n}`} className="diag-row">
          <span className={`state state-${i.level}`} aria-label={i.level} />
          <span className="mono">{i.key}</span>
          <span className="diag-message" title={i.message}>
            {i.message}
          </span>
        </div>
      ))}

      {failures.length > 0 && <div className="bottom-pop-label">Hook failures</div>}
      {failures.map((r) => (
        <div key={`${r.started_at_ms}-${r.event}`} className="diag-row">
          <span className="mono faint">{timeLabel(r.started_at_ms)}</span>
          <span className="state state-fail" aria-label="failed" />
          <span className="mono">{r.event}</span>
          <span className="diag-message" title={r.command}>
            {r.exit_code != null ? `exit ${r.exit_code}` : "failed"}
          </span>
        </div>
      ))}

      {builtins.map(({ id, diagnosticsSection: Section }) => Section && <Section key={id} />)}

      {compact && (
        <div className="diag-actions">
          <PopoverClose render={<Button size="sm" />} onClick={openDiagnostics}>
            Open diagnostics
          </PopoverClose>
        </div>
      )}
    </div>
  );
}

export function DiagnosticsDialog({ close }: { close: () => void }) {
  return (
    <>
      <DialogTitle>Diagnostics</DialogTitle>
      <div className="dialog-list diagnostics-dialog">
        <DaemonSummary />
        <DiagnosticsReport eventLimit={200} />
      </div>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </>
  );
}
