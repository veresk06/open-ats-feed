#!/usr/bin/env python3
"""Render the Apify Store listing icon for open-ats-jobs-feed.

The icon is a register, not a symbol: three tally columns, one per vendor,
with cell counts proportional to the measured live-board roster. The top cell
of each column is the signal colour — boards that appeared since the last run,
which is the thing this Actor sells that a scraper cannot claim.

Proportions are the real numbers, normalised to a 12-cell tallest column:
    Greenhouse 5,506 -> 12    Ashby 3,153 -> 7    Lever 1,538 -> 3

Usage: uv run --with pillow scripts/make-icon.py docs/icon.png
"""

import sys
from PIL import Image, ImageDraw

# Palette. Deep petrol ground so the card reads against Apify's white grid;
# one warm accent only.
GROUND = (15, 34, 49)     # #0F2231
BASE = (44, 67, 86)       # #2C4356 - baseline rule
CELL = (205, 219, 226)    # #CDDBE2 - vellum
SIGNAL = (245, 197, 24)   # #F5C518 - newly live boards

SIZE = 512
SS = 4  # supersample factor; edges are the whole job at 64px
PAD = 84
COLUMNS = (12, 7, 3)  # Greenhouse, Ashby, Lever
GAP_X = 28
GAP_Y = 6


def render(size: int = SIZE) -> Image.Image:
    s = size * SS
    img = Image.new("RGB", (s, s), GROUND)
    d = ImageDraw.Draw(img)

    pad = PAD * SS
    box = s - 2 * pad
    tallest = max(COLUMNS)

    col_w = (box - GAP_X * SS * (len(COLUMNS) - 1)) // len(COLUMNS)
    cell_h = (box - GAP_Y * SS * (tallest - 1)) // tallest
    radius = 3 * SS

    bottom = s - pad

    # Baseline rule: seats the columns so they read as measured, not floating.
    d.rounded_rectangle(
        [pad, bottom + 5 * SS, s - pad, bottom + 9 * SS],
        radius=2 * SS,
        fill=BASE,
    )

    for i, count in enumerate(COLUMNS):
        x0 = pad + i * (col_w + GAP_X * SS)
        for j in range(count):
            y1 = bottom - j * (cell_h + GAP_Y * SS)
            y0 = y1 - cell_h
            # Top cell of every column carries the signal colour.
            fill = SIGNAL if j == count - 1 else CELL
            d.rounded_rectangle([x0, y0, x0 + col_w, y1], radius=radius, fill=fill)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "docs/icon.png"
    render().save(out, "PNG", optimize=True)
    print(f"wrote {out}")
