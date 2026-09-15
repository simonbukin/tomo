import type { ReactNode } from "react";
import { Skeleton, SkeletonRows } from "./components/ui";

/** A calm empty state: one line, an optional detail, and at most one action. */
export function EmptyState({ title, detail, action, className }: { title: string; detail?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`empty-state rise${className ? ` ${className}` : ""}`}>
      <p className="empty-title">{title}</p>
      {detail && <p className="empty-detail">{detail}</p>}
      {action}
    </div>
  );
}

/** An error on the object it belongs to, not in a toast. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p className="inline-error" role="alert">
      {children}
    </p>
  );
}

export function ShellLoading({ connected }: { connected: boolean }) {
  return (
    <div className="shell-loading">
      <div className="section-label">{connected ? "loading worktrees" : "starting tomod"}</div>
      <SkeletonRows count={6} label={connected ? "loading worktrees" : "starting tomod"} className="skeleton-list" />
    </div>
  );
}

export function MapLoading() {
  return (
    <div className="towns map-loading" role="status" aria-label="loading map">
      <div className="towns-map">
        <Skeleton className="map-skeleton" />
      </div>
      <div className="towns-list">
        <SkeletonRows count={5} label="loading collection" />
      </div>
    </div>
  );
}
