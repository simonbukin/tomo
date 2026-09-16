import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";
import { rpc } from "../../api";
import { SkeletonRows } from "../../components/ui";
import { SectionLabel } from "../../sections";
import type { PrStatusResult } from "../../generated";
import { useStore } from "../../store";
import type { Worktree } from "../../types";
import { prStatusOf, setPrStatus } from "./state";

/** The inspector section. It asks `pr_status` when it mounts and every 120 s while the inspector stays open. */
export function PrSection({ worktree: w }: { worktree: Worktree }) {
  const status = useStore((s) => prStatusOf(s, w.id));
  const load = () => rpc<PrStatusResult>("pr_status", { worktree_id: w.id }).then((r) => setPrStatus(w.id, r)).catch(() => {});
  useEffect(() => {
    if (!w.exists) return;
    load();
    const t = window.setInterval(load, 120_000);
    return () => window.clearInterval(t);
  }, [w.id, w.branch, w.exists]);
  const pr = status?.pr ?? null;
  const checks = pr ? pr.checks_passed + pr.checks_failed + pr.checks_pending : 0;
  const checkState = !pr || checks === 0 ? "none" : pr.checks_failed > 0 ? "failed" : pr.checks_pending > 0 ? "pending" : "passed";
  return (
    <section className="side-section" data-section="pr">
      <SectionLabel id="pr"><button className="link" onClick={load}>refresh</button></SectionLabel>
      {pr ? (
        <>
          <div className="kv"><label>#{pr.number}</label><span className="pr-title" title={pr.title} onClick={() => openUrl(pr.url).catch(() => {})}>{pr.title}</span></div>
          <div className="kv"><label>state</label><span><span className={`state pr-${pr.state}`} /> {pr.state}{pr.draft ? " · draft" : ""}{pr.review_decision ? ` · ${pr.review_decision.replace(/_/g, " ")}` : ""}</span></div>
          <div className="kv"><label>checks</label><span><span className={`state check-${checkState}`} /> {checks === 0 ? "none" : `${pr.checks_passed} passed${pr.checks_failed ? ` · ${pr.checks_failed} failed` : ""}${pr.checks_pending ? ` · ${pr.checks_pending} pending` : ""}`}</span></div>
          {pr.mergeable && pr.mergeable !== "mergeable" && <div className="kv"><label>merge</label><span className="hot">{pr.mergeable}</span></div>}
        </>
      ) : status?.available === false ? (
        <div className="muted">{status.reason}</div>
      ) : status ? (
        <div className="muted">no pull request for {w.branch ?? "this branch"}</div>
      ) : (
        <SkeletonRows count={2} className="compact" label="checking pull request" />
      )}
    </section>
  );
}
