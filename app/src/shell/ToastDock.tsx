import { useEffect } from "react";
import { dismissToast, useStore, type Toast } from "../store";

const LIFETIME_MS: Record<Toast["level"], number> = { info: 4000, warning: 7000, error: 12000 };
const VISIBLE = 3;

/** Exceptional events, stacked upward above the bottom strip, newest at the bottom. */
export function ToastDock() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toast-dock" aria-live="polite">
      {toasts.slice(-VISIBLE).map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast: t }: { toast: Toast }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(t.id), LIFETIME_MS[t.level]);
    return () => window.clearTimeout(timer);
  }, [t.id]);
  return (
    <div className={`toast toast-${t.level}`} role={t.level === "error" ? "alert" : "status"}>
      <span className="toast-title">{t.title}</span>
      {t.detail && <span className="toast-detail">{t.detail}</span>}
    </div>
  );
}
