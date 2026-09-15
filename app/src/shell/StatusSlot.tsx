import { useEffect, useState } from "react";
import { GLYPH } from "../glyphs";
import { setState, useStore } from "../store";

const STATUS_MS = 2500;
const FADE_MS = 120;

/** The latest status message for a short time. The polite live region stays mounted so each message is read once. */
export function StatusSlot() {
  const message = useStore((s) => s.statusMessage);
  const [fading, setFading] = useState<number | null>(null);
  useEffect(() => {
    if (!message) return;
    const fade = window.setTimeout(() => setFading(message.nonce), STATUS_MS - FADE_MS);
    const clear = window.setTimeout(() => setState((s) => (s.statusMessage?.nonce === message.nonce ? { statusMessage: null } : {})), STATUS_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [message?.nonce]);
  return (
    <span className="status-slot" role="status" aria-live="polite" aria-atomic="true">
      {message && (
        <span key={message.nonce} className="status-message" data-leaving={fading === message.nonce || undefined}>
          <span className="glyph glyph-complete" aria-hidden="true">
            {GLYPH.complete}
          </span>
          {message.text}
        </span>
      )}
    </span>
  );
}
