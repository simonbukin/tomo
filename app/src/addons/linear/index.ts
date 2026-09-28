import type { Addon } from "../types";
import { linearSignals, paletteEntries, SIGNAL_CLASS } from "./model";
import { applyLinearFrame, replaceLinear } from "./state";
import { LinearDetail, LinearPreviewDetail, LinearSignal } from "./Views";

export const linear: Addon = {
  id: "linear",
  label: "Linear",
  description: "The state of the Linear issue that a branch names, such as ENG-2611 in eng-2611-fix-login. Read-only.",
  gitDetail: LinearDetail,
  worktreeSignals: linearSignals,
  signalLine: { className: SIGNAL_CLASS, Line: LinearSignal, Detail: LinearPreviewDetail },
  paletteEntries,
  onSnapshot: replaceLinear,
  onFrame: applyLinearFrame,
};
