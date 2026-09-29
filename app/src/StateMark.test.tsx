import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StateMark } from "./StateMark";

afterEach(cleanup);

const mark = () => document.querySelector(".mx");

describe("the dot matrix mark", () => {
  it("draws nine cells and names its state for the styles", () => {
    render(<StateMark mark="needs" />);
    expect(mark()?.children).toHaveLength(9);
    expect(mark()?.getAttribute("data-mark")).toBe("needs");
    expect(mark()?.getAttribute("title")).toBe("needs you");
  });

  it("keeps the layout class of the other dots and the subagent size", () => {
    render(<StateMark mark="working" small />);
    expect(mark()?.classList.contains("state")).toBe(true);
    expect(mark()?.classList.contains("state-small")).toBe(true);
  });

  it("draws an empty mark with no tooltip when there is no state", () => {
    render(<StateMark mark={null} />);
    expect(mark()?.getAttribute("data-mark")).toBe("none");
    expect(mark()?.hasAttribute("title")).toBe(false);
  });

  it("tells an archive in progress, and prefers a given title", () => {
    render(<StateMark mark="archiving" />);
    expect(mark()?.getAttribute("title")).toBe("archiving");
    cleanup();
    render(<StateMark mark="failed" title="crashed" />);
    expect(mark()?.getAttribute("title")).toBe("crashed");
  });
});
