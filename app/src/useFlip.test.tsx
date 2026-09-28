import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlip } from "./useFlip";

function List({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref);
  return (
    <div ref={ref} data-testid="root" style={{ "--dur-open": "240ms" } as React.CSSProperties}>
      {ids.map((id) => (
        <div key={id} data-flip={id}>
          {id}
        </div>
      ))}
    </div>
  );
}

type Run = { onfinish: (() => void) | null; oncancel: (() => void) | null; finished: Promise<void>; cancel: () => void };

describe("useFlip", () => {
  const calls: { target: HTMLElement; frames: Keyframe[]; run: Run }[] = [];
  beforeEach(() => {
    calls.length = 0;
    Element.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
      const run: Run = { onfinish: null, oncancel: null, finished: new Promise(() => {}), cancel: () => run.oncancel?.() };
      calls.push({ target: this, frames, run });
      return run as unknown as Animation;
    }) as unknown as Element["animate"];
  });
  afterEach(cleanup);

  it("keeps a removed item on screen, shuts it, and then takes it out", () => {
    const { rerender, getByTestId } = render(<List ids={["a", "b", "c"]} />);
    rerender(<List ids={["a", "c"]} />);
    const ghost = calls.find((c) => c.target.dataset.flip === "b");
    expect(ghost?.frames.at(-1)).toMatchObject({ clipPath: "inset(0 0 100% 0)", opacity: 0 });
    expect(ghost!.target.parentElement).toBe(getByTestId("root"));
    expect(ghost!.target.inert).toBe(true);
    ghost!.run.onfinish?.();
    expect(ghost!.target.isConnected).toBe(false);
  });

  it("opens a new item from its top edge, but not on the first render", () => {
    const { rerender } = render(<List ids={["a"]} />);
    expect(calls).toHaveLength(0);
    rerender(<List ids={["a", "b"]} />);
    const reveal = calls.find((c) => c.target.dataset.flip === "b");
    expect(reveal?.frames[0]).toMatchObject({ clipPath: "inset(0 0 100% 0)" });
  });
});
