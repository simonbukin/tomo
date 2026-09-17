import { Map as MapIcon } from "lucide-react";
import { lazy } from "react";
import { rpc } from "../../api";
import type { TownUnlock } from "../../generated";
import { setUi } from "../../store";
import type { Addon } from "../types";
import { MapLoading } from "./MapLoading";
import { applyTownFrame, setTownState } from "./state";
import { TownReveal } from "./TownReveal";
import { TownSuggest } from "./TownSuggest";

export const towns: Addon = {
  id: "towns",
  views: [{ id: "towns", title: "map", label: "Map", icon: MapIcon, component: lazy(() => import("./Towns").then((m) => ({ default: m.Towns }))), fallback: MapLoading }],
  commands: [{ id: "towns", label: "Open map", group: "Navigation", run: () => setUi({ view: "towns" }) }],
  worktreeNameField: TownSuggest,
  mount: TownReveal,
  onSnapshot: () => {
    rpc<{ unlocks: TownUnlock[] }>("town_list")
      .then((r) => setTownState({ unlocks: r.unlocks ?? [] }))
      .catch(() => {});
  },
  onFrame: applyTownFrame,
};
