import { Minus, Plus } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { allActions, applyZoom } from "./actions";
import { rpc } from "./api";
import { openConfigFile, setConfig } from "./commands/settings";
import { Button, DialogActions, DialogTitle, IconButton, Select } from "./components/ui";
import { describeBinding } from "./keys";
import { bindingFromEvent, SETTINGS_SECTIONS, splitList, type SettingsSection } from "./settingsModel";
import { notify, setState, useStore } from "./store";
import { ACCENT_PRESETS, BASE_THEMES, THEME_LABELS, TOKENS, useResolvedTheme, type AccentPreset, type ThemeName, type Token } from "./theme";
import type { Config, ConfigIssue, IntegrationStatus, Status } from "./types";

/** Settings reads and writes config.toml through the daemon; only zoom stays in UI state. */
export function Settings({ close, section }: { close: () => void; section?: SettingsSection }) {
  const [active, setActive] = useState<SettingsSection>(section ?? "appearance");
  const config = useStore((s) => s.config);
  return (
    <>
      <DialogTitle>settings</DialogTitle>
      <ConfigFile config={config} />
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s} className="settings-tab" aria-current={active === s ? "page" : undefined} onClick={() => setActive(s)}>
              {s}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {!config && <div className="faint">loading…</div>}
          {config && active === "appearance" && <AppearanceSection config={config} />}
          {config && active === "terminal" && <TerminalSection config={config} />}
          {config && active === "keyboard" && <KeyboardSection config={config} />}
          {config && active === "agents" && <AgentsSection config={config} />}
          {config && active === "notifications" && <NotificationsSection config={config} />}
          {config && active === "archive" && <ArchiveSection config={config} />}
          {config && active === "integrations" && <IntegrationsSection config={config} />}
        </div>
      </div>
      <DialogActions>
        <Button onClick={close}>Done</Button>
      </DialogActions>
    </>
  );
}

function ConfigFile({ config }: { config: Config | null }) {
  const [path, setPath] = useState<string | null>(null);
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  useEffect(() => {
    rpc<Status>("status")
      .then((s) => setPath(`${s.data_dir}/config.toml`))
      .catch(() => setPath(null));
  }, []);
  useEffect(() => {
    rpc<ConfigIssue[]>("config_check")
      .then(setIssues)
      .catch(() => setIssues([]));
  }, [config]);
  return (
    <div className="settings-file">
      <span className="faint">configuration</span>
      <span className="mono settings-path" title={path ?? undefined}>
        {path ?? "config.toml"}
      </span>
      {issues.length > 0 && (
        <Button variant="link" onClick={() => setState({ dialog: { kind: "config-check" } })}>
          {issues.length} {issues.length === 1 ? "issue" : "issues"}
        </Button>
      )}
      <Button size="sm" onClick={openConfigFile}>
        open file
      </Button>
    </div>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <>
      <label>{label}</label>
      <div className="settings-control">{children}</div>
      {note && <div className="settings-note">{note}</div>}
    </>
  );
}

function TextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return <input className="mono" aria-label={label} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

function Stepper({ label, value, min, max, unit = "", onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (next: number) => void }) {
  return (
    <span className="stepper">
      <IconButton label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Minus className="icon" />
      </IconButton>
      <span className="value">
        {value}
        {unit}
      </span>
      <IconButton label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Plus className="icon" />
      </IconButton>
    </span>
  );
}

function ColorField({ token, value, overridden }: { token: Token; value: string; overridden: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => setConfig(`theme.${token}`, draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);
  return (
    <div className={`token${overridden ? " overridden" : ""}`}>
      <input type="color" aria-label={token} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <span className="mono">{token}</span>
      {overridden && (
        <Button variant="link" onClick={() => setConfig(`theme.${token}`, null)}>
          reset
        </Button>
      )}
    </div>
  );
}

function AppearanceSection({ config }: { config: Config }) {
  const theme = config.theme;
  const resolved = useResolvedTheme();
  const zoom = useStore((s) => s.ui.appearance.zoom);
  const names = (["system", ...BASE_THEMES] as ThemeName[]).map((value) => ({ value, label: THEME_LABELS[value] }));
  const bases = BASE_THEMES.map((value) => ({ value, label: THEME_LABELS[value] }));
  const accent = theme.colors.accent ?? "murasaki";
  return (
    <div className="settings-grid">
      <Row label="theme">
        <Select<ThemeName> aria-label="Theme" size="sm" value={theme.name as ThemeName} onValueChange={(v) => setConfig("theme.name", v)} options={names} />
      </Row>
      {theme.name === "system" && (
        <>
          <Row label="light theme">
            <Select aria-label="Light theme" size="sm" value={theme.light as (typeof BASE_THEMES)[number]} onValueChange={(v) => setConfig("theme.light", v)} options={bases} />
          </Row>
          <Row label="dark theme" note="system follows the macOS appearance">
            <Select aria-label="Dark theme" size="sm" value={theme.dark as (typeof BASE_THEMES)[number]} onValueChange={(v) => setConfig("theme.dark", v)} options={bases} />
          </Row>
        </>
      )}
      <Row label="accent">
        <span className="swatches">
          {(Object.keys(ACCENT_PRESETS) as AccentPreset[]).map((id) => (
            <button key={id} className="swatch" aria-pressed={accent === id} onClick={() => setConfig("theme.accent", id === "murasaki" ? null : id)}>
              <span className="swatch-dot" style={{ background: ACCENT_PRESETS[id][resolved.scheme] }} />
              {id}
            </button>
          ))}
        </span>
      </Row>
      <Row label="colors" note="a color here overrides the base theme in [theme]">
        <div className="token-grid">
          {TOKENS.map((t) => (
            <ColorField key={t} token={t} value={resolved.palette[t]} overridden={t in theme.colors} />
          ))}
        </div>
      </Row>
      <Row label="zoom" note="⌘ + and ⌘ − zoom the window; ⌘ 0 resets. zoom is per window, not in config.toml">
        <span className="stepper">
          <IconButton label="Zoom out" onClick={() => applyZoom("out")}>
            <Minus className="icon" />
          </IconButton>
          <span className="value">{Math.round(zoom * 100)}%</span>
          <IconButton label="Zoom in" onClick={() => applyZoom("in")}>
            <Plus className="icon" />
          </IconButton>
          {zoom !== 1 && (
            <Button variant="link" onClick={() => applyZoom("reset")}>
              reset
            </Button>
          )}
        </span>
      </Row>
    </div>
  );
}

function TerminalSection({ config }: { config: Config }) {
  const whole = (key: string, label: string) => (text: string) => {
    const n = Number(text.trim());
    if (Number.isInteger(n) && n >= 0) setConfig(key, n);
    else notify("error", `${label} must be a whole number`);
  };
  return (
    <div className="settings-grid">
      <Row label="font family">
        <TextField label="Terminal font family" value={config.font_family} onCommit={(v) => setConfig("terminal.font_family", v.trim() || null)} />
      </Row>
      <Row label="font size">
        <Stepper label="terminal font size" value={config.font_size} min={6} max={72} unit="px" onChange={(v) => setConfig("terminal.font_size", v)} />
      </Row>
      <Row label="scrollback" note="lines kept per terminal">
        <TextField label="Scrollback lines" value={String(config.scrollback_lines)} onCommit={whole("scrollback_lines", "scrollback")} />
      </Row>
      <Row label="shell" note="new terminals use this shell">
        <TextField label="Shell" value={config.shell} onCommit={(v) => setConfig("shell", v.trim() || null)} />
      </Row>
    </div>
  );
}

function KeyboardSection({ config }: { config: Config }) {
  const labels = Object.fromEntries(allActions().map((a) => [a.id, a.label]));
  return (
    <div className="settings-keys">
      <div className="settings-note">click a shortcut, then press the new keys. reset returns to the default.</div>
      {Object.entries(config.keybindings).map(([id, binding]) => (
        <KeyRow key={id} id={id} label={labels[id] ?? id} binding={binding} />
      ))}
    </div>
  );
}

function KeyRow({ id, label, binding }: { id: string; label: string; binding: string }) {
  const [recording, setRecording] = useState(false);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    const next = bindingFromEvent(e.nativeEvent);
    if (!next) return;
    setRecording(false);
    if (next !== binding) setConfig(`keybindings.${id}`, next);
  };
  return (
    <div className="settings-key">
      <span className="name">{label}</span>
      <button className={`key-capture${recording ? " recording" : ""}`} aria-label={`Shortcut for ${label}`} onClick={() => setRecording(true)} onBlur={() => setRecording(false)} onKeyDown={onKeyDown}>
        {recording ? "press keys…" : describeBinding(binding)}
      </button>
      <Button variant="link" onClick={() => setConfig(`keybindings.${id}`, null)}>
        reset
      </Button>
    </div>
  );
}

function AgentsSection({ config }: { config: Config }) {
  const saveArgs = async (name: string, command: string, text: string) => {
    if (await setConfig(`agents.${name}.command`, command)) setConfig(`agents.${name}.args`, splitList(text, /\s+/));
  };
  return (
    <div className="settings-grid">
      {Object.entries(config.agents).map(([name, agent]) => (
        <Fragment key={name}>
          <Row label={name}>
            <div className="settings-pair">
              <TextField label={`${name} command`} value={agent.command} onCommit={(v) => (v.trim() ? setConfig(`agents.${name}.command`, v.trim()) : notify("error", "the command can not be empty"))} />
              <TextField label={`${name} arguments`} value={agent.args.join(" ")} placeholder="arguments" onCommit={(v) => saveArgs(name, agent.command, v)} />
              <Button variant="link" onClick={() => setConfig(`agents.${name}`, null)}>
                reset
              </Button>
            </div>
          </Row>
        </Fragment>
      ))}
      <div className="settings-note">arguments are separated by spaces</div>
    </div>
  );
}

function NotificationsSection({ config }: { config: Config }) {
  const n = config.notifications;
  return (
    <div className="settings-stack">
      <label className="check">
        <input type="checkbox" checked={n.desktop} onChange={(e) => setConfig("notifications.desktop", e.target.checked)} /> desktop notifications while tomo is in the background
      </label>
      <label className="check">
        <input type="checkbox" checked={n.sounds} onChange={(e) => setConfig("notifications.sounds", e.target.checked)} /> sounds for human checkpoints and rare town unlocks
      </label>
    </div>
  );
}

function ArchiveSection({ config }: { config: Config }) {
  return (
    <div className="settings-grid">
      <Row label="cleanup" note="folders that archive deletes from the worktree root, separated by commas">
        <div className="settings-pair">
          <TextField label="Archive cleanup" value={config.archive_cleanup.join(", ")} onCommit={(v) => setConfig("archive.cleanup", splitList(v, /[\s,]+/))} />
          <Button variant="link" onClick={() => setConfig("archive.cleanup", null)}>
            reset
          </Button>
        </div>
      </Row>
    </div>
  );
}

function IntegrationsSection({ config }: { config: Config }) {
  return (
    <div className="settings-stack">
      <div className="settings-grid">
        <Row label="editor" note="{path} is replaced with the file or folder">
          <TextField label="Editor command" value={config.editor_command.join(" ")} onCommit={(v) => setConfig("editor_command", splitList(v, /\s+/))} />
        </Row>
      </div>
      <IntegrationStatusList />
    </div>
  );
}

/** Agent hook status with an install button. Also used by the integration status dialog. */
export function IntegrationStatusList() {
  const [items, setItems] = useState<IntegrationStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    rpc<IntegrationStatus[]>("integrations_status")
      .then(setItems)
      .catch((e) => {
        notify("error", (e as Error).message);
        setItems([]);
      });
  useEffect(() => {
    load();
  }, []);
  const install = async () => {
    setBusy(true);
    try {
      await rpc("integrations_install");
      notify("info", "hooks installed");
      await load();
    } catch (e) {
      notify("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="dialog-list">
        {items === null && <div className="faint">checking…</div>}
        {items?.map((i) => (
          <div key={i.kind} className="dialog-row" title={i.binary ?? "binary not found"}>
            <span className={`state state-${i.level}`} />
            <span className="name">{i.kind}</span>
            <span className="detail">
              {i.level.replace("_", " ")}
              {i.reason ? ` · ${i.reason}` : ""}
              {i.lifecycle ? "" : " · no lifecycle"}
              {i.resume ? "" : " · no resume"}
            </span>
          </div>
        ))}
      </div>
      <div>
        <Button size="sm" disabled={busy} onClick={install}>
          {busy ? "installing…" : "install hooks"}
        </Button>
      </div>
    </>
  );
}
