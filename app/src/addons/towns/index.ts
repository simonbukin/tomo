import { townUnlockSchema } from "../../schemas";
import { z } from "zod";
import { Map as MapIcon } from "lucide-react";
import { lazy } from "react";
import { rpcParsed } from "../../api";
import {failQuietly, setUi} from "../../store";
import type { Addon } from "../types";
import { MapLoading } from "./MapLoading";
import { applyTownFrame, setTownState } from "./state";
import { TownReveal } from "./TownReveal";
import { TownSuggest } from "./TownSuggest";

export const towns: Addon = {
  id: "towns",
  label: "Towns",
  description: "Names a new worktree after a Japanese town, and keeps the map of the ones you have unlocked.",
  views: [{ id: "towns", title: "map", label: "Map", icon: MapIcon, component: lazy(() => import("./Towns").then((m) => ({ default: m.Towns }))), fallback: MapLoading }],
  commands: [{ id: "towns", label: "Open map", group: "Navigation", run: () => setUi({ view: "towns" }) }],
  worktreeNameField: TownSuggest,
  mount: TownReveal,
  onSnapshot: () => {
    rpcParsed("town_list", z.object({ unlocks: z.array(townUnlockSchema) }), undefined)
      .then((r) => setTownState({ unlocks: r.unlocks ?? [] }))
      .catch(failQuietly("town_list"));
  },
  onFrame: applyTownFrame,
};
