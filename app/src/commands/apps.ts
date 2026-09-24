import { appsAvailable } from "../addons";
import { setUi } from "../store";
import type { Action } from "../actions";

export const commands: Action[] = appsAvailable() ? [{ id: "apps", label: "Show apps", group: "Navigation", run: () => setUi({ view: "apps" }) }] : [];
