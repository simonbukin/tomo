import { describe, expect, it } from "vitest";
import { GRACE_MS, initialHealth, stepHealth, type HealthEvent, type HealthModel } from "./daemonHealth";

const run = (events: HealthEvent[], from: HealthModel = initialHealth) =>
  events.reduce(({ model, effects }, e) => {
    const next = stepHealth(model, e);
    return { model: next.model, effects: [...effects, ...next.effects] };
  }, { model: from, effects: [] as ReturnType<typeof stepHealth>["effects"] });

const healthy: HealthModel = { health: "healthy", lostAt: null };

describe("stepHealth", () => {
  it("the first connection is quiet", () => {
    expect(run([{ type: "down", at: 0 }, { type: "up", at: 100 }])).toEqual({ model: healthy, effects: [] });
  });

  it("G: a quick recovery records one diagnostic and never toasts", () => {
    const r = run([{ type: "down", at: 1000 }, { type: "up", at: 2200 }], healthy);
    expect(r.model).toEqual(healthy);
    expect(r.effects).toEqual([{ kind: "diagnostic", level: "info", message: "reconnected after 1.2 s" }]);
  });

  it("a lost connection is reconnecting until the grace period ends", () => {
    expect(stepHealth(healthy, { type: "down", at: 5 })).toEqual({ model: { health: "reconnecting", lostAt: 5 }, effects: [] });
  });

  it("G: a prolonged loss becomes disconnected with one toast and one diagnostic", () => {
    const r = run([{ type: "down", at: 0 }, { type: "grace", at: GRACE_MS }, { type: "down", at: GRACE_MS + 1 }, { type: "grace", at: GRACE_MS * 2 }], healthy);
    expect(r.model.health).toBe("disconnected");
    expect(r.effects).toEqual([{ kind: "diagnostic", level: "error", message: "daemon disconnected" }, { kind: "toast" }]);
  });

  it("recovery after disconnected dismisses the keyed toast", () => {
    const r = run([{ type: "down", at: 0 }, { type: "grace", at: GRACE_MS }, { type: "up", at: 10_000 }], healthy);
    expect(r.model).toEqual(healthy);
    expect(r.effects.slice(2)).toEqual([{ kind: "diagnostic", level: "info", message: "reconnected after 10.0 s" }, { kind: "dismiss" }]);
  });

  it("a daemon that is not there at start is reported once, then connected", () => {
    const r = run([{ type: "grace", at: GRACE_MS }, { type: "up", at: 9000 }]);
    expect(r.effects).toEqual([{ kind: "diagnostic", level: "error", message: "daemon not reachable" }, { kind: "toast" }, { kind: "diagnostic", level: "info", message: "connected" }, { kind: "dismiss" }]);
  });

  it("a stale grace timer after recovery does nothing", () => {
    expect(stepHealth(healthy, { type: "grace", at: 1 })).toEqual({ model: healthy, effects: [] });
  });
});
