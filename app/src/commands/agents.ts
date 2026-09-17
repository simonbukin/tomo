import { setUi } from "../store";
import type { Action } from "../actions";

export const commands: Action[] = [{ id: "agents", label: "Show agents", group: "Agents", run: () => setUi({ view: "agents" }) }];
