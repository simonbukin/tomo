import { createRoot } from "react-dom/client";
import { App } from "./App";
import { playCover } from "./glyphCoverPlay";
import "./styles/index.css";

// Counted from the moment the window appears, not from page start: the page loads while the
// window is still hidden, so a floor measured from navigation is already spent on arrival.
const SPLASH_FLOOR_MS = 420;
const SPLASH_OPEN_MS = 720;

declare global {
  interface Window {
    __tomoShownAt?: number;
  }
}

function clearSplash() {
  const root = document.getElementById("root");
  if (root) playCover(root, { style: "aperture", ms: SPLASH_OPEN_MS });
  document.getElementById("boot")?.remove();
}

createRoot(document.getElementById("root")!).render(<App />);

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const shown = window.__tomoShownAt ?? performance.now();
    window.setTimeout(clearSplash, Math.max(0, shown + SPLASH_FLOOR_MS - performance.now()));
  }),
);
