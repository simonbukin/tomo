import { resetsIn } from "../../activityModel";
import { rpc } from "../../api";
import type { UsageSnapshot } from "../../generated";
import { HoverPopover } from "../../shell/HoverPopover";
import { KIND_LABEL } from "../../types";
import { bucketTone, headlineBucket, microBar, percentText, resetShort, usageIssues, usageRows, usageTone } from "./model";
import { setUsage, useUsage } from "./state";

function refreshUsage(): void {
  rpc<UsageSnapshot[]>("usage_get", { refresh: true })
    .then((list) => Array.isArray(list) && setUsage(list))
    .catch(() => {});
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

/** The bottom strip item: one meter for each plan and each model scope. */
export function UsageMeters() {
  const usage = useUsage();
  return (
    <>
      {usageRows(usage).map((row) => (
        <UsageMeter key={row.key} name={row.name} snapshot={row.snapshot} />
      ))}
    </>
  );
}

function UsageMeter({ name, snapshot: u }: { name: string; snapshot: UsageSnapshot }) {
  const head = headlineBucket(u);
  const reset = head ? resetShort(head.resets_at_ms) : null;
  const label = `${name} usage ${head ? percentText(head.fraction_used) : "unavailable"}${reset ? `, resets in ${reset}` : ""}`;
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
        <button type="button" className={`bottom-item usage-meter tone-${usageTone(u)}`} aria-label={label}>
          <span className="usage-name">{name}</span>
          {head ? (
            <>
              <MicroBar fraction={head.fraction_used} />
              <span className="num">{percentText(head.fraction_used)}</span>
              {reset && <span className="usage-reset num">{reset}</span>}
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

/** The diagnostics section: each provider without data, with its reason. */
export function UsageDiagnostics() {
  const issues = usageIssues(useUsage());
  if (!issues.length) return null;
  return (
    <>
      <div className="bottom-pop-label">Usage</div>
      {issues.map((u) => (
        <div key={u.provider} className="diag-row">
          <span className="state state-warning" />
          <span className="diag-message">
            {KIND_LABEL[u.provider]} usage unavailable{u.reason ? ` · ${u.reason}` : ""}
          </span>
        </div>
      ))}
    </>
  );
}
