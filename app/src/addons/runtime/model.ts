import type { AddonSignal } from "../../activityModel";
import type { RuntimeEndpoint } from "../../generated";
import type { State } from "../../store";
import type { Id } from "../../types";
import type { SourceKey } from "../types";
import { endpointsOf } from "./state";

export const SIGNAL_CLASS = "signal-runtime";

export const endpointUrl = (e: RuntimeEndpoint): string => `${e.protocol === "tcp" ? "http" : e.protocol}://${e.host}:${e.port}`;

export const httpEndpoints = (list: RuntimeEndpoint[]): RuntimeEndpoint[] => list.filter((e) => e.protocol !== "tcp");

/** True when `HEAD /` answered below 400: the port serves a page, not only an API or a 404 such as a devtools server. */
export const servesPage = (e: RuntimeEndpoint): boolean => e.protocol !== "tcp" && (e.status == null || e.status < 400);

const rank = (e: RuntimeEndpoint): number => (servesPage(e) ? 0 : e.protocol !== "tcp" ? 1 : 2);

/** The endpoints of one worktree as people want them: pages first, then other HTTP, then plain TCP, each by port. */
export const byRank = (list: RuntimeEndpoint[]): RuntimeEndpoint[] => [...list].sort((a, b) => rank(a) - rank(b) || a.port - b.port);

/** The same words as `RuntimeEndpoint::summary` in the daemon: `page 200`, `http 404`, `checking`, or `tcp`. */
export function endpointSummary(e: RuntimeEndpoint): string {
  if (e.protocol === "tcp") return e.probing ? "checking" : "tcp";
  if (e.status == null) return "http";
  return `${e.status < 400 ? "page" : "http"} ${e.status}`;
}

/** The daemon labels an endpoint with the source of its pane. */
export const endpointLabel = (e: RuntimeEndpoint): string => e.label ?? e.process;

export const ofSource = (list: RuntimeEndpoint[], source: SourceKey): RuntimeEndpoint[] => list.filter((e) => e.source?.kind === source.kind && e.source.id === source.id);

/** The best HTTP endpoint of a worktree, a page before a 404: the NOW signal, and the "Open App" link of an item without a URL. */
export const primaryEndpoint = (s: State, worktreeId: Id): RuntimeEndpoint | null => httpEndpoints(byRank(endpointsOf(s, worktreeId)))[0] ?? null;

export function appUrl(s: State, worktreeId: Id): string | null {
  const e = primaryEndpoint(s, worktreeId);
  return e ? endpointUrl(e) : null;
}

export function runtimeSignals(s: State, worktreeId: Id): AddonSignal[] {
  const e = primaryEndpoint(s, worktreeId);
  return e ? [{ kind: "addon", text: `${endpointLabel(e)} :${e.port}`, glyph: "", className: SIGNAL_CLASS, dot: "", beforeWarn: true }] : [];
}
