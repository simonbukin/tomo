import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";
import { rpcParsed } from "../../api";
import { prStatusResultSchema } from "../../schemas";
import { SkeletonRows } from "../../components/ui";
import {failQuietly, failToast, useStore} from "../../store";
import type { Worktree } from "../../types";
import { prStatusOf, setPrStatus } from "./state";

const PR_POLL_MS = 120_000;

export function PrDetail({ worktree: w }: { worktree: Worktree }) {
  const status = useStore((s) => prStatusOf(s, w.id));
  const load = () => rpcParsed("pr_status", prStatusResultSchema, { worktree_id: w.id }).then((r) => setPrStatus(w.id, r)).catch(failQuietly("pr_status"));
  useEffect(() => {
    if (!w.exists) return;
    load();
    const t = window.setInterval(load, PR_POLL_MS);
    return () => window.clearInterval(t);
  }, [w.id, w.branch, w.exists]);
  const pr = status?.pr ?? null;
  const checks = pr ? pr.checks_passed + pr.checks_failed + pr.checks_pending : 0;
  const checkState = !pr || checks === 0 ? "none" : pr.checks_failed > 0 ? "failed" : pr.checks_pending > 0 ? "pending" : "passed";
  if (!pr) {
    if (status?.available === false) return <div className="kv"><label>pull request</label><span className="muted">{status.reason}</span></div>;
    if (status) return <div className="kv"><label>pull request</label><span className="muted">none</span></div>;
    return <SkeletonRows count={1} className="compact" label="checking pull request" />;
  }
  return (
    <>
      <div className="kv"><label>pull request</label><span className="pr-title" title={pr.title} onClick={() => openUrl(pr.url).catch(failToast("Could not open the link"))}><span className="pr-number">#{pr.number}</span> <span>{pr.title}</span></span></div>
      <div className="kv"><label>review</label><span><span className={`state pr-${pr.state}`} /> {pr.state}{pr.draft ? ", draft" : ""}{pr.review_decision ? `, ${pr.review_decision.replace(/_/g, " ")}` : ""}</span></div>
      <div className="kv"><label>checks</label><span><span className={`state check-${checkState}`} /> {checks === 0 ? "none" : `${pr.checks_passed} passed${pr.checks_failed ? `, ${pr.checks_failed} failed` : ""}${pr.checks_pending ? `, ${pr.checks_pending} pending` : ""}`}</span></div>
      {pr.mergeable && pr.mergeable !== "mergeable" && <div className="kv"><label>merge</label><span className="hot">{pr.mergeable}</span></div>}
    </>
  );
}
