import { getState } from "./store";

export type Chime = "checkpoint" | "rare" | "legendary";

const NOTES: Record<Chime, number[]> = {
  checkpoint: [660, 880],
  rare: [784, 988, 1175],
  legendary: [659, 784, 988, 1319],
};

let ctx: AudioContext | null = null;

/**
 * A short synthesized chime. Plays only when `[notifications] sounds` is on, and only for the
 * rare moments that earn one: a human checkpoint and a rare or better town unlock.
 */
export function playChime(kind: Chime): void {
  if (!getState().config?.notifications?.sounds) return;
  try {
    ctx ??= new AudioContext();
    const start = ctx.currentTime + 0.01;
    NOTES[kind].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const at = start + i * 0.09;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.08, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {}
}
