import { Film } from "lucide-react";
import { createElement, lazy } from "react";
import { SkeletonRows } from "../../components/ui";
import { setUi } from "../../store";
import type { Addon } from "../types";

const VIEW = "anime-chart";

export const animeChart: Addon = {
  id: VIEW,
  views: [
    {
      id: VIEW,
      title: "anime chart",
      label: "chart",
      icon: Film,
      component: lazy(() => import("./Chart")),
      fallback: () => createElement(SkeletonRows, { count: 6, label: "loading the chart" }),
    },
  ],
  commands: [{ id: VIEW, label: "Anime chart", group: "Navigation", run: () => setUi({ view: VIEW }) }],
};
