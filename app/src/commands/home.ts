import { getState, setUi } from "../store";
import type { Action, CommandGroup } from "../actions";
import type { HomeScope } from "../types";

const GROUP: CommandGroup = "Navigation";

const show = (scope: HomeScope) => () => setUi({ view: "home", home: { ...getState().ui.home, scope } });

export const commands: Action[] = [{ id: "home_all_work", label: "Home: all work", group: GROUP, run: show({ kind: "all" }) }];
