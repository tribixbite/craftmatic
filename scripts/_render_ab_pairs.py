#!/usr/bin/env python3
"""Render before/after pairs of source files through the REAL viewer, for eye review.

Each file is loaded by `scripts/_lego-probe.mjs file:<abs path>` against the
running dev server (`bun dev:web`, port 4000), which captures the LEGO canvas
from its fixed iso/front/left cameras.  The before and after captures are then
set side by side (before LEFT, after RIGHT) and shrunk below 2000 px so they can
be read directly.

Jobs come from a gate_v2.json (clego geograde/gate_v2.py `ab` output) filtered
by verdict, or from a JSON list of {"name", "before", "after"}.

    python -u scripts/_render_ab_pairs.py <gate_v2.json|jobs.json> <out_dir> [--verdict unsure] [--rels a,b] [--workers 4]

Resumable: a file whose three captures exist is not rendered again.  — Opus 5.5
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
PROBE = REPO / 'scripts' / '_lego-probe.mjs'
CLEGO_LS = Path('C:/git/clego/lego_sets')
VIEWS = ('iso', 'front')
MAX_EDGE = 1900          # every composed image stays under the 2000 px read limit


def jobs_from(path: Path, verdicts: set[str] | None, rels: set[str] | None) -> list[dict]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if isinstance(data, list):
        return data
    root = Path(data['after_root'])
    out = []
    for r in data['rows']:
        if verdicts and r.get('verdict') not in verdicts:
            continue
        if rels and r['rel'] not in rels:
            continue
        out.append({'name': Path(r['rel']).stem, 'before': str(CLEGO_LS / r['rel']),
                    'after': str(root / r['rel'])})
    return out


def render(file: str, out_dir: Path, label: str) -> bool:
    if all((out_dir / f'{label}-{v}.png').exists() for v in VIEWS):
        return True
    log = out_dir / f'{label}.log'
    with log.open('wb') as fh:
        rc = subprocess.run(['node', str(PROBE), f'file:{file}', str(out_dir), label],
                            cwd=REPO, stdout=fh, stderr=subprocess.STDOUT, timeout=900).returncode
    ok = all((out_dir / f'{label}-{v}.png').exists() for v in VIEWS)
    print(f'{"ok  " if ok else "FAIL"} {label} (exit {rc})', flush=True)
    return ok


def compose(out_dir: Path, name: str) -> None:
    for v in VIEWS:
        b, a = out_dir / f'{name}-before-{v}.png', out_dir / f'{name}-after-{v}.png'
        if not (b.exists() and a.exists()):
            continue
        ib, ia = Image.open(b).convert('RGB'), Image.open(a).convert('RGB')
        w = Image.new('RGB', (ib.width + ia.width + 8, max(ib.height, ia.height)), (255, 255, 255))
        w.paste(ib, (0, 0))
        w.paste(ia, (ib.width + 8, 0))
        w.thumbnail((MAX_EDGE, MAX_EDGE))
        w.save(out_dir / f'{name}-pair-{v}.png')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('jobs', type=Path)
    ap.add_argument('out', type=Path)
    ap.add_argument('--verdict', action='append')
    ap.add_argument('--rels')
    ap.add_argument('--workers', type=int, default=4)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    jobs = jobs_from(a.jobs, set(a.verdict) if a.verdict else None,
                     set(a.rels.split(',')) if a.rels else None)
    tasks = [(j[side], f"{j['name']}-{side}") for j in jobs for side in ('before', 'after')]
    print(f'{len(jobs)} pairs, {len(tasks)} renders, {a.workers} at a time', flush=True)
    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(lambda t: render(t[0], a.out, t[1]), tasks))
    for j in jobs:
        compose(a.out, j['name'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
