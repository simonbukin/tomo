import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOX, face, faceFrom, faceSvg, TOMO, tomoSvg, type Seed } from "../src/brandFace.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "brand");
const SEEDS: Seed[] = Array.from({ length: 64 }, (_, i) => i + 1);

const WORDMARK_INNER = `  <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 3V11A2 2 0 0 0 5.5 13"/>
    <path d="M1 6H6"/>
    <circle cx="13.5" cy="9.5" r="3.5"/>
    <path d="M21 13V8.5A2.5 2.5 0 0 1 26 8.5V13"/>
    <path d="M26 8.5A2.5 2.5 0 0 1 31 8.5V13"/>
    <circle cx="38.5" cy="9.5" r="3.5"/>
  </g>`;

const wordmarkSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 43 16" width="43" height="16" role="img" aria-label="tomo">\n${WORDMARK_INNER}\n</svg>\n`;

const lockupSvg = () => {
  const f = faceFrom(TOMO);
  const paths = f.paths.map((d) => `<path d="${d}"/>`).join("");
  const dots = f.dots.map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 20" width="70" height="20" role="img" aria-label="tomo">
  <g transform="scale(0.2)">
    <g fill="none" stroke="currentColor" stroke-width="${f.stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
    <g fill="currentColor">${dots}</g>
  </g>
  <g transform="translate(27 2)">
${WORDMARK_INNER}
  </g>
</svg>
`;
};

const px = (units: number, size: number) => (units * size) / BOX;

const score = (seed: Seed) => {
  const f = face(seed, 16);
  const [left, right] = f.dots;
  const eye = px(2 * Math.min(left.r, right.r), 16);
  const gap = px(Math.hypot(right.cx - left.cx, right.cy - left.cy) - left.r - right.r, 16);
  const xs = f.mouth.map((p) => p.x);
  const ys = f.mouth.map((p) => p.y);
  const width = px(Math.max(...xs) - Math.min(...xs), 16);
  const depth = px(Math.max(...ys) - Math.min(...ys), 16);
  const clearance = px(
    Math.min(
      ...f.dots.slice(0, 2).flatMap((d) => f.mouth.map((p) => Math.hypot(p.x - d.cx, p.y - d.cy) - d.r - f.stroke / 2)),
    ),
    16,
  );
  const tent = (v: number, lo: number, hi: number) => (v < lo ? v / lo : v > hi ? Math.max(0, 1 - (v - hi) / 3) : 1);
  const total =
    1.5 * Math.min(depth / 6.5, 1) +
    1.2 * Math.min(clearance / 3.5, 1) +
    1 * Math.min(width / 12, 1) +
    0.8 * Math.min(eye / 2.8, 1) +
    0.5 * tent(gap, 4, 7);
  return { seed, eye, gap, width, depth, clearance, total };
};

const grid = (size: number, dark: boolean, labels: boolean) => {
  const cells = SEEDS.map(
    (seed) =>
      `<figure class="cell"><div class="ink">${faceSvg(seed, size)}</div>${labels ? `<figcaption>${seed}</figcaption>` : ""}</figure>`,
  ).join("");
  return `<div class="field ${dark ? "dark" : "light"}"><div class="grid">${cells}</div></div>`;
};

const wordmarkStrip = (seeds: Seed[], dark: boolean) => {
  const items = seeds
    .map(
      (seed) =>
        `<div class="lockup"><span class="ink">${faceSvg(seed, 20)}</span><span class="ink">${wordmarkSvg().replace(/ width="43" height="16"/, ' width="54" height="20"')}</span><span class="tag">${seed}</span></div>`,
    )
    .join("");
  return `<div class="field ${dark ? "dark" : "light"}"><div class="strip">${items}</div></div>`;
};

const titlebarStrip = (seeds: Seed[], dark: boolean) => {
  const items = seeds
    .map(
      (seed) =>
        `<div class="bar"><span class="tl tl-close"></span><span class="tl tl-min"></span><span class="tl tl-max"></span><span class="ink mark">${faceSvg(seed, 15)}</span><span class="bar-title">home</span><span class="tag">${seed}</span></div>`,
    )
    .join("");
  return `<div class="field ${dark ? "dark" : "light"}"><div class="bars">${items}</div></div>`;
};

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 64px; background: #f4f4f2; color: #16161a;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
h1 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 12px; font-weight: 600; margin: 40px 0 8px; }
p { max-width: 68ch; margin: 0 0 6px; color: #55555c; }
.q { color: #16161a; border-left: 2px solid #7d4dff; padding-left: 10px; margin: 16px 0 24px; }
.field { padding: 20px; border-radius: 6px; margin-bottom: 12px; }
.field.light { background: #ffffff; color: #111114; border: 1px solid #e2e2df; }
.field.dark { background: #121216; color: #ededf0; border: 1px solid #26262c; }
.grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 14px; justify-items: center; align-items: end; }
.cell { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
figcaption { font-size: 10px; opacity: 0.55; font-variant-numeric: tabular-nums; }
.ink { display: inline-flex; }
.ink svg { display: block; }
.strip { display: flex; flex-wrap: wrap; gap: 28px; align-items: center; }
.lockup { display: flex; align-items: center; gap: 8px; }
.bars { display: flex; flex-wrap: wrap; gap: 16px; }
.bar { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 6px;
  background: #ebebe8; border: 1px solid #dededa; }
.dark .bar { background: #1c1c21; border-color: #2c2c33; }
.tl { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex: none; }
.tl-close { background: #ff5f57; } .tl-min { background: #febc2e; } .tl-max { background: #28c840; margin-right: 6px; }
table { border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 2px 10px 2px 0; font-weight: 400; }
th { opacity: 0.55; }
.mark { margin-left: 4px; }
.bar-title { font-size: 11px; opacity: 0.6; }
.tag { font-size: 10px; opacity: 0.45; font-variant-numeric: tabular-nums; }
.note { font-size: 11px; color: #6a6a72; margin: 8px 0 16px; }
`;

const html = (shortlist: Seed[], ranked: ReturnType<typeof score>[]) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tomo smiles</title>
<style>${CSS}</style>
</head>
<body>
<h1>tomo — seeded smiles</h1>
<p>64 faces from the seeded generator in <code>app/src/brandFace.ts</code>. Flat monochrome, no fill, rounded caps.</p>
<p class="q">Which seeds still read as a face at 16 px, and which one should become the app icon?</p>
<p class="note">The same 64 seeds run in every grid, in the same order: seed 1 is top left, seed 64 is bottom right, left to right and top to bottom. A face below 24 px uses the small-size rule: a thicker stroke, wider eyes, and no extra mark. Compare a face against itself down the page.</p>

<h2>16 px — the size that decides the mark</h2>
${grid(16, false, false)}
${grid(16, true, false)}

<h2>32 px</h2>
${grid(32, false, false)}
${grid(32, true, false)}

<h2>128 px — with seeds</h2>
${grid(128, false, true)}
${grid(128, true, true)}

<h2>beside the wordmark</h2>
${wordmarkStrip(shortlist, false)}
${wordmarkStrip(shortlist, true)}

<h2>in a title bar — the mark at 15 px, traffic lights at 12 px</h2>
${titlebarStrip(shortlist, false)}
${titlebarStrip(shortlist, true)}

<h2>shortlist by geometry at 16 px</h2>
<p class="note">Nobody looked at these faces. The order comes from measured geometry at 16 px: eye diameter, the gap between the eyes, mouth width, mouth depth, and the clearance between an eye and the stroke. All values are px at 16 px.</p>
<div class="field light"><table>
<tr><th>seed</th><th>eye</th><th>gap</th><th>width</th><th>depth</th><th>clear</th><th>score</th></tr>
${ranked
  .slice(0, 16)
  .map(
    (r) =>
      `<tr><td>${r.seed}</td><td>${r.eye.toFixed(2)}</td><td>${r.gap.toFixed(2)}</td><td>${r.width.toFixed(2)}</td><td>${r.depth.toFixed(2)}</td><td>${r.clearance.toFixed(2)}</td><td>${r.total.toFixed(2)}</td></tr>`,
  )
  .join("\n")}
</table></div>
</body>
</html>
`;

const ranked = SEEDS.map(score).sort((a, b) => b.total - a.total);
const shortlist = ranked.slice(0, 8).map((r) => r.seed);
const CHOSEN = ranked.slice(0, 5).map((r) => r.seed);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "tomo-face.svg"), `${tomoSvg(128)}\n`);
for (const seed of CHOSEN) writeFileSync(join(OUT, `tomo-face-${seed}.svg`), `${faceSvg(seed, 128)}\n`);
writeFileSync(join(OUT, "tomo-wordmark.svg"), wordmarkSvg());
writeFileSync(join(OUT, "tomo-lockup.svg"), lockupSvg());
writeFileSync(join(OUT, "smiles.html"), html(shortlist, ranked));

console.log("seed\teye\tgap\twidth\tdepth\tclear\tscore");
for (const r of ranked) {
  console.log([r.seed, r.eye, r.gap, r.width, r.depth, r.clearance, r.total].map((v) => (typeof v === "number" ? v.toFixed(2) : v)).join("\t"));
}
console.log("shortlist", shortlist.join(","));
console.log("chosen", CHOSEN.join(","), "lockup tomo-face.svg");
