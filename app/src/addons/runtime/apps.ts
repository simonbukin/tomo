import type { RuntimeEndpoint } from "../../generated";
import type { AppRow } from "../../appsModel";
import type { State } from "../../store";
import { endpointLabel, endpointUrl, httpEndpoints } from "./model";

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
  detail: e.process === endpointLabel(e) ? null : e.process,
  source: e.source ? { kind: e.source.kind, id: e.source.id } : null,
});

/** Every port this addon found, as rows for the Apps view. A port that serves no page stays out, because every row action opens a page. */
export const apps = (s: State): AppRow[] => Object.values(s.endpoints ?? {}).flatMap((list) => httpEndpoints(list).map(row));
