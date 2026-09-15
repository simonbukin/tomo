import type { MenuItem } from "../../components/ui";
import type { RuntimeEndpoint } from "../../generated";
import type { PaletteEntry } from "../../paletteModel";
import { getState, type State } from "../../store";
import type { Id, Worktree } from "../../types";
import { sourceOwner } from "../index";
import type { SourceKey, SourceMenu } from "../types";
import { endpointLabel, endpointUrl, httpEndpoints, ofSource } from "./model";
import { endpointsOf } from "./state";

const sep: MenuItem = { separator: true };

// The store loads this module through addons/index.ts, and actions.ts loads the store: a lazy import keeps that cycle out of module start.
const withActions = (run: (a: typeof import("../../actions")) => unknown) => () => void import("../../actions").then(run);

export const openIn = (worktreeId: Id, url: string) => withActions((a) => a.openEndpoint(url, worktreeId));

function copyMenu(entries: [what: string, value: string | null, label: string][]): MenuItem {
  const items = entries.flatMap(([what, value, label]): MenuItem[] => (value ? [{ label, run: withActions((a) => a.copyText(value, what)) }] : []));
  return { label: "copy", disabled: items.length === 0, submenu: items };
}

export function endpointMenu(worktreeId: Id, e: RuntimeEndpoint, s: State = getState()): MenuItem[] {
  const url = e.protocol === "tcp" ? null : endpointUrl(e);
  const pane = e.pane_id ? s.panes[e.pane_id] : undefined;
  const source = e.source;
  const owner = source ? sourceOwner(source.kind) : null;
  const ownerItems: MenuItem[] = owner && source ? [{ label: "restart", run: () => owner.restart(worktreeId, source.id) }, { label: "stop", danger: true, run: () => owner.stop(worktreeId, source.id) }] : [];
  return [
    { label: "open", disabled: !url, run: () => url && openIn(worktreeId, url)() },
    { label: "focus logs", disabled: !pane, run: withActions((a) => pane && a.focusPane(pane.id)) },
    ...ownerItems,
    sep,
    copyMenu([
      ["URL", url, "url"],
      ["Port", String(e.port), "port"],
    ]),
  ];
}

/** Open and copy for the HTTP endpoints of one pane source, for the menu of its owner. */
export function sourceItems(worktreeId: Id, source: SourceKey, s: State): SourceMenu {
  const open = httpEndpoints(ofSource(endpointsOf(s, worktreeId), source));
  const at = (name: string, e: RuntimeEndpoint) => (open.length > 1 ? `${name} :${e.port}` : name);
  return {
    first: open.map((e) => ({ label: at("open", e), run: openIn(worktreeId, endpointUrl(e)) })),
    last: open.length ? [copyMenu(open.flatMap((e): [string, string, string][] => [["URL", endpointUrl(e), at("url", e)], ["Port", String(e.port), at("port", e)]]))] : [],
  };
}

/** The HTTP endpoints that no pane source owns, at the top of the overflow menu. */
export function looseItems(w: Worktree, s: State): MenuItem[] {
  const loose = httpEndpoints(endpointsOf(s, w.id)).filter((e) => !e.source);
  return loose.length ? [{ label: "runtime", disabled: true }, ...loose.map((e) => ({ label: `open :${e.port} · ${e.process}`, run: openIn(w.id, endpointUrl(e)) }))] : [];
}

export function paletteEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  return httpEndpoints(endpointsOf(s, w.id)).map((e) => ({
    key: `endpoint:${w.id}:${e.port}`,
    label: `open ${endpointLabel(e)} :${e.port}`,
    hint: `${w.name} · runtime`,
    context,
    run: openIn(w.id, endpointUrl(e)),
  }));
}
