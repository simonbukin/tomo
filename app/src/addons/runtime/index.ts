import type { Addon } from "../types";
import { apps } from "./apps";
import { looseItems, paletteEntries, sourceItems } from "./commands";
import { appUrl, runtimeSignals, SIGNAL_CLASS } from "./model";
import { applyRuntimeFrame, replaceEndpoints } from "./state";
import { EndpointMark, RuntimePopover, RuntimeSignal } from "./Views";

export const runtime: Addon = {
  id: "runtime",
  label: "Runtime",
  description: "Watches the sockets a pane's processes listen on, so a running app is something Tomo can open.",
  topbar: { marks: RuntimePopover },
  worktreeMenu: looseItems,
  paletteEntries,
  worktreeSignals: runtimeSignals,
  signalLine: { className: SIGNAL_CLASS, Line: RuntimeSignal },
  sourceMark: EndpointMark,
  sourceMenu: sourceItems,
  appUrl,
  apps,
  onSnapshot: replaceEndpoints,
  onFrame: applyRuntimeFrame,
};
