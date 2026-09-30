import type { CSSProperties } from "react";
import { siLinear } from "simple-icons";

export function LinearGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg className={className ?? "icon"} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d={siLinear.path} fill="currentColor" />
    </svg>
  );
}
