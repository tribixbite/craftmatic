#!/usr/bin/env python3
"""Before/after doll line-ups for a source round, rendered through the real viewer.

For each stem: `_doll_lineup.ts` writes the dolls of the BEFORE file and of the
AFTER file as line-ups (source row behind, rig row in front), `_lego-probe.mjs`
renders both against the running dev server (:4000) from a camera placed in
front of the line-up (`PROBE_VIEWS`: the viewer's own fixed cameras are
model-aware and showed the dolls' backs), and the two captures are set side by
side, before LEFT, under 2000 px. `--closeups` also captures each doll of the
rig row on its own (`<stem>-<tag>-doll<k>.png`).

    python -u scripts/_doll_lineup_ab.py <before_dir> <after_dir> <out_dir> <stem>... [--closeups]

Resumable: a stem whose composite exists is skipped.  - Opus 5.5
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
MAX_EDGE = 1900
# The line-up's geometry (scripts/_doll_lineup.ts): dolls PITCH LDU apart along +X, the
# rig row at z = 0 and the source row ROW_GAP behind it; the viewer draws 20 LDU per unit.
PITCH, UNIT = 60, 20


def views(count: int, closeups: bool) -> list[dict]:
    span = max(1, count - 1) * PITCH / UNIT
    cx = span / 2
    # The viewer keeps LDraw's origin (the rig row's torsos) at scene y = 0, feet ~3.8 below.
    out = [{'name': 'lineup', 'pos': [cx, 1.5, max(16.0, span * 1.2)], 'target': [cx, 0.3, 0]}]
    if closeups:
        out += [{'name': f'doll{k + 1}', 'pos': [k * PITCH / UNIT, 0.8, 7.5], 'target': [k * PITCH / UNIT, 0.4, 0]} for k in range(count)]
    return out


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    closeups = '--closeups' in sys.argv
    before_dir, after_dir, out = Path(args[0]), Path(args[1]), Path(args[2])
    out.mkdir(parents=True, exist_ok=True)
    for stem in args[3:]:
        comp = out / f'{stem}-ab.png'
        if comp.exists():
            continue
        shots = []
        for tag, src in (('before', before_dir / f'{stem}.ldr'), ('after', after_dir / f'{stem}.ldr')):
            ldr = out / f'{stem}-{tag}.ldr'
            res = subprocess.run(['bun', 'scripts/_doll_lineup.ts', str(src), str(ldr)], cwd=REPO, check=True, capture_output=True, text=True)
            m = re.search(r': (\d+) dolls', res.stdout)
            count = int(m.group(1)) if m else 1
            png = out / f'{stem}-{tag}-lineup.png'
            if not png.exists():
                env = {**os.environ, 'PROBE_VIEWS': json.dumps(views(count, closeups))}
                with (out / f'{stem}-{tag}.log').open('wb') as fh:
                    subprocess.run(['node', 'scripts/_lego-probe.mjs', f'file:{ldr}', str(out), f'{stem}-{tag}'],
                                   cwd=REPO, stdout=fh, stderr=subprocess.STDOUT, timeout=900, env=env)
            shots.append(png)
        if not all(p.exists() for p in shots):
            print(f'FAIL {stem}', flush=True)
            continue
        a, b = (Image.open(p).convert('RGB') for p in shots)
        c = Image.new('RGB', (a.width + b.width, max(a.height, b.height)), 'white')
        c.paste(a, (0, 0))
        c.paste(b, (a.width, 0))
        c.thumbnail((MAX_EDGE, MAX_EDGE))
        c.save(comp)
        print(f'ok   {stem} -> {comp}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
