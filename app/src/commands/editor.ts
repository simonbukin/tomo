import { focusedPaneId, type Action } from "../actions";
import { openPalette } from "../Palette";
import { getState } from "../store";

const focusedEditor = (): string | null => {
  const id = focusedPaneId();
  return id && getState().panes[id]?.kind === "editor" ? id : null;
};

function saveFocused(): void {
  const id = focusedEditor();
  if (id) void import("../editor/cm").then((m) => m.save(id));
}

export const commands: Action[] = [
  { id: "open_file", label: "Open file...", group: "Editor", whenWorktree: true, run: () => openPalette("files") },
  { id: "editor_save", label: "Save file", group: "Editor", whenWorktree: true, when: () => !!focusedEditor(), run: () => saveFocused() },
];
