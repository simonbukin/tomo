import { navigate } from "../motion";
import { configSchema } from "../schemas";
import type { Action } from "../actions";
import { rpc, rpcParsed } from "../api";
import { failToast, setState, showStatus } from "../store";
import { BASE_THEMES, THEME_LABELS, type ThemeName } from "../theme";

export function openSettings(): void {
  navigate({ view: "settings" });
}

/** Writes one dotted key to config.toml through the daemon. `null` removes the key so the default applies. */
export async function setConfig(key: string, value: unknown): Promise<boolean> {
  try {
    setState({ config: await rpcParsed("config_set", configSchema, { key, value }) });
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
