import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Town, TownUnlock } from "../../generated";
import towns from "./data/japan-towns.json";
import { ceremonyTier, chimeFor, prefersReducedMotion, revealDurationMs, townsProgress } from "./model";
import { applyTownFrame, getTownState, setTownState } from "./state";

vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), rpc: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../sounds", () => ({ playChime: vi.fn() }));

const { TownReveal } = await import("./TownReveal");
const { playChime } = await import("../../sounds");

const withMotion = (reduced: boolean) => (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;

beforeEach(() => setTownState({ unlocks: [], reveal: null }));
afterEach(() => {
  cleanup();
  vi.mocked(playChime).mockClear();
});

describe("town unlock ceremony", () => {
  it("scales with rarity", () => {
    expect(["common", "uncommon", "rare", "epic", "legendary"].map(ceremonyTier)).toEqual(["small", "small", "strong", "strong", "special"]);
    expect(ceremonyTier("unknown-tier")).toBe("small");
    expect([chimeFor("small"), chimeFor("strong"), chimeFor("special")]).toEqual([null, "rare", "legendary"]);
    expect(revealDurationMs("small")).toBeLessThan(revealDurationMs("strong"));
    expect(revealDurationMs("strong")).toBeLessThan(revealDurationMs("special"));
  });

  it("reads the reduced-motion preference and survives a broken matchMedia", () => {
    expect(prefersReducedMotion({ matchMedia: withMotion(true) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: withMotion(false) })).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => { throw new Error("no media"); } })).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });

  const reveal = async (town: Town, reduced: boolean) => {
    const original = window.matchMedia;
    window.matchMedia = withMotion(reduced);
    const unlock: TownUnlock = { slug: town.slug, worktree_id: "w", repo_id: "r", unlocked_at_ms: 1 };
    setTownState({ unlocks: [unlock], reveal: { unlock, nonce: 1 } });
    render(<TownReveal />);
    const status = await screen.findByRole("status");
    window.matchMedia = original;
    return status;
  };
  const first = (rarity: string) => (towns as Town[]).find((t) => t.rarity === rarity)!;

  it("gives a common town a small reveal with no sound", async () => {
    const status = await reveal(first("common"), false);
    expect(status).toHaveAttribute("data-tier", "small");
    expect(status).toHaveAttribute("data-motion", "full");
    expect(status).toHaveTextContent(`1 / ${towns.length}`);
    expect(playChime).not.toHaveBeenCalled();
  });

  it("gives a legendary town the special moment and its chime, and honors reduced motion", async () => {
    const status = await reveal(first("legendary"), true);
    expect(status).toHaveAttribute("data-tier", "special");
    expect(status).toHaveAttribute("data-motion", "reduced");
    expect(playChime).toHaveBeenCalledWith("legendary");
  });

  it("dismisses on Escape", async () => {
    await reveal(first("rare"), false);
    expect(playChime).toHaveBeenCalledWith("rare");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(getTownState().reveal).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("town state", () => {
  it("keeps one unlock per slug and restarts the reveal for each event", () => {
    const unlock: TownUnlock = { slug: "aogashima", worktree_id: "w", repo_id: "r", unlocked_at_ms: 1 };
    applyTownFrame({ seq: 1, event: "town_unlocked", data: { unlock } });
    applyTownFrame({ seq: 2, event: "town_unlocked", data: { unlock } });
    applyTownFrame({ seq: 3, event: "worktrees_changed", data: { worktrees: [] } });
    expect(getTownState().unlocks).toEqual([unlock]);
    expect(getTownState().reveal).toEqual({ unlock, nonce: 2 });
  });

  it("counts the collection in short copy", () => {
    expect(townsProgress(0, 1681)).toBe("0 / 1681 municipalities unlocked.");
  });
});
