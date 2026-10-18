#!/usr/bin/env python3
"""Build one contact sheet per set for the rerank visual review.

Six panels in two rows, so the pair and the ground truth are in one image and a
grader never has to hold two files in their head:

    BOX ART        | PRIMARY  iso | PRIMARY  front
    facts/decision | ALTERNATE iso| ALTERNATE front

Every sheet is <= 1999 px on both axes (the Anthropic image limit) by
construction: three 600 px columns and two 503 px rows plus label strips.

    python scripts/_rerank-visual-sheet.py [--only 31199,75222]
"""
from __future__ import annotations

import argparse
import json
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'output' / 'rerank-visual-2026-09-20'
JOBS = Path('C:/git/clego/geograde/_rerank_visual_jobs.json')

PANEL_W, PANEL_H = 600, 503          # 960x804 render, scaled by 0.625
LABEL_H = 24
PAD = 6
BG = (18, 18, 22)
FG = (232, 232, 236)
DIM = (150, 150, 158)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ('consola.ttf', 'arial.ttf', 'DejaVuSansMono.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_LABEL = _font(15)
F_TEXT = _font(15)
F_TITLE = _font(19)


def _fit(path: Path, w: int, h: int) -> Image.Image:
    """`path` letterboxed into a w x h dark panel (never upscaled past 2x)."""
    panel = Image.new('RGB', (w, h), (28, 28, 34))
    if not path.exists():
        d = ImageDraw.Draw(panel)
        d.text((10, h // 2), f'missing: {path.name}', font=F_TEXT, fill=(220, 90, 90))
        return panel
    im = Image.open(path).convert('RGB')
    im.thumbnail((w, h), Image.LANCZOS)
    panel.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
    return panel


def _labelled(path: Path, w: int, h: int, text: str) -> Image.Image:
    out = Image.new('RGB', (w, h + LABEL_H), BG)
    out.paste(_fit(path, w, h), (0, LABEL_H))
    ImageDraw.Draw(out).text((4, 4), text[:78], font=F_LABEL, fill=FG)
    return out


def _facts(job: dict, rec: dict | None, w: int, h: int) -> Image.Image:
    """The numbers the grader needs beside the pictures, as a panel."""
    panel = Image.new('RGB', (w, h), (24, 24, 29))
    d = ImageDraw.Draw(panel)
    y = 8
    d.text((8, y), f"{job['set']}  {job['name'][:34]}", font=F_TITLE, fill=FG)
    y += 28
    rp = (rec or {}).get('primary') or {}
    ra = (rec or {}).get('alt') or {}
    lines = [
        f"catalogue inventory: {job['parts']} parts",
        '',
        f"PRIMARY  {job['primary_src']}",
        f"  {job['primary_path'][:52]}",
        f"  index n={job['primary_n']}  rendered={rp.get('placements')}"
        f"  missing={rp.get('missing')}",
        f"  geograde sev {job['sev_from']}",
        f"  defects: {'; '.join(job['from_defects'])[:110]}",
        '',
        f"ALTERNATE  {job['alt_src']}",
        f"  {job['alt_path'][:52]}",
        f"  index n={job['alt_n']}  rendered={ra.get('placements')}"
        f"  missing={ra.get('missing')}",
        f"  geograde sev {job['sev_to']}   retention {job['retention']}",
        '',
        f"flag: {job['why'][:100]}",
    ]
    for ln in lines:
        for wrapped in (textwrap.wrap(ln, 52, subsequent_indent='    ') or ['']):
            d.text((8, y), wrapped, font=F_TEXT,
                   fill=FG if wrapped[:1] not in (' ', '') else DIM)
            y += 18
    return panel


def sheet(job: dict) -> Path | None:
    d = OUT / job['set']
    rec = None
    if (d / 'render.json').exists():
        rec = json.loads((d / 'render.json').read_text(encoding='utf-8'))
    cols, rows = 3, 2
    w = cols * PANEL_W + (cols + 1) * PAD
    h = rows * (PANEL_H + LABEL_H) + (rows + 1) * PAD
    out = Image.new('RGB', (w, h), BG)
    cells = [
        (0, 0, _labelled(d / 'box.jpg', PANEL_W, PANEL_H, 'BOX ART (ground truth)')),
        (1, 0, _labelled(d / 'primary-v1.png', PANEL_W, PANEL_H,
                         f"PRIMARY iso — {job['primary_path'][:52]}")),
        (2, 0, _labelled(d / 'primary-v2.png', PANEL_W, PANEL_H, 'PRIMARY front')),
        (1, 1, _labelled(d / 'alt-v1.png', PANEL_W, PANEL_H,
                         f"ALTERNATE iso — {job['alt_path'][:52]}")),
        (2, 1, _labelled(d / 'alt-v2.png', PANEL_W, PANEL_H, 'ALTERNATE front')),
    ]
    for cx, cy, im in cells:
        out.paste(im, (PAD + cx * (PANEL_W + PAD), PAD + cy * (PANEL_H + LABEL_H + PAD)))
    out.paste(_facts(job, rec, PANEL_W, PANEL_H + LABEL_H),
              (PAD, PAD + 1 * (PANEL_H + LABEL_H + PAD)))
    p = d / 'sheet.png'
    out.save(p, optimize=True)
    assert out.width < 2000 and out.height < 2000, (out.width, out.height)
    return p


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    only = {s for s in args.only.split(',') if s}
    jobs = json.loads(JOBS.read_text(encoding='utf-8'))
    n = 0
    for job in jobs:
        if only and job['set'] not in only:
            continue
        d = OUT / job['set']
        # render.json is written only after BOTH candidates captured, so it is
        # the only safe "this set is finished" signal while the run is live —
        # keying on a PNG builds a half-empty sheet mid-flight.
        if not (d / 'render.json').exists():
            print(f'  skip {job["set"]} — not rendered yet')
            continue
        p = sheet(job)
        n += 1
        print(f'  {p} ({Path(p).stat().st_size // 1024} kB)')
    print(f'{n} sheet(s)')


if __name__ == '__main__':
    main()
