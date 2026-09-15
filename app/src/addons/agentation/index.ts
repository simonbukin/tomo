import type { Addon } from "../types";
import { AgentationToolbar } from "./Toolbar";

/** Agentation: annotate a page in a browser pane and send the notes to an agent of its worktree. */
export const agentation: Addon = {
  id: "agentation",
  browserToolbar: AgentationToolbar,
};
