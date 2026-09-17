import type { Action } from "../actions";
import { setState } from "../store";

export function openDiagnostics(): void {
  setState({ dialog: { kind: "diagnostics" } });
}

export const commands: Action[] = [{ id: "diagnostics", label: "Diagnostics...", group: "General", run: openDiagnostics }];
