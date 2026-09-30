import type { Addon } from "../types";
import { appLines, apps } from "./apps";
import { looseItems, paletteEntries, sourceItems } from "./commands";
import { appUrl } from "./model";
import { applyRuntimeFrame, replaceEndpoints } from "./state";
import { EndpointMark, RuntimePopover } from "./Views";

export const runtime: Addon = {
  id: "runtime",
  label: "Runtime",
  description: "Watches the sockets a pane's processes listen on, so a running app is something Tomo can open.",
  topbar: { marks: RuntimePopover },
  worktreeMenu: looseItems,
  paletteEntries,
  appLines,
  sourceMark: EndpointMark,
  sourceMenu: sourceItems,
  appUrl,
  apps,
  onSnapshot: replaceEndpoints,
  onFrame: applyRuntimeFrame,
};
