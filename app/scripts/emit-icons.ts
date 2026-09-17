import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOX, faceFrom, TOMO } from "../src/brandFace.ts";

const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "brand", "icon-src");

const INK = "#141414";
const PAPER = "#fbfaf8";

const face = (ink: string) => {
  const f = faceFrom(TOMO);
  const paths = f.paths.map((d) => `<path d="${d}"/>`).join("");
  const dots = f.dots.map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}"/>`).join("");
  return `<g fill="none" stroke="${ink}" stroke-width="${f.stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</g><g fill="${ink}">${dots}</g>`;
};

const placed = (canvas: number, width: number, ink: string) => {
  const offset = (canvas - width) / 2;
  return `<g transform="translate(${offset} ${offset}) scale(${width / BOX})">${face(ink)}</g>`;
};

const open = (canvas: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">`;

const squircle = (canvas: number) => {
  const margin = canvas * (100 / 1024);
  const side = canvas - margin * 2;
  const radius = side * 0.2246;
  return `${open(canvas)}<rect x="${margin}" y="${margin}" width="${side}" height="${side}" rx="${radius}" ry="${radius}" fill="${INK}"/>${placed(canvas, side * 0.66, PAPER)}</svg>`;
};

const fullBleed = (canvas: number) =>
  `${open(canvas)}<rect width="${canvas}" height="${canvas}" fill="${INK}"/>${placed(canvas, canvas * 0.6, PAPER)}</svg>`;

const round = (canvas: number) =>
  `${open(canvas)}<circle cx="${canvas / 2}" cy="${canvas / 2}" r="${canvas / 2}" fill="${INK}"/>${placed(canvas, canvas * 0.56, PAPER)}</svg>`;

const foreground = (canvas: number) => `${open(canvas)}${placed(canvas, canvas * 0.4, PAPER)}</svg>`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "squircle.svg"), squircle(1024));
writeFileSync(join(OUT, "fullbleed.svg"), fullBleed(1024));
writeFileSync(join(OUT, "round.svg"), round(1024));
writeFileSync(join(OUT, "foreground.svg"), foreground(1024));
console.log("icon sources written to", OUT);
