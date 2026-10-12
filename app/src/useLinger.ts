import { useEffect, useState } from "react";

const openMs = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dur-open")) || 0;

/** True while `on`, and for the length of the open motion after it turns off, so a closing part can be seen go. */
export function useLinger(on: boolean): boolean {
  const [lingering, setLingering] = useState(on);
  useEffect(() => {
    if (on) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), openMs());
    return () => window.clearTimeout(timer);
  }, [on]);
  return on || lingering;
}
