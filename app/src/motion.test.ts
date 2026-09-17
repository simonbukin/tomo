import { afterEach, describe, expect, it, vi } from "vitest";
import { transition, watchPointer } from "./motion";

type Stub = (update: () => void) => { finished: Promise<void> };
const stub = (fn: Stub | null) => Object.defineProperty(document, "startViewTransition", { value: fn ?? undefined, configurable: true, writable: true });

afterEach(() => {
  stub(null);
  delete document.documentElement.dataset.transition;
  document.documentElement.removeAttribute("style");
});

describe("motion is an enhancement", () => {
  it("still changes the state where the browser cannot move between two of them", () => {
    const update = vi.fn();
    transition("reveal", update);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.transition).toBeUndefined();
  });

  it("names the kind and the origin for the stylesheet, then clears them", async () => {
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    stub((update) => {
      update();
      return { finished };
    });
    const update = vi.fn();
    transition("theme", update, { x: 40, y: 10 });
    const root = document.documentElement;
    expect(update).toHaveBeenCalledOnce();
    expect(root.dataset.transition).toBe("theme");
    expect(root.style.getPropertyValue("--reveal-x")).toBe("40px");
    expect(root.style.getPropertyValue("--reveal-y")).toBe("10px");
    expect(Number.parseInt(root.style.getPropertyValue("--reveal-radius"), 10)).toBeGreaterThan(0);
    finish();
    await finished;
    await Promise.resolve();
    expect(root.dataset.transition).toBeUndefined();
  });

  it("opens from the last place the person pressed", () => {
    const stop = watchPointer(window);
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 123, clientY: 45 }));
    stub((update) => {
      update();
      return { finished: Promise.resolve() };
    });
    transition("reveal", () => {});
    expect(document.documentElement.style.getPropertyValue("--reveal-x")).toBe("123px");
    stop();
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 999, clientY: 999 }));
    transition("reveal", () => {});
    expect(document.documentElement.style.getPropertyValue("--reveal-x")).toBe("123px");
  });
});
