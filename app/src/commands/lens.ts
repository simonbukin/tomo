import { LENSES, LENS_LABEL } from "../lenses";
import { setUi } from "../store";
import type { Action } from "../actions";

export const commands: Action[] = LENSES.map((lens) => ({
  id: `lens_${lens}`,
  label: `Group sidebar by ${LENS_LABEL[lens]}`,
  group: "Navigation",
  run: () => setUi({ lens }),
}));
