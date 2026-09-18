import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";

// Counted from the moment the window appears, not from page start: the page loads while the
// window is still hidden, so a floor measured from navigation is already spent on arrival.
const SPLASH_FLOOR_MS = 420;

declare global {
  interface Window {
    __tomoShownAt?: number;
  }
}

function clearSplash() {
  const boot = document.getElementById("boot");
  if (!boot) return;
  boot.dataset.done = "";
  boot.addEventListener("transitionend", () => boot.remove(), { once: true });
  window.setTimeout(() => boot.remove(), 600);
}

createRoot(document.getElementById("root")!).render(<App />);

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const shown = window.__tomoShownAt ?? performance.now();
    window.setTimeout(clearSplash, Math.max(0, shown + SPLASH_FLOOR_MS - performance.now()));
  }),
);
