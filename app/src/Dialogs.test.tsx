import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo, Worktree, WorktreePrefill } from "./types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./api", async (importOriginal) => {
  const { aWorktree } = await import("./test-fixtures");
  const replies: Record<string, unknown> = {
    branch_list: [
      { name: "feat/local", remote: null, upstream: null, committed_at_ms: 3000 },
      { name: "feat/remote-only", remote: "origin", upstream: null, committed_at_ms: 2000 },
      { name: "main", remote: null, upstream: "origin/main", committed_at_ms: 1000 },
    ],
    worktree_create: aWorktree({ id: "w9" }),
  };
  return (await import("./test-api")).mockApi(await importOriginal<typeof import("./api")>(), vi.fn((method: string) => Promise.resolve(replies[method] ?? null)));
});
vi.mock("./actions", async (importOriginal) => ({ ...(await importOriginal<typeof import("./actions")>()), openWorktree: vi.fn() }));
const nameField = vi.hoisted(() => ({ current: null as null | (() => null) }));
vi.mock("./addons", async (importOriginal) => ({ ...(await importOriginal<typeof import("./addons")>()), worktreeNameField: () => nameField.current }));

const { Dialogs, defaultRepoId } = await import("./Dialogs");
const { rpc } = await import("./api");
const { getState, setState } = await import("./store");

const repo = { id: "r1", name: "tomo", path: "/src/tomo", exists: true, worktree_parent: "/wt", branch_prefix: "you/" } as unknown as Repo;
const initial = getState();

const branchBox = () => screen.getByLabelText("Branch");
const optionNames = () => screen.queryAllByRole("option").map((o) => o.querySelector(".combobox-item-text")?.textContent);
const created = () => vi.mocked(rpc).mock.calls.find(([method]) => method === "worktree_create")?.[1] as Record<string, unknown> | undefined;

async function openDialog(prefill: WorktreePrefill = { repoId: "r1" }) {
  const user = userEvent.setup();
  render(<Dialogs />);
  setState({ dialog: { kind: "create-worktree", ...prefill } });
  await waitFor(() => expect(vi.mocked(rpc).mock.calls.some(([method]) => method === "branch_list")).toBe(true));
  return user;
}

beforeEach(() => {
  vi.mocked(rpc).mockClear();
  setState({ ...initial, loaded: true, repos: [repo] });
});
afterEach(cleanup);

describe("default repository", () => {
  const repos = [{ id: "tomo" }, { id: "acme" }] as Repo[];
  const wt = (id: string, repo_id: string, archived_at_ms: number | null = null) => ({ id, repo_id, archived_at_ms }) as unknown as Worktree;
  const worktrees = [wt("a", "acme"), wt("b", "acme"), wt("c", "tomo"), wt("d", "tomo", 1), wt("e", "tomo", 2)];

  it("uses the open worktree's repository", () => {
    expect(defaultRepoId(repos, worktrees, "c")).toBe("tomo");
  });

  it("otherwise uses the repository with the most live worktrees, not the first one added", () => {
    expect(defaultRepoId(repos, worktrees, null)).toBe("acme");
    expect(defaultRepoId(repos, [], null)).toBe("tomo");
    expect(defaultRepoId([], worktrees, null)).toBe("");
  });
});

describe("new worktree dialog", () => {
  it("filters the branch list while the user types", async () => {
    const user = await openDialog();
    await user.type(branchBox(), "remote");
    await waitFor(() => expect(optionNames()).toEqual(["feat/remote-only"]));
  });

  it("creates from a pasted name that no branch matches", async () => {
    const user = await openDialog();
    await user.type(branchBox(), "feat/from-a-pull-request");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(created()).toMatchObject({ branch: "feat/from-a-pull-request", new_branch: true, start_ref: null }));
  });

  it("picking a branch that exists turns create this branch off", async () => {
    const user = await openDialog();
    await user.type(branchBox(), "feat/loc");
    await user.click(await screen.findByText("feat/local"));
    expect(screen.getByLabelText("create this branch")).not.toBeChecked();
  });

  it("picking a remote branch keeps create on and starts from the remote", async () => {
    const user = await openDialog();
    await user.type(branchBox(), "feat/remote-only");
    await user.click(await screen.findByText("feat/remote-only"));
    expect(screen.getByLabelText("create this branch")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(created()).toMatchObject({ branch: "feat/remote-only", new_branch: true, start_ref: "origin/feat/remote-only" }));
  });

  it("with a name field, an empty branch box shows the default name and still creates", async () => {
    nameField.current = () => null;
    const user = await openDialog();
    expect(branchBox()).toHaveAttribute("placeholder", "you/<name>");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(created()).toMatchObject({ branch: "", new_branch: true }));
    expect(created()?.metadata).toBeUndefined();
    nameField.current = null;
  });

  it("without a name field, Create waits for a branch or a path", async () => {
    const user = await openDialog();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await user.type(branchBox(), "feat/x");
    expect(screen.getByRole("button", { name: "Create", hidden: true })).toBeEnabled();
  });

  it("a plus on a tag group starts with that tag and sends it", async () => {
    const user = await openDialog({ tags: ["labor-relations"] });
    expect(screen.getByLabelText("Repository")).toHaveValue("r1");
    expect(screen.getByLabelText("Tags (comma-separated)")).toHaveValue("labor-relations");
    await user.type(branchBox(), "feat/loc");
    await user.click(await screen.findByText("feat/local"));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(created()).toMatchObject({ repo_id: "r1", metadata: { tags: ["labor-relations"] } }));
  });

  it("sends clean tags", async () => {
    const user = await openDialog();
    await user.type(screen.getByLabelText("Tags (comma-separated)"), "#a, b,, a");
    await user.type(branchBox(), "feat/loc");
    await user.click(await screen.findByText("feat/local"));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(created()?.metadata).toEqual({ tags: ["a", "b"] }));
  });
});
