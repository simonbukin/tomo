import { useLayoutEffect, useRef } from "react";

const placeBlock = (block: HTMLElement, active: HTMLElement | null) => {
  const appearing = active && block.style.opacity !== "1";
  if (appearing) block.style.transition = "none";
  block.style.opacity = active ? "1" : "0";
  if (!active) return;
  block.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  block.style.width = `${active.offsetWidth}px`;
  block.style.height = `${active.offsetHeight}px`;
  if (!appearing) return;
  void block.offsetWidth;
  block.style.transition = "";
};

/**
 * Puts one inverted selection block in the host and moves it to the item that matches `activeSelector`.
 * The host needs a `.glide` child. The block jumps on first paint and glides after that.
 */
export function useGlide<T extends HTMLElement>(activeSelector: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    const block = host?.querySelector<HTMLElement>(":scope > .glide");
    if (!host || !block) return;
    const place = () => placeBlock(block, host.querySelector<HTMLElement>(activeSelector));
    place();
    const ready = requestAnimationFrame(() => (block.dataset.ready = ""));
    const mutations = new MutationObserver(place);
    mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-current", "aria-selected"] });
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resizes?.observe(host);
    return () => {
      cancelAnimationFrame(ready);
      mutations.disconnect();
      resizes?.disconnect();
    };
  }, [activeSelector]);
  return ref;
}
