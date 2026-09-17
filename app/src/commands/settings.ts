import type { Action } from "../actions";
import { rpc } from "../api";
import type { SettingsSection } from "../settingsModel";
import { failToast, setState, showStatus } from "../store";
import { BASE_THEMES, THEME_LABELS, type ThemeName } from "../theme";
import type { Config } from "../types";

export function openSettings(section?: SettingsSection): void {
  setState({ dialog: { kind: "settings", section } });
}

/** Writes one dotted key to config.toml through the daemon. `null` removes the key so the default applies. */
export async function setConfig(key: string, value: unknown): Promise<boolean> {
  try {
    setState({ config: await rpc<Config>("config_set", { key, value }) });
    return true;
  } catch (e) {
    failToast("Setting not saved")(e);
    return false;
  }
}

export function openConfigFile(): void {
  rpc("config_open").catch(failToast("Could not open the config file"));
}

export const commands: Action[] = [
  { id: "settings", label: "Settings...", group: "General", run: () => openSettings() },
  { id: "open_config", label: "Open config file", group: "General", run: openConfigFile },
  ...(["system", ...BASE_THEMES] as ThemeName[]).map((name) => ({ id: `theme_${name}`, label: `Theme: ${THEME_LABELS[name]}`, group: "General" as const, run: () => void setConfig("theme.name", name).then((ok) => ok && showStatus("Theme changed")) })),
];
