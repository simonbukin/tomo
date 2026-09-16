import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  rpc: vi.fn(() =>
    Promise.resolve([
      { worktree_id: "w2", name: "beta", archived_at_ms: 1_700_000_300_000 },
      { worktree_id: "w1", name: "alpha", archived_at_ms: 1_700_000_100_000 },
    ]),
  ),
}));

const { rpc } = await import("../../api");
const Chart = (await import("./Chart")).default;
const { animeChart } = await import("./index");
const { getState, setUi } = await import("../../store");

afterEach(() => {
  cleanup();
  setUi({ view: "home" });
});

describe("anime chart", () => {
  it("lists each archived worktree in the order that the daemon gives", async () => {
    render(<Chart />);
    expect(await screen.findByText("beta")).toBeTruthy();
    const rows = document.querySelectorAll(".activity-row .activity-text");
    expect([...rows].map((r) => r.textContent)).toEqual(["beta", "alpha"]);
    expect(vi.mocked(rpc).mock.calls[0][0]).toBe("anime_chart_list");
  });

  it("says so while no worktree is archived", async () => {
    vi.mocked(rpc).mockResolvedValueOnce([]);
    render(<Chart />);
    expect(await screen.findByText("no archived worktrees yet")).toBeTruthy();
  });

  it("opens the view with its command", () => {
    animeChart.commands?.[0].run();
    expect(getState().ui.view).toBe("anime-chart");
  });
});
