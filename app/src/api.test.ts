import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { invoke } = await import("@tauri-apps/api/core");
const { RpcFailure, rpcParsed } = await import("./api");
const { processInfoSchema, gitSummarySchema } = await import("./generated/schemas");

const reply = (value: unknown) => vi.mocked(invoke).mockResolvedValue(value);

const process = { pid: 4, ppid: null, name: "node", cmd: "node x", cwd: null, cpu_percent: 1.5, rss_bytes: 10, start_time_s: 0, worktree_id: null, pane_id: null, ownership: "owned", depth: 0 };

describe("rpcParsed", () => {
  it("returns the reply when it matches the shape the daemon promises", async () => {
    reply([process]);
    await expect(rpcParsed("ps", z.array(processInfoSchema))).resolves.toEqual([process]);
  });

  it("refuses a reply of the wrong kind instead of handing it to a caller", async () => {
    reply({ not: "a list" });
    await expect(rpcParsed("ps", z.array(processInfoSchema))).rejects.toBeInstanceOf(RpcFailure);
    reply(null);
    await expect(rpcParsed("ps", z.array(processInfoSchema))).rejects.toMatchObject({ code: "malformed" });
  });

  it("names the field that did not match, so the drift is findable", async () => {
    reply([{ ...process, rss_bytes: "10" }]);
    await expect(rpcParsed("ps", z.array(processInfoSchema))).rejects.toThrow(/ps replied with an unexpected shape at 0\.rss_bytes/);
  });

  it("refuses a reply that is missing a field the type requires", async () => {
    const { dirty: _dirty, ...withoutDirty } = { branch: "main", head: "abc", detached: false, dirty: true, files_changed: 0, untracked: 0, conflicts: 0, insertions: 0, deletions: 0, ahead: null, behind: null, upstream: null };
    reply(withoutDirty);
    await expect(rpcParsed("git_summary", gitSummarySchema)).rejects.toMatchObject({ code: "malformed" });
  });
});
