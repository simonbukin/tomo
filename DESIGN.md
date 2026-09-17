# Design

Tomo should feel like a very good Japanese stationery company made a developer
tool.

That means careful, restrained, tactile, and useful. It does not mean
superficially Japanese. There is no kanji as ornament, no paper texture in
routine UI, no red circle, and no stamps. The influence is structural:
proportion, alignment, small marks, label-like metadata, and neat separators.

Tomo is quiet, precise, warm, tactile, small, technical, useful, and lightly
playful. Tomo is not an AI startup, a SaaS dashboard, cyberpunk, a gaming UI,
an enterprise suite, an IDE clone, or a productivity cult. No gradients for
their own sake, no sparkles, no glow, no oversized cards, no giant radii, no
pill for every word.

## Hierarchy

Build hierarchy with alignment, spacing, type weight, contrast, a subtle
background, and a thin border. Add a container only when those fail.

- Never put a card inside a card.
- A group of related values is a grid with aligned columns, not a box.
- One level of surface is usually enough. Give a row a background on hover,
  not a border and a shadow.

## Color

Most of Tomo is neutral. Color carries meaning, not decoration.

- **Accent** (`--accent`, a restrained purple) marks identity, selection,
  active state, and focus. Never paint a large area with it.
- **Semantic state** is one vocabulary for the whole app: `--working`,
  `--waiting`, `--danger`, `--success`, plus the soft tints `--waiting-soft`
  and `--danger-soft`. The dots and the glyphs are in `styles/base.css` and
  `app/src/glyphs.ts`.
- Do not invent a feature status color. If a feature needs a new state, add it
  to the shared vocabulary or map it onto an existing one.
- Every color is a token. `[theme]` in `config.toml` restyles the whole app,
  so a hard-coded color breaks a user's theme. See `docs/theming.md`.

Light and dark are one design with two palettes, not two designs. Write local
CSS against the tokens and it works in both.

## Shape

- Radius: `--radius-sm` (3 px) for a small chip or a key cap, `--radius`
  (4 px) for a control, `--radius-md` (6 px) for a floating surface.
- Borders are 1 px and quiet (`--line`), or 1 px and clear (`--line-strong`).
- Most UI is flat. Depth belongs to floating surfaces only: menu, popover,
  dialog, hover preview, toast. Those use `--shadow-pop` or `--shadow-dialog`.

## Typography

Two faces. Do not add a third.

- **Hiragino Sans** (`--font-ui`) is the human face: navigation, headings,
  labels, buttons, body copy, and Japanese text. It ships with macOS.
- **Commit Mono** (`--mono`) is the technical face: paths, branch names,
  ports, ids, commands, timestamps, and code.

Neither font is bundled. Tomo does not ship font files and does not depend on
one at startup. Each token falls back on its own: `--font-ui` to
`-apple-system` and `system-ui`, `--mono` to `ui-monospace` and `SF Mono`. A
machine without Commit Mono gets a clean monospace and loses nothing but the
preferred shape.

- Use mono where machine-ness helps hierarchy. Do not push every piece of
  metadata into mono.
- The scale is four sizes: `--fs-0` 11 px, `--fs-1` 12 px, `--fs-2` 13 px
  (the body), `--fs-3` 14 px. A bigger size needs a reason.
- Weight goes to 500 or 600 for a name or a title. Nothing is bold for
  emphasis alone.
- Labels are lowercase. Numbers use tabular figures so columns line up.
- The wordmark is the word `tomo`, set in `--font-ui` at weight 700. The mark
  is the locked smile in `app/src/brandFace.ts`. There is no third brand
  object, and no font file for branding.

## Spacing and density

Tomo is compact and information-rich. Do not add whitespace to look modern.

- Space is `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24.
- Dense rows are 22 to 30 px high. The sidebar worktree row is a fixed 42 px
  for two lines, whatever it holds.
- A line never wraps in a dense row. It cuts with an ellipsis.

## Motion

Motion confirms a change. It never entertains.

- Three durations: `--dur-fast` 80 ms (press, small state), `--dur-hover`
  100 ms (hover and close), `--dur-open` 140 ms (open and arrival).
- Two curves: `--ease-out` for hover, press, and open; `--ease-in` for close.
- No springs, no bounce, no parallax. Under `prefers-reduced-motion` every
  duration is 0 and the press scale is 1.

## Interaction

Base UI owns interaction. Tomo owns the design. Use the primitives in
`app/src/components/ui/` before you build a menu, dialog, popover, tooltip,
select, or button.

- Every control shows a 2 px accent focus ring on `:focus-visible`.
- Every icon-only control is an `IconButton` with a label. The label is the
  tooltip and the accessible name.
- A control keeps at least `--hit-min` (24 px) of clickable area, whatever it
  looks like.
- Keyboard behavior comes from the command registry. See `docs/keyboard.md`.

## Where styles live

```text
DESIGN.md                    this file
app/src/styles/tokens.css    every token, in groups
app/src/styles/base.css      reset, body, text, selection, focus, status dots
app/src/styles/ui.css        the shared primitives
app/src/<feature>.css        one feature, beside its component
```

Plain CSS with a feature namespace: `.wt-*`, `.towns-*`, `.browser-*`,
`.activity-*`, `.rail-*`. No CSS Modules, no Tailwind, no CSS-in-JS, no token
compiler. A class name greps, and the inspector names the file.

## Local freedom

**A local surface may be designed freely.** Reuse the shared tokens and
primitives when they help. Do not contort a design merely to avoid writing
local CSS.

**If a local decision proves broadly useful, promote it** into a shared token,
a primitive, or this document. Promote only when it clearly repeats; two uses
are a coincidence, four are a pattern.

The design system exists to make a new surface easy, not to make every
surface the same.

**Tomo is a good default, not a rigid design system.** Every rule here is a
starting point that works, not a law.

**Agents are allowed to change the design.** Restyle a surface, replace a
token value, rewrite a feature CSS file, or propose a new direction in this
document. Keep accessibility, focus behavior, and the semantic state meanings.
Change the rest when you have a reason.

## Three degrees of freedom

**Core UI** — the sidebar (`Sidebar.tsx`, `styles/sidebar.css`,
`WorktreeRow.css`), Home (`Home.tsx`, `styles/home.css`), Activity
(`Activity.tsx`, `styles/activity.css`), the bottom strip
(`shell/BottomStrip.tsx`, `styles/bottom.css`), and Settings (`Settings.tsx`,
`styles/ui.css`). Neutral, dense, restrained. Shared tokens and standard
primitives only.

**Expressive addons** — Towns (`addons/towns/`, `towns.css`) is the example.
An addon may use a custom layout, stronger local color, SVG, custom motion,
and an unusual type size where it earns it. It must keep accessibility, focus
behavior, the base typefaces unless it overrides them on purpose, and the
semantic state meanings.

**Ceremonial moments** — a rare Town unlock (`.town-reveal` in `towns.css`,
with its own local `--dur-reveal`). A ceremony may break the normal density
and motion rules. Keep them rare, or they stop being a ceremony.

## Exemplars

Read one of these before you design something similar.

```text
dense navigation   app/src/Sidebar.tsx + app/src/WorktreeRow.css
floating UI        app/src/components/ui/menu.tsx, popover.tsx + styles/ui.css
shell chrome       app/src/shell/BottomStrip.tsx + styles/bottom.css, styles/layout.css
dense feed         app/src/Activity.tsx + styles/activity.css
playful exception  app/src/addons/towns/Towns.tsx + towns.css
```

## Agent workflow

1. Read this file.
2. Read the component you change.
3. Read its local CSS.
4. Read one exemplar if you need it.
5. Implement locally first.
6. Promote a rule globally only when it clearly repeats.
7. Run the UI.
8. Look at what you made.
9. Fix the obvious inconsistency before you finish.

Do not load every style file into context. Four files are usually enough.

## Visual review

Agents should look at what they made.

When you can run the UI, capture the normal state, the hover and focus states
where they matter, a narrow window, light and dark, and the empty or error
state. Reuse the tooling the repo already has. No snapshot platform is
necessary.

When you cannot run the UI, say so and prove what you can. The built CSS and
the token values show the computed colors, sizes, and durations. A rendered
SVG at real size shows a mark. Then name the claims that still need a human
eye, for example contrast on a real screen, the feel of a motion, and
alignment at a small window width. Do not report a visual claim you did not
check.

## Copy

Brief, plain, specific, warm, slightly dry. `Claude finished.` `App crashed.`
`New terminal`. Not `Claude has successfully completed execution.` Lowercase
labels. No hype, and no excessive anthropomorphism.
