import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState, useStore } from "./store";
import type { Worktree } from "./types";

const wt = (id: string, name: string) => ({ id, name, repo_id: "r1", metadata: { state: null, tags: [], project: null, display_name: null } }) as unknown as Worktree;

const initial = getState();
beforeEach(() => setState({ ...initial, worktrees: [wt("w1", "alpha"), wt("w2", "beta")] }));

describe("useStore", () => {
  it("reads with the prop of this render, not the one the last render used", () => {
    const { result, rerender } = renderHook(({ id }) => useStore((s) => s.worktrees.find((w) => w.id === id)?.name), { initialProps: { id: "w1" } });
    expect(result.current).toBe("alpha");
    rerender({ id: "w2" });
    expect(result.current).toBe("beta");
  });

  it("keeps the same reference while the state does not change, so a fresh array is safe", () => {
    const names = (s: { worktrees: Worktree[] }) => s.worktrees.map((w) => w.name);
    const { result, rerender } = renderHook(() => useStore(names));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => setState({ worktrees: [wt("w1", "alpha"), wt("w2", "beta")] }));
    expect(result.current).toEqual(first);
  });

  it("follows the store", () => {
    const { result } = renderHook(() => useStore((s) => s.worktrees.length));
    expect(result.current).toBe(2);
    act(() => setState({ worktrees: [wt("w1", "alpha")] }));
    expect(result.current).toBe(1);
  });
});
