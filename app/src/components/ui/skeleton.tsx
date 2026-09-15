import type { CSSProperties } from "react";
import { cx } from "./cx";

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  className?: string;
}

/** A placeholder bar for content that is still loading. It is hidden from assistive technology. */
export function Skeleton({ width, height, className }: SkeletonProps) {
  return <span aria-hidden className={cx("skeleton", className)} style={{ width, height }} />;
}

const WIDTHS = ["72%", "54%", "63%", "41%", "58%"];

/** A short column of skeleton rows with varied widths, and one label for screen readers. */
export function SkeletonRows({ count = 4, label = "loading", className }: { count?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cx("skeleton-rows", className)}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="skeleton-row">
          <Skeleton width={WIDTHS[i % WIDTHS.length]} />
        </span>
      ))}
    </div>
  );
}
