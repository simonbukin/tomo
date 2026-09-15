import { useSyncExternalStore } from "react";
import type { UsageSnapshot } from "../../generated";
import type { Frame } from "../../types";

let snapshots: UsageSnapshot[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getUsage = (): UsageSnapshot[] => snapshots;

export function setUsage(next: UsageSnapshot[]): void {
  snapshots = next;
  listeners.forEach((l) => l());
}

export const useUsage = (): UsageSnapshot[] => useSyncExternalStore(subscribe, getUsage);

export function applyUsageFrame(frame: Frame): void {
  if (frame.event === "usage_changed") setUsage((frame.data as { snapshots: UsageSnapshot[] }).snapshots);
}
