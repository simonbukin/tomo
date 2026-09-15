import type { Addon } from "../types";
import { applyUsageFrame, setUsage } from "./state";
import { UsageDiagnostics, UsageMeters } from "./UsageStrip";

export const usage: Addon = {
  id: "usage",
  bottomItem: UsageMeters,
  diagnosticsSection: UsageDiagnostics,
  onSnapshot: (snapshot) => setUsage(snapshot.usage ?? []),
  onFrame: applyUsageFrame,
};
