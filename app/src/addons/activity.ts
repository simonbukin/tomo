import type { ActivityKindView } from "./types";

/**
 * The composition root for Activity row views of addon kinds. Only `activityKinds.ts` imports it.
 * It is not a slot on `Addon`, because these views call `actions.ts`, and `actions.ts` imports `addons/index.ts`.
 */
export const addonActivity: readonly Readonly<Record<string, ActivityKindView>>[] = [];
