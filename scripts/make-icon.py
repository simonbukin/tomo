#!/usr/bin/env python3
"""Render the Tomo app icon (dark tile, pixel t, Murasaki square) to app/icon.png."""
from PIL import Image, ImageDraw
import sys, pathlib

SIZE = 1024
DARK = (15, 15, 18, 255)
WHITE = (255, 255, 255, 255)
MURASAKI = (125, 77, 255, 255)

# Glyph on a 3.5 x 4 unit grid: (x0, y0, x1, y1, color)
GLYPH = [
    (0.75, 0.0, 1.75, 3.5, WHITE),   # stem
    (0.0, 1.0, 2.5, 2.0, WHITE),     # crossbar
    (1.25, 3.0, 3.25, 4.0, WHITE),   # foot
    (2.5, 0.0, 3.5, 1.0, MURASAKI),  # square
]


def render(size: int, tile: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if tile:
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.225), fill=DARK)
    unit = size * 0.115
    ox = (size - 3.5 * unit) / 2
    oy = (size - 4.0 * unit) / 2
    r = unit * 0.09
    for x0, y0, x1, y1, color in GLYPH:
        d.rounded_rectangle((ox + x0 * unit, oy + y0 * unit, ox + x1 * unit, oy + y1 * unit), radius=r, fill=color)
    for x0, y0, x1, y1, color in GLYPH:
        if color == WHITE:
            d.rectangle((ox + x0 * unit + r, oy + y0 * unit + r, ox + x1 * unit - r, oy + y1 * unit - r), fill=color)
    return img


out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "app/icon.png")
render(SIZE, True).save(out)
render(SIZE, False).save(out.with_name("mark.png"))
print(out, out.with_name("mark.png"))
