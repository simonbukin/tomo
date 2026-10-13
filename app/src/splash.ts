import { playCover } from "./glyphCoverPlay";

const OPEN_MS = 720;

export function openSplash(): void {
  const boot = document.getElementById("boot");
  if (!boot) return;
  const root = document.getElementById("root");
  if (root) playCover(root, { style: "aperture", ms: OPEN_MS });
  boot.remove();
}
