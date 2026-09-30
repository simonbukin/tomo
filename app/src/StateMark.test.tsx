import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cellsPath, LIT, StateMark } from "./StateMark";

afterEach(cleanup);

const mark = () => document.querySelector(".mark")!;
const svg = () => mark().querySelector("svg")!;
const tip = () => mark().getAttribute("title");

describe("the solid mark", () => {
  it("is one 9px SVG whose lit cells are one path, with the unlit cells as a second path and no text of its own", () => {
    render(<StateMark mark="needs" />);
    expect(mark().querySelectorAll("svg")).toHaveLength(1);
    expect(svg().getAttribute("viewBox")).toBe("0 0 9 9");
    expect(mark().getAttribute("data-mark")).toBe("needs");
    expect(mark().querySelectorAll("path.lit")).toHaveLength(1);
    expect(mark().querySelector("path.lit")!.getAttribute("d")).toBe(cellsPath([1, 3, 4, 5, 7]));
    expect(mark().querySelector("path.off")!.getAttribute("d")).toBe(cellsPath([0, 2, 6, 8]));
    expect(mark().querySelectorAll("rect")).toHaveLength(0);
    expect(tip()).toBe("needs you");
    expect(mark().textContent).toBe("");
  });

  it("draws nine twinkling cells while an agent works or a worktree archives", () => {
    for (const state of ["working", "archiving"] as const) {
      render(<StateMark mark={state} />);
      expect(mark().querySelectorAll("rect.tw")).toHaveLength(9);
      expect(mark().querySelectorAll("path")).toHaveLength(0);
      cleanup();
    }
  });

  it("draws a done mark as one solid block with no ghost", () => {
    render(<StateMark mark="done" />);
    expect(mark().querySelectorAll("path")).toHaveLength(1);
    expect(mark().querySelector("path.lit")!.getAttribute("d")).toBe(cellsPath(LIT.done));
  });

  it("gives every still state its own pattern", () => {
    const patterns = Object.entries(LIT).filter(([state]) => state !== "sleeping-done").map(([, cells]) => cells.join());
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("keeps the layout class of the other dots and the subagent size", () => {
    render(<StateMark mark="working" small />);
    expect(mark().classList.contains("state")).toBe(true);
    expect(mark().classList.contains("state-small")).toBe(true);
  });

  it("draws an empty mark with no tooltip when there is no state", () => {
    render(<StateMark mark={null} />);
    expect(mark().getAttribute("data-mark")).toBe("none");
    expect(svg().children).toHaveLength(0);
    expect(mark().hasAttribute("title")).toBe(false);
  });

  it("tells an archive in progress, and prefers a given title", () => {
    render(<StateMark mark="archiving" />);
    expect(tip()).toBe("archiving");
    cleanup();
    render(<StateMark mark="failed" title="crashed" />);
    expect(tip()).toBe("crashed");
  });
});
