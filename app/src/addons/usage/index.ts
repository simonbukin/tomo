import type { Addon } from "../types";
import { applyUsageFrame, setUsage } from "./state";
import { UsageDiagnostics, UsageMeters } from "./UsageStrip";

export const usage: Addon = {
  id: "usage",
  label: "Usage",
  description: "Each provider's plan and model limits in the bottom strip, with when the window resets.",
  bottomItem: UsageMeters,
  diagnosticsSection: UsageDiagnostics,
  onSnapshot: (snapshot) => setUsage(snapshot.usage ?? []),
  onFrame: applyUsageFrame,
};
