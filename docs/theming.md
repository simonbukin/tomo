# Theming and settings

Tomo reads its theme and terminal font from `config.toml` in the data dir
(`~/Library/Application Support/tomo/config.toml` on macOS). The Settings
view and the file edit the same values.

## Source of truth

- `config.toml` holds the theme, the color overrides, the
  terminal font, keybindings, agents, notifications, hooks, and the editor
  command.
- The Settings view writes to `config.toml` through the daemon call
  `config_set`. The daemon edits the file in place with `toml_edit`, so
  comments, key order, and formatting stay as they are.
- UI state keeps only the window zoom. Old UI state values for theme,
  accent, and terminal font size are ignored. Put them in `config.toml` if
  you want them back.
- The daemon watches `config.toml`. When the file changes on disk, the daemon
  reloads it and sends `config_changed`. The app applies the theme and the
  font at once. No restart is necessary.

## Example

```toml
[theme]
name = "system"      # system | slab-dark | slab-light
light = "slab-light" # used when name = "system" and macOS is light
dark = "slab-dark"   # used when name = "system" and macOS is dark

# Every color key is optional. A key overrides the base theme.
# These are the slab-dark values.
bg = "#0e0e0e"
surface = "#151515"
surface_hover = "#1d1d1d"
fg = "#ecebe8"
fg_muted = "#9d9c97"
fg_faint = "#6d6c68"
border = "#2a2a2a"
border_strong = "#3a3a3a"
accent = "#ecebe8"   # the selection color; slab uses the text color
accent_soft = "#292929"
working = "#7fd28a"
waiting = "#e8b14c"
danger = "#ff7a66"
success = "#7fd28a"

[terminal]
font_family = "CommitMono, Menlo, monospace"
font_size = 13           # 6 to 72
```

Theme names ignore case, spaces, and underscores, so `"Slab Dark"` is the
same as `slab-dark`. Older names still work: `dark`, `murasaki-dark`, and
`ink` mean `slab-dark`; `light`, `murasaki-light`, and `paper` mean
`slab-light`. Top-level `font_family` and `font_size` apply when
`[terminal]` does not set them.

When you set `accent` and not `accent_soft`, Tomo mixes the soft tint from
the accent and `bg`. The accent presets (`murasaki`, `sora`, `sakura`,
`sumi`) are gone. A preset name gives a warning and Tomo ignores it.

## Built-in themes

| Name         | Scheme | Notes                                  |
|--------------|--------|----------------------------------------|
| `slab-light` | light  | ink on a warm grey ground              |
| `slab-dark`  | dark   | light ink on a near-black ground       |
| `system`     | either | follows the macOS appearance live, with `light` and `dark` |

## Bad values

A bad value never stops Tomo. Each problem shows in `tomo config check` and
in the Settings header, and Tomo uses the fallback:

- an unknown theme name uses the default (`system` with the slab themes);
- a color that is not `#rgb` or `#rrggbb` is ignored and the base color
  stays;
- an unknown key in `[theme]` or `[terminal]` is a warning and is ignored;
- a `font_size` outside 6 to 72 uses the older key or 13;
- a file that does not parse uses all defaults. `config_set` refuses to edit
  such a file, so fix it by hand first.

`config_set` also refuses a value that has the wrong type for its key (for
example `keybindings.home = 5`), an unknown top-level key, and a value in
place of a table. A refused write does not change the file.

## Tokens

The 14 color keys map one to one onto CSS custom properties on `:root`:
`surface_hover` becomes `--surface-hover`. `app/src/theme.ts` holds the
built-in palettes and `resolveTheme`, which merges the base theme and the
overrides. `applyTheme` sets the variables and
`data-theme="light|dark"`. The xterm theme comes from the same resolved
palette.

Feature CSS reads these tokens and writes no color, no typeface, and no
duration of its own. A theme change therefore reaches every surface, and
`[theme]` stays the one theming surface. `app/src/WorktreeRow.css` is the
example that a unit test enforces. See [ui.md](ui.md).

`app/src/styles/tokens.css` holds the slab values for the first paint
and derives the short names (`--bg-1`, `--fg-2`, `--line`, `--line-strong`,
and so on) from the tokens. A custom stylesheet later only has to set the
tokens on `:root`. A unit test makes sure that the first-paint values in
`tokens.css` agree with the slab palettes in `theme.ts`.

## Settings view

Open it with ⌘, (`settings` in `[keybindings]`), the gear in the bottom
strip, or `Settings…` in the palette. Sections:

- **appearance**: theme, light and dark theme for `system`, color
  overrides, and zoom (UI state).
- **terminal**: font family, font size, scrollback lines, shell.
- **keyboard**: every binding in `[keybindings]`. Click a shortcut and press
  the new keys. A binding must use ⌘, ⌃, or ⌥ (or an F key). `reset` removes
  the key so the default applies.
- **agents**: command and arguments for each agent. Arguments are separated
  by spaces.
- **notifications**: `[notifications] desktop` and `sounds`.
- **integrations**: `editor_command` and the agent hook status.

The header shows the config path, the number of config issues, and
`open file`. `open file` calls `config_open`, which opens the file with
`editor_command`, or with `open -t` when that fails.

Palette commands: `Settings…`, `Open config file`, and `Theme: <name>` for
each theme.

## Daemon calls

| Call          | Params                         | Result |
|---------------|--------------------------------|--------|
| `config_set`  | `key` (dotted, e.g. `theme.accent`), `value` (JSON; `null` removes the key) | the reloaded `Config` |
| `config_open` | none                           | null   |

Event: `config_changed { config }` after a write or a change on disk.
`scripts/torture/config.sh` covers both calls and the file watcher.
