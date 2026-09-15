import { useEffect, useRef } from "react";
import { dismissToastKey, getState, recordDiagnostic, setState, toast, useStore } from "../store";
import { GRACE_MS, initialHealth, stepHealth, type HealthEffect, type HealthEvent } from "./daemonHealth";

const HEALTH_TOAST_KEY = "daemon-health";

function runEffect(effect: HealthEffect): void {
  if (effect.kind === "diagnostic") recordDiagnostic(effect.level, "daemon", effect.message);
  else if (effect.kind === "toast") toast({ key: HEALTH_TOAST_KEY, level: "error", title: "Daemon disconnected", detail: "Tomo reconnects when the daemon is back", sticky: true });
  else dismissToastKey(HEALTH_TOAST_KEY);
}

/** Drives `daemonHealth` from the connection: a short loss is a diagnostic, a long loss is also a toast. */
export function useDaemonHealth(): void {
  const connected = useStore((s) => s.connected);
  const model = useRef(initialHealth);
  useEffect(() => {
    const apply = (event: HealthEvent) => {
      const next = stepHealth(model.current, event);
      model.current = next.model;
      if (getState().daemonHealth !== next.model.health) setState({ daemonHealth: next.model.health });
      next.effects.forEach(runEffect);
    };
    apply({ type: connected ? "up" : "down", at: Date.now() });
    if (connected) return;
    const timer = window.setTimeout(() => apply({ type: "grace", at: Date.now() }), GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [connected]);
}
