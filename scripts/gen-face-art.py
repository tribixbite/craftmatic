#!/usr/bin/env python3
"""
Face ART for heads no LDraw library prints: a decal PNG per head, cut from the
BrickLink catalogue photo of that exact print.

A converted source keeps such a head as the plain mould and names its print on
the line before it, `0 !CRAFTMATIC HEAD_PRINT 3626pb3484` (written by the
converters from `ldd-print-map.json`'s `n:` rows). With this art seeded (`bun scripts/_playable_ref.ts … --faces=<dir>`)
the Bedrock compiler puts the real face on the head as a texture
(`web/src/engine/head-face.ts`).

Per head:
  1. Fetch `img.bricklink.com/ItemImage/PN/<colour>/3626pb<N>.png` (the colour
     from Studio's elementInfoList; any colour works, only the ink is kept)
     into `<dir>/raw/`, once.
  2. The photo shows the FRONT on the left (a dual-sided head shows its back on
     the right): take the leftmost head blob on the white background.
  3. Crop to the head's BODY: rows at least 80 % as wide as the widest drop the
     stud and the neck. The compiler maps the art onto the same rectangle of the
     head mesh (`headBodyRect`), so the two line up.
  4. Skin = the median colour of the body. A pixel is INK when its colour is
     far from the skin. Ink LIGHTER than the skin (eye whites, teeth) is kept
     only next to dark ink, which drops the studio lights' specular highlight
     on the forehead without losing a goblin's teeth.
  5. Write RGBA, ink opaque, skin transparent, 128 px wide.

This is ROUTE 2 of docs/bedrock-addon-guide.md's "Faces": the photos are
BrickLink's catalogue images, so the art is for local builds and is not
redistributed by this repo. Nothing in the web app fetches it.

MINI-DOLL heads (`HEAD_PRINT 92198pr<N>` / `28649pr<N>`, Rebrickable's print
ids: BrickLink numbers doll prints as unrelated items) take a different route,
`doll_face_art.py`: LEGO's own three-quarter render of the element (Rebrickable
serves it by element id, found through clego's `elements.csv`) is unwarped onto
the head mould's face by fitting the LDraw mesh to the photo's silhouette. The
art covers the doll head's whole front, which is what head-face.ts maps it onto
for a doll head.

Usage: python scripts/gen-face-art.py <out-dir> <model.ldr|.mpd>... [--sleep 1.0]
       (reads every HEAD_PRINT id, and the older `3626cpb<N>.dat` names)
Writes `<dir>/3626pb<N>.png` and `<dir>/92198pr<N>.png` (face art is keyed by
print id), and `<dir>/doll-fits.json` (each doll photo's silhouette fit).
"""
import csv
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

CLEGO = Path('C:/') / 'git' / 'clego'
STUDIO_DATA = [CLEGO / 'extracted' / e / 'app' / 'data' for e in ('studio_earlyaccess', 'studio_release')]
# The HEAD_PRINT meta line, and the older identity part name (still accepted).
HEAD_NAME = re.compile(r'^0\s+!CRAFTMATIC\s+HEAD_PRINT\s+3626[bc]?pb(\d+)\b|\b3626cpb(\d+)\.dat\b', re.I | re.M)
# A mini-doll head's print id (Rebrickable): the female mould 92198, the male 28649 (LDraw 92240).
DOLL_HEAD = re.compile(r'^0\s+!CRAFTMATIC\s+HEAD_PRINT\s+((92198|28649)pr[0-9a-z]+)\b', re.I | re.M)
DOLL_MOULD = {'92198': '92198', '28649': '92240'}
ART_WIDTH = 128


def bl_colours() -> dict[str, str]:
    """BrickLink head id (3626pb<N>) -> a BL colour code it is catalogued in."""
    out: dict[str, str] = {}
    for d in STUDIO_DATA:
        p = d / 'elementInfoList.json'
        if not p.exists():
            continue
        for r in json.load(open(p, encoding='utf-8')):
            m = re.match(r'^3626[bc]?pb(\d+)$', r['blItemNo'].lower())
            if m:
                out.setdefault(f'3626pb{m.group(1)}', r['blColorCode'])
    return out


def fetch(url: str, dest: Path, pause: float) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if not r.headers.get('content-type', '').startswith('image/'):
                return False
            dest.write_bytes(r.read())
            return True
    except Exception as e:  # noqa: BLE001 - a miss is reported, never fatal
        print(f'  fetch failed {url}: {e}')
        return False
    finally:
        time.sleep(pause)


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def face_art(photo: Path) -> Image.Image | None:
    im = np.asarray(Image.open(photo).convert('RGB')).astype(np.int32)
    h, w, _ = im.shape
    bg = im.min(axis=2) > 235
    cols = (~bg).sum(axis=0) > 8
    blobs, start = [], None
    for x in range(w):
        if cols[x] and start is None:
            start = x
        if (not cols[x] or x == w - 1) and start is not None:
            blobs.append((start, x))
            start = None
    blobs = [b for b in blobs if b[1] - b[0] > w * 0.15]
    if not blobs:
        return None
    x0, x1 = blobs[0]
    # Front and back photographed touching read as ONE blob about twice as wide
    # as it is tall: split it at the emptiest column of its middle and keep the
    # left (front) head.
    blob_rows = np.where((~bg[:, x0:x1]).any(axis=1))[0]
    blob_h = int(blob_rows.max() - blob_rows.min() + 1) if blob_rows.size else 1
    if x1 - x0 > 1.4 * blob_h:
        occ = (~bg[:, x0:x1]).sum(axis=0)
        lo, hi = int((x1 - x0) * 0.35), int((x1 - x0) * 0.65)
        x1 = x0 + lo + int(np.argmin(occ[lo:hi]))
    sub = ~bg[:, x0:x1]
    widths = sub.sum(axis=1)
    rows = np.where(widths >= 0.8 * widths.max())[0]
    y0, y1 = int(rows.min()), int(rows.max()) + 1
    cmask = sub[y0:y1].sum(axis=0) > 0.5 * (y1 - y0)
    cx = np.where(cmask)[0]
    bx0, bx1 = x0 + int(cx.min()), x0 + int(cx.max()) + 1
    face = im[y0:y1, bx0:bx1]
    skin = np.median(face.reshape(-1, 3), axis=0)
    dist = np.sqrt(((face - skin) ** 2).sum(axis=2))
    lum = face @ np.array([0.299, 0.587, 0.114])
    skin_lum = float(skin @ np.array([0.299, 0.587, 0.114]))
    ink = dist > 45
    if skin_lum < 90:
        # A dark head (black, dark brown): the print is the LIGHT ink, and a
        # highlight cannot be told from it by brightness, so all ink is kept.
        keep = ink
    else:
        dark = ink & (lum < skin_lum)
        light = ink & ~dark
        keep = dark | (light & dilate(dark, max(2, (bx1 - bx0) // 60)))
    # The silhouette's own rim is shading and background fringe, not print:
    # only ink well inside the head counts.
    # The silhouette is filled row by row: a pure-white eye or tooth reads as
    # background by colour alone, and must not become a hole in the head.
    raw_body = ~bg[y0:y1, bx0:bx1]
    body = np.zeros_like(raw_body)
    for r in range(raw_body.shape[0]):
        xs = np.where(raw_body[r])[0]
        if xs.size:
            body[r, xs.min():xs.max() + 1] = True
    # 6 % of the width: the photo's side shading on a light head (76417's tan
    # Hagrid) runs that deep; a face's own ink (goblin wrinkles) stays inside.
    # The crop IS the body's columns, so the outside must be padded in, or the
    # erosion never reaches the left and right rims.
    r = max(2, (bx1 - bx0) // 16)
    padded = np.pad(body, r, constant_values=False)
    inner = ~dilate(~padded, r)[r:-r, r:-r]
    keep &= inner
    rgba = np.dstack([face.astype(np.uint8), np.where(keep, 255, 0).astype(np.uint8)])
    art = Image.fromarray(rgba, 'RGBA')
    height = max(1, round(ART_WIDTH * (y1 - y0) / (bx1 - bx0)))
    # Nearest keeps alpha binary (the compiler alpha-TESTS); the colour of an
    # ink texel is still the photo's own.
    return art.resize((ART_WIDTH, height), Image.NEAREST)


def main(argv: list[str]) -> int:
    pause = float(argv[argv.index('--sleep') + 1]) if '--sleep' in argv else 1.0
    args = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] != '--sleep')]
    if len(args) < 2:
        print(__doc__)
        return 64
    out = Path(args[0])
    (out / 'raw').mkdir(parents=True, exist_ok=True)
    heads: set[str] = set()
    dolls: set[str] = set()
    for model in args[1:]:
        text = Path(model).read_text(encoding='latin-1')
        for m in HEAD_NAME.finditer(text):
            heads.add(m.group(1) or m.group(2))
        dolls.update(m.group(1).lower() for m in DOLL_HEAD.finditer(text))
    colours = bl_colours()
    made = missing = 0
    for n in sorted(heads, key=int):
        bl = f'3626pb{n}'
        colour = colours.get(bl, '90')
        raw = out / 'raw' / f'{bl}-{colour}.png'
        if not fetch(f'https://img.bricklink.com/ItemImage/PN/{colour}/{bl}.png', raw, pause):
            print(f'{bl}: no photo')
            missing += 1
            continue
        art = face_art(raw)
        if art is None:
            print(f'{bl}: no head found in the photo')
            missing += 1
            continue
        art.save(out / f'3626pb{n}.png')
        made += 1
        print(f'{bl}: {art.size[0]}x{art.size[1]}')
    d_made, d_missing = doll_heads(sorted(dolls), out, pause)
    print(f'{made + d_made} face art written to {out} ({d_made} mini-doll), {missing + d_missing} without')
    return 0


def doll_elements() -> dict[str, list[str]]:
    """Rebrickable part number (`92198pr0147`) -> the LEGO element ids that carry it."""
    out: dict[str, list[str]] = {}
    with open(CLEGO / 'elements.csv', newline='', encoding='utf-8', errors='replace') as f:
        for r in csv.DictReader(f):
            if r['part_num'].lower().startswith(('92198pr', '28649pr')):
                out.setdefault(r['part_num'].lower(), []).append(r['element_id'])
    return out


def doll_heads(ids: list[str], out: Path, pause: float) -> tuple[int, int]:
    """Doll face art for each print id from LEGO's element render (`doll_face_art.py`)."""
    if not ids:
        return 0, 0
    from doll_face_art import doll_art
    elements = doll_elements()
    fits: dict[str, dict] = {}
    made = missing = 0
    for pid in ids:
        mould = DOLL_MOULD[pid[:5]]
        art, info = None, {'error': 'no element render'}
        for el in elements.get(pid, []):
            raw = out / 'raw' / f'{pid}-{el}.jpg'
            if not fetch(f'https://cdn.rebrickable.com/media/parts/elements/{el}.jpg', raw, pause):
                continue
            art, info = doll_art(raw, mould)
            info['element'] = el
            if art is not None:
                break
        fits[pid] = info
        if art is None:
            print(f'{pid}: no art ({info.get("error")})')
            missing += 1
            continue
        art.save(out / f'{pid}.png')
        made += 1
        print(f'{pid}: {art.size[0]}x{art.size[1]} fit {info}')
    (out / 'doll-fits.json').write_text(json.dumps(fits, indent=1, sort_keys=True), encoding='utf-8')
    return made, missing


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
