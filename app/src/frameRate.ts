import { useEffect, useState } from "react";

export interface FrameReport {
  /** Frames per second over the last window. */
  fps: number;
  /** The longest gap between two frames in the window, in milliseconds. */
  worstMs: number;
}

/** A frame longer than this dropped at least one at 60 Hz. */
export const DROPPED_MS = 20;

export function summarise(gaps: readonly number[]): FrameReport {
  if (gaps.length === 0) return { fps: 0, worstMs: 0 };
  const total = gaps.reduce((sum, ms) => sum + ms, 0);
  return { fps: Math.round((gaps.length * 1000) / total), worstMs: Math.round(Math.max(...gaps)) };
}

/**
 * Counts frames while `on`. It runs no loop when off, because a meter that wakes the main
 * thread sixty times a second to say the main thread is busy is its own problem.
 */
export function useFrameRate(on: boolean): FrameReport | null {
  const [report, setReport] = useState<FrameReport | null>(null);
  useEffect(() => {
    if (!on) {
      setReport(null);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let gaps: number[] = [];
    let reportedAt = last;
    const tick = (now: number) => {
      gaps.push(now - last);
      last = now;
      if (now - reportedAt >= 500) {
        setReport(summarise(gaps));
        gaps = [];
        reportedAt = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return report;
}
