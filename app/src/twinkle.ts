/**
 * The live twinkle of a working mark: sparks land on random cells at random times, warm their neighbours, and fade.
 * Each mark runs its own field, so no two marks move together and the pattern never repeats.
 */
export interface Field {
  readonly heat: readonly number[];
  readonly glow: readonly number[];
}

export type Rand = () => number;

const CELLS = 9;
const SPARKS_PER_SECOND = 5;
const COOL_SECONDS = 0.8;
const SWELL_SECONDS = 0.07;
const NEIGHBOUR_SHARE = 0.25;
const ALIVE = 0.45;
const FLOOR = 0.2;
const CONTRAST = 1.25;
const MAX_STEP_SECONDS = 0.05;

const neighbours = (c: number): number[] =>
  [c - 3, c + 3, c % 3 > 0 ? c - 1 : -1, c % 3 < 2 ? c + 1 : -1].filter((n) => n >= 0 && n < CELLS);

const spark = (heat: readonly number[], rand: Rand): number[] => {
  const at = Math.floor(rand() * CELLS);
  const strength = 0.8 + 0.2 * rand();
  const near = neighbours(at);
  return heat.map((h, c) => (c === at ? Math.max(h, strength) : near.includes(c) ? Math.min(1, h + NEIGHBOUR_SHARE * strength) : h));
};

export const seedField = (rand: Rand): Field => {
  const heat = Array.from({ length: CELLS }, () => rand() * 0.6);
  return { heat, glow: heat };
};

export const stepField = (field: Field, seconds: number, rand: Rand): Field => {
  const dt = Math.min(Math.max(seconds, 0), MAX_STEP_SECONDS);
  const cooled = field.heat.map((h) => h * Math.exp(-dt / COOL_SECONDS));
  const sparked = rand() < 1 - Math.exp(-SPARKS_PER_SECOND * dt) ? spark(cooled, rand) : cooled;
  const heat = Math.max(...sparked) < ALIVE ? spark(sparked, rand) : sparked;
  const follow = 1 - Math.exp(-dt / SWELL_SECONDS);
  return { heat, glow: field.glow.map((g, c) => g + (heat[c] - g) * follow) };
};

export const opacities = (field: Field): number[] => field.glow.map((g) => FLOOR + (1 - FLOOR) * Math.min(1, Math.max(0, g)) ** CONTRAST);
