import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import towns from "./data/japan-towns.json";
import { activityEmptyText, homeEmpty, townsProgress } from "./emptyStates";
import { EmptyState } from "./states";
import { getState, setState, type State } from "./store";
import { ceremonyTier, chimeFor, prefersReducedMotion, revealDurationMs } from "./townCeremony";
import type { Tab, Town, TownUnlock, Worktree } from "./types";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), rpc: vi.fn(() => Promise.resolve([])) }));
vi.mock("./sounds", () => ({ playChime: vi.fn() }));

const { Activity } = await import("./Activity");
const { Home } = await import("./Home");
const { TownReveal } = await import("./TownReveal");
const { playChime } = await import("./sounds");
const { paneToRestore } = await import("./windowChrome");

const initial: State = getState();
const withMotion = (reduced: boolean) => (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;

beforeEach(() => setState(initial));
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
    setState({ unlocks: [unlock], townReveal: { unlock, nonce: 1 } });
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
    expect(getState().townReveal).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("empty states", () => {
  it("picks the Home empty state", () => {
    expect(homeEmpty(0, 0, 0)).toBe("no-repos");
    expect(homeEmpty(1, 0, 0)).toBe("no-worktrees");
    expect(homeEmpty(1, 3, 0)).toBe("no-matches");
    expect(homeEmpty(1, 0, 2)).toBeNull();
    expect(homeEmpty(1, 3, 3)).toBeNull();
  });

  it("uses short copy", () => {
    expect(activityEmptyText("needs_me")).toBe("Nothing needs you.");
    expect(townsProgress(0, 1681)).toBe("0 / 1681 municipalities unlocked.");
  });

  it("renders a title, a detail, and one action", () => {
    render(<EmptyState title="No active worktrees." detail="calm" action={<button>New worktree</button>} />);
    expect(screen.getByText("No active worktrees.")).toBeInTheDocument();
    expect(screen.getByText("calm")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New worktree" })).toBeInTheDocument();
  });

  it("Home with no repositories offers to add one", () => {
    setState({ loaded: true });
    render(<Home />);
    expect(screen.getByText("No repositories yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeInTheDocument();
  });

  it("Home with only archived worktrees says none are active", () => {
    const archived = { id: "w1", repo_id: "r1", path: "/r/w1", name: "w1", branch: "b", head: "h", detached: false, is_main: false, exists: false, git: null, metadata: { display_name: null, project: null, priority: null, tags: [], state: null }, last_active_ms: null, first_seen_ms: null, archived_at_ms: 5, archiving: false, town_slug: null, tab_count: 0, pane_count: 0 } as unknown as Worktree;
    setState({ loaded: true, repos: [{ id: "r1", path: "/r", name: "r", exists: true, remote_url: null, github: null }], worktrees: [archived] });
    render(<Home />);
    expect(screen.getByText("No active worktrees.")).toBeInTheDocument();
  });

  it("Activity shows a skeleton while it loads, then calm empty copy per filter", async () => {
    const user = userEvent.setup();
    render(<Activity />);
    expect(screen.getByRole("status", { name: "loading activity" })).toBeInTheDocument();
    expect(await screen.findByText("No activity yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Needs me" }));
    expect(screen.getByText("Nothing needs you.")).toBeInTheDocument();
  });
});

describe("window focus", () => {
  const tab = { id: "t1", worktree_id: "w1", title: "t", position: 0, layout: { type: "leaf", pane_id: "p1" }, active_pane_id: "p1", is_active: true } as unknown as Tab;
  const worktreeView = (): State => ({ ...initial, tabs: { w1: [tab] }, ui: { ...initial.ui, view: "worktree", activeWorktreeId: "w1" } });

  it("restores the active pane only when nothing else holds focus", () => {
    expect(paneToRestore(worktreeView(), document.body)).toBe("p1");
    expect(paneToRestore(worktreeView(), null)).toBe("p1");
    const input = document.createElement("input");
    expect(paneToRestore(worktreeView(), input)).toBeNull();
    expect(paneToRestore({ ...worktreeView(), paletteOpen: true }, document.body)).toBeNull();
    expect(paneToRestore(initial, document.body)).toBeNull();
  });
});
