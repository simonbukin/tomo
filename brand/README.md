# tomo marks — the smile

The mark is a hand-drawn smiley face. One arc makes the mouth. Two dots make
the eyes. The stroke is loose, the caps are round, and there is no fill. The
face is never twice the same, because a seed draws it.

`tomo` stays the wordmark, lowercase, with no descriptor. The wordmark and the
layout hold the restraint. The face holds the warmth.

## The generator

The generator lives in `app/src/brandFace.ts`. The app renders it through
`Mark` in `app/src/Brand.tsx`.

```tsx
<Mark size={15} />            // the default seed, "tomo"
<Mark size={128} seed={15} /> // one face from the gallery
```

`face(seed, size)` is pure. A seed goes in and a face comes out. It reads no
clock, no `Math.random`, and no state. The same seed always gives the same
face, in the app, in a test, and after a restart. A seed is a string or a
number. The default seed is `"tomo"`.

The generator picks every value from the seed, then it draws. It varies:

- the mouth width and the mouth depth, from a shallow dish to a deep U;
- the lean of the curve and the height of each end, so the face is asymmetric;
- a wobble on each of the five points that shape the arc;
- the stroke weight, from a hairline to a heavy line;
- a small flick where the stroke starts or ends;
- the eye spacing, the eye size, and the size difference between the two eyes;
- the eye height above the mouth;
- one extra mark for about one seed in four: a short tick, or a second dot
  inside the curve.

The face is then fit into a 100 unit box with a small off-centre nudge. The
stroke weight does not scale with the fit, so a heavy face stays heavy.

## The small size rule

Below 24 px a hairline arc and two 1 px dots turn to mush. Under that
threshold the generator clamps the face:

- the stroke goes to 7 to 9 units, which is 1.1 to 1.4 px at 16 px;
- the eyes go to 5.6 units or more, and the difference between them narrows;
- the eye gap, the mouth width, and the mouth depth each get a floor;
- the flicks and the extra mark are dropped.

The parameters come from the seed before the clamp, so a face at 16 px is the
same face as at 128 px. Only the weight changes. `app/src/brandFace.test.ts`
holds the threshold, the clamps, and the box bounds.

## The gallery

Open `brand/smiles.html` in a browser. It is self-contained: no network, no
font files. It shows 64 faces in three 8 × 8 grids, at 16 px, 32 px, and
128 px, on a light field and a dark field. The 16 px grid comes first, because
16 px decides the mark.

The same 64 seeds run in every grid, in the same order. Seed 1 is top left and
seed 64 is bottom right. The seeds print under the 128 px grid. The page also
shows a shortlist beside the wordmark, and in a mock title bar with traffic
lights.

The page asks one question: which seeds still read as a face at 16 px, and
which one should become the app icon?

## How to pick a seed

Look at the 16 px grid first. Find a face that is still a face. Then find the
same square in the 128 px grid and read its seed. Check the seed in the title
bar strip, because that is where the mark lives today.

The gallery ranks the seeds by measured geometry at 16 px: eye diameter, the
gap between the eyes, the mouth width, the mouth depth, and the clearance
between an eye and the stroke. The rank is a filter, not a judgement. A human
eye decides.

## How to regenerate

```bash
node app/scripts/emit-brand.ts
```

Node 23.6 or later runs the script directly, because it strips the types. The
script writes every file in
this directory and prints the ranked table. It picks the five best seeds by
the geometry score, so the output is reproducible.

```text
brand/
  smiles.html          the gallery, 64 seeds at three sizes
  tomo-face-15.svg     the five chosen faces
  tomo-face-1.svg
  tomo-face-25.svg
  tomo-face-47.svg
  tomo-face-14.svg
  tomo-wordmark.svg    lowercase tomo, plain and quiet
  tomo-lockup.svg      face and wordmark
  rejected/            the three abstract marks
```

## Why the abstract marks went

`rejected/` holds `tomo-mark-a.svg`, `tomo-mark-b.svg`, `tomo-mark-c.svg`, and
the old `comparison.html`.

A was an abstract lowercase `t`. It had to compete with every other lowercase
`t`, and its accent square read as dirt at 16 px. B was a folded tab. It was
the calmest of the three at 16 px, but it read as a macOS folder. C was two
companion pieces with a 2 px gap. The whole idea sat in that gap, and the gap
closed at 16 px.

All three were correct and cold. None of them was warm, and none of them was
tomo. The smile is.

## What a human still must check

Nobody has looked at these faces. Every claim about 16 px comes from the
geometry and the measured values, not from an eye. Open `smiles.html` and
judge the faces on a real screen.
