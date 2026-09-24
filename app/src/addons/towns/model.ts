import type { Chime } from "../../sounds";

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export type CeremonyTier = "small" | "strong" | "special";

const TIERS: Record<Rarity, CeremonyTier> = { common: "small", uncommon: "small", rare: "strong", epic: "strong", legendary: "special" };
const CHIMES: Record<CeremonyTier, Chime | null> = { small: null, strong: "rare", special: "legendary" };
const DURATIONS: Record<CeremonyTier, number> = { small: 2600, strong: 3800, special: 5200 };

export function ceremonyTier(rarity: string): CeremonyTier {
  return TIERS[rarity as Rarity] ?? "small";
}

export function chimeFor(tier: CeremonyTier): Chime | null {
  return CHIMES[tier];
}

export function revealDurationMs(tier: CeremonyTier): number {
  return DURATIONS[tier];
}

export function prefersReducedMotion(win: Pick<Window, "matchMedia"> | undefined = globalThis.window): boolean {
  try {
    return !!win?.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function unlockedLine(have: number, total: number): string {
  return `${have} / ${total}`;
}

export function townsProgress(have: number, total: number): string {
  return `${have} / ${total} municipalities unlocked.`;
}
