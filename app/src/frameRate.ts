import { useEffect, useState } from "react";

export interface FrameReport {
  fps: number;
  longestGapMs: number;
}

/** A gap longer than one and a half frames at the rate on offer dropped at least one. */
export const droppedAt = (fps: number): number => (fps > 0 ? 1500 / fps : 25);

export function summarise(gaps: readonly number[]): FrameReport {
  if (gaps.length === 0) return { fps: 0, longestGapMs: 0 };
  const total = gaps.reduce((sum, ms) => sum + ms, 0);
  return { fps: Math.round((gaps.length * 1000) / total), longestGapMs: Math.round(Math.max(...gaps)) };
}

export function useFrameRate(on: boolean): FrameReport | null {
  const [report, setReport] = useState<FrameReport | null>(null);
  const [awake, setAwake] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  useEffect(() => {
    const note = () => setAwake(!document.hidden);
    document.addEventListener("visibilitychange", note);
    return () => document.removeEventListener("visibilitychange", note);
  }, []);
  useEffect(() => {
    // A hidden window is throttled, so the reading would be a lie and the wake-ups a waste.
    if (!on || !awake) {
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
  }, [on, awake]);
  return report;
}
