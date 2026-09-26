#!/usr/bin/env python3
"""A contact sheet of every NPC figure in a built pack, each framed from the FRONT by the offline
renderer (`scripts/_pack_render.ts --frame`), so faces and whole bodies are checked without a phone.

    python -u scripts/_figure_sheet.py <pack.mcaddon> <out.png> [--dir=0,-0.1,-1]

The sheet stays under 2000 px.  - Opus 5.5
"""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent


def figure_ids(pack: Path) -> list[str]:
    z = zipfile.ZipFile(pack)
    ids: set[str] = set()
    for n in z.namelist():
        if n.endswith('.json') and '/entities/' in n and '_BP/' in n:
            ids.update(re.findall(r'"identifier"\s*:\s*"([^"]+_fig\d+)"', z.read(n).decode('utf-8', 'replace')))
    return sorted(ids, key=lambda s: int(re.search(r'(\d+)$', s).group(1)))


def main() -> int:
    pack, out = Path(sys.argv[1]), Path(sys.argv[2])
    view = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--dir=')), '0,-0.1,-1')
    ids = [i for i in figure_ids(pack) if '_car_' not in i]
    tiles = []
    with tempfile.TemporaryDirectory() as tmp:
        for i in ids:
            suffix = i.split(':')[-1]
            png = Path(tmp) / f'{suffix}.png'
            subprocess.run(['bun', 'scripts/_pack_render.ts', str(pack), f'--out={png}', '--kinds=figure', f'--type={suffix}',
                            f'--frame={suffix}', f'--dir={view}', '--size=360x520'], cwd=REPO, capture_output=True, check=False)
            if png.exists():
                tiles.append(Image.open(png).convert('RGB'))
    if not tiles:
        print('no figures rendered')
        return 1
    cols = min(len(tiles), 6)
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * 360, rows * 520), 'white')
    for k, t in enumerate(tiles):
        sheet.paste(t, ((k % cols) * 360, (k // cols) * 520))
    sheet.thumbnail((1900, 1900))
    sheet.save(out)
    print(f'{out}: {len(tiles)} figures')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
