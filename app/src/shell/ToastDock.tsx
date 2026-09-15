import { X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, IconButton } from "../components/ui";
import { GLYPH, type Status } from "../glyphs";
import { dismissToast, useStore, type Toast, type ToastLevel } from "../store";
import { useDaemonHealth } from "./useDaemonHealth";

const LIFETIME_MS: Record<ToastLevel, number> = { info: 4000, warning: 7000, error: 12000 };
const EXIT_MS = 100;
const LEVEL_STATUS: Record<ToastLevel, Status> = { info: "idle", warning: "needs", error: "failed" };

/** Exceptional events, stacked upward above the bottom strip, newest at the bottom. */
export function ToastDock() {
  useDaemonHealth();
  const toasts = useStore((s) => s.toasts);
  return (
    <section className="toast-dock" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </section>
  );
}

function ToastCard({ toast: t }: { toast: Toast }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(LIFETIME_MS[t.level]);
  const paused = hovered || focused;

  useEffect(() => {
    if (t.sticky || paused || leaving) return;
    const started = Date.now();
    const timer = window.setTimeout(() => setLeaving(true), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, leaving]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismissToast(t.id), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const close = () => setLeaving(true);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  const status = LEVEL_STATUS[t.level];
  const actions = (t.actions ?? []).slice(0, 2);

  return (
    <div
      className={`toast toast-${t.level}`}
      data-leaving={leaving || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
      onKeyDown={onKeyDown}
    >
      <span className={`glyph glyph-${status}`} aria-hidden="true">
        {GLYPH[status]}
      </span>
      <div className="toast-body">
        <div className="toast-title">{t.title}</div>
        {t.detail && (
          <div className="toast-detail" title={t.detail}>
            {t.detail}
          </div>
        )}
        {actions.length > 0 && (
          <div className="toast-actions">
            {actions.map((a) => (
              <Button
                key={a.label}
                variant="link"
                onClick={() => {
                  a.run();
                  close();
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton label="Dismiss" className="toast-close" onClick={close}>
        <X className="icon" />
      </IconButton>
    </div>
  );
}
