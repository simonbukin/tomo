import { useSyncExternalStore } from "react";
import type { TownUnlock } from "../../generated";
import type { Frame } from "../../types";

export interface TownsState {
  unlocks: TownUnlock[];
  /** The unlock that the ceremony shows. A new `nonce` restarts the ceremony. */
  reveal: { unlock: TownUnlock; nonce: number } | null;
}

let state: TownsState = { unlocks: [], reveal: null };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getTownState = (): TownsState => state;

export function setTownState(patch: Partial<TownsState> | ((s: TownsState) => Partial<TownsState>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

/** The selector must return a stable value, such as a field or a number, because it has no cache. */
export function useTownState<T>(selector: (s: TownsState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function applyTownFrame(frame: Frame): void {
  if (frame.event !== "town_unlocked") return;
  const { unlock } = frame.data as { unlock: TownUnlock };
  setTownState((s) => ({ unlocks: [...s.unlocks.filter((u) => u.slug !== unlock.slug), unlock], reveal: { unlock, nonce: (s.reveal?.nonce ?? 0) + 1 } }));
}
