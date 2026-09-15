import { useEffect } from "react";
import { setState, useStore } from "../store";

const STATUS_MS = 2500;

/** The latest status message for a short time. Renders nothing when there is none. */
export function StatusSlot() {
  const message = useStore((s) => s.statusMessage);
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setState((s) => (s.statusMessage?.nonce === message.nonce ? { statusMessage: null } : {})), STATUS_MS);
    return () => window.clearTimeout(t);
  }, [message?.nonce]);
  if (!message) return null;
  return (
    <span key={message.nonce} className="status-message" role="status">
      {message.text}
    </span>
  );
}
