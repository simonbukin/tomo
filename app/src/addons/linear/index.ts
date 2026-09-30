import type { Addon } from "../types";
import { linearLinks, paletteEntries, searchSources } from "./model";
import { applyLinearFrame, replaceLinear } from "./state";
import { LinearDetail } from "./Views";

export const linear: Addon = {
  id: "linear",
  label: "Linear",
  description: "The state of the Linear issue that a branch names, such as ENG-2611 in eng-2611-fix-login. Read-only.",
  gitDetail: LinearDetail,
  worktreeLinks: linearLinks,
  paletteEntries,
  searchSources,
  onSnapshot: replaceLinear,
  onFrame: applyLinearFrame,
};
