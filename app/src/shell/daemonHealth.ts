import type { DaemonHealth } from "../store";
import type { DiagnosticLevel } from "../types";

/** How long a lost connection may stay lost before Tomo calls it disconnected and shows a toast. */
export const GRACE_MS = 4000;

export type HealthEvent = { type: "up" | "down" | "grace"; at: number };

export interface HealthModel {
  health: DaemonHealth;
  /** When the connection was lost. `null` before the first connection. */
  lostAt: number | null;
}

export type HealthEffect = { kind: "diagnostic"; level: DiagnosticLevel; message: string } | { kind: "toast" } | { kind: "dismiss" };

export const initialHealth: HealthModel = { health: "reconnecting", lostAt: null };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function stepHealth(model: HealthModel, event: HealthEvent): { model: HealthModel; effects: HealthEffect[] } {
  const same = { model, effects: [] };
  switch (event.type) {
    case "down":
      return model.health === "healthy" ? { model: { health: "reconnecting", lostAt: event.at }, effects: [] } : same;
    case "grace":
      if (model.health !== "reconnecting") return same;
      return {
        model: { ...model, health: "disconnected" },
        effects: [{ kind: "diagnostic", level: "error", message: model.lostAt == null ? "daemon not reachable" : "daemon disconnected" }, { kind: "toast" }],
      };
    case "up": {
      if (model.health === "healthy") return same;
      const wasDown = model.health === "disconnected";
      const message = model.lostAt != null ? `reconnected after ${seconds(event.at - model.lostAt)}` : wasDown ? "connected" : null;
      const diagnostic: HealthEffect[] = message ? [{ kind: "diagnostic", level: "info", message }] : [];
      return { model: { health: "healthy", lostAt: null }, effects: wasDown ? [...diagnostic, { kind: "dismiss" }] : diagnostic };
    }
  }
}
