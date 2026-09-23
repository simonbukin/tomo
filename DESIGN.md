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
their own sake, no sparkles, no glow, no oversized cards, no rounded corners, no
pill for every word.

## The grid

Tomo is built on slab: a strict grid of square cells.

- The unit is `--u` (28 px). A row, a head, a button, a tab, and a status
  cell are one unit tall. A two-line row or a stat cell is `--u2` (56 px).
- Text sits `--inset` (14 px) in from the edge of its cell.
- Surfaces run full bleed and sit edge to edge. Rules divide them. There is
  no gutter between panes, cards, or columns.
- Each column starts with its own head row. The sidebar head, the center
  head, and the inspector head line up. The traffic lights sit in the first
  head row; `--traffic-inset` keeps text clear of them.
- A collapsed sidebar is one column of 28 px icon cells. Details go in the
  hover card, not next to the icon.

## Hierarchy

Build hierarchy with alignment, weight, contrast, and a 1 px rule. Add a
container only when those fail.

- Never put a card inside a card.
- A group of related values is a grid with aligned columns, not a box.
- One level of surface is usually enough. Give a row a background on hover,
  not a border and a shadow.

## Color

Slab is neutral ink on a neutral ground. Color carries status only.

- **Selection is inversion.** The selected tab, row, view, lens, menu item,
  and palette result take `--fg` as their background and `--bg` as their
  text. `--accent` is the same value as `--fg`; there is no brand hue.
- **Semantic state** is one vocabulary for the whole app: `--working`,
  `--waiting`, `--danger`, `--success`, plus the soft tints `--waiting-soft`
  and `--danger-soft`. The markers are small squares: filled for a live
  state, hollow for a quiet one. See `styles/base.css` and
  `app/src/glyphs.ts`.
- Do not invent a feature status color. If a feature needs a new state, add it
  to the shared vocabulary or map it onto an existing one.
- Every color is a token. `[theme]` in `config.toml` restyles the whole app,
  so a hard-coded color breaks a user's theme. See `docs/theming.md`.

Light and dark are one design with two palettes, `slab-light` and
`slab-dark`. Write local CSS against the tokens and it works in both.

## Shape

- Every corner is square. The radius tokens are 0 and stay 0.
- Rules are 1 px and drawn as inset box shadows, so they take no space and
  never push a row off the grid. Use `--line` for a quiet rule and
  `--line-strong` for a frame.
- A separator is an element of zero height with a rule, not a margin.
- Most UI is flat. Depth belongs to floating surfaces only: menu, popover,
  dialog, hover preview, toast. Those use `--shadow-pop` or `--shadow-dialog`,
  a 1 px ring and one drop shadow.

## Typography

Three faces, bundled in `app/src/assets/fonts/` under the SIL Open Font
License. Tomo looks the same offline and never flashes a fallback face.

- **Sofia Sans** (`--font-ui`) is the text face: navigation, labels,
  buttons, and body copy.
- **Sofia Sans Extra Condensed** (`--font-display`, the `.display` class) is
  the display face: a scope name, a greeting, a stat value. Set it heavy and
  in capitals, one or two units tall.
- **Red Hat Mono** (`--mono`) is the technical face: paths, branch names,
  tags, ports, ids, commands, timestamps, and numbers in tables.

Terminals do not use `--mono`. They keep the font that `[terminal]` sets in
`config.toml`.

- The scale is `--fs-0` 11 px, `--fs-1` 12 px, `--fs-2` 13 px (the body),
  `--fs-3` 14 px, and `--fs-4` 22 px for a stat value.
- Weight goes to 600 or 700 for a name, a head, or a title.
- Labels are lowercase. Numbers use tabular figures so columns line up.
- The wordmark is the word `tomo`. The mark is the locked smile in
  `app/src/brandFace.ts`. The splash in `app/index.html` draws the same smile
  and must stay.

## Density

Tomo is compact and information-rich. Do not add whitespace to look modern.

- Space inside a cell is `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16,
  `--sp-5` 24. Space between cells is a rule, not a gap.
- The sidebar worktree row is a fixed two units for three lines, whatever it
  holds.
- A line never wraps in a dense row. It cuts with an ellipsis.
- Too many tabs shrink from 140 px to 72 px, then the tab row scrolls.

## Motion

Motion confirms a change. It never entertains.

- One curve, `--ease-out` (`cubic-bezier(0.2, 0.8, 0.2, 1)`), and two
  speeds: `--dur-fast` 120 ms for hover and press, `--dur-open` 240 ms for
  open, arrival, and the selection block.
- The selection block glides. The tab bar, the sidebar views, and each
  segmented control hold one inverted `.glide` cell that `useGlide` in
  `app/src/glide.ts` moves to the selected item. It jumps into place when it
  first appears.
- Dialogs, the palette, and toasts rise 8 px as they fade in. Nothing scales.
- A view change is not animated. Reflow is: a lens change moves the rows
  that are already there, with `useFlip`. Do not animate the arrival of new
  rows.
- Animate `transform`, `translate`, and `opacity` only, plus the size of the
  selection block. This window is full of canvases that pay for layout.
- No springs, no bounce, no parallax. Under `prefers-reduced-motion` every
  duration is 0.

## Interaction

Base UI owns interaction. Tomo owns the design. Use the primitives in
`app/src/components/ui/` before you build a menu, dialog, popover, tooltip,
select, or button.

- Every control shows a 2 px ring in `--fg` on `:focus-visible`, drawn
  inside the cell so it never breaks the grid.
- Every icon-only control is an `IconButton` with a label. The label is the
  tooltip and the accessible name.
- A control keeps at least `--hit-min` (28 px) of clickable area, whatever it
  looks like.
- A drop zone is inverted: the target turns `--fg` and names the result.
- Resizing is free. The sidebars and the splits take any width the user
  drags to.
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
