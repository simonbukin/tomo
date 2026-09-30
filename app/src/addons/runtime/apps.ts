import type { RuntimeEndpoint } from "../../generated";
import type { AppRow } from "../../appsModel";
import type { State } from "../../store";
import type { Id } from "../../types";
import type { AppLine } from "../types";
import { byRank, endpointLabel, endpointSummary, endpointUrl, httpEndpoints } from "./model";
import { endpointsOf } from "./state";

/**
 * The daemon already labels a discovered port with the source of its pane, so a
 * row carries that label without this addon naming the addon that made it.
 */
const row = (e: RuntimeEndpoint): AppRow => ({
  id: e.id,
  worktreeId: e.worktree_id,
  paneId: e.pane_id,
  label: endpointLabel(e),
  url: endpointUrl(e),
  port: e.port,
  detail: [endpointSummary(e), e.process === endpointLabel(e) ? null : e.process].filter(Boolean).join(" · "),
  source: e.source ? { kind: e.source.kind, id: e.source.id } : null,
});

/** Every port this addon found, as rows for the Apps view. A port that serves no page stays out, because every row action opens a page. */
export const apps = (s: State): AppRow[] => Object.values(s.endpoints ?? {}).flatMap((list) => httpEndpoints(list).map(row));

/** A line for each HTTP port of a worktree on its row, pages first: the name and the port, and in the hover card the address and the uptime. */
export const appLines = (s: State, worktreeId: Id): AppLine[] =>
  httpEndpoints(byRank(endpointsOf(s, worktreeId))).map((e) => ({ id: e.id, mark: "working", label: endpointLabel(e), detail: `:${e.port}`, full: endpointUrl(e), upSinceMs: e.discovered_at_ms }));
