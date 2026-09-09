#!/usr/bin/env python3
"""
Generate web/public/ldd-measured-align.json from clego's MEASURED LDD alignment.

WHY THIS EXISTS.  `ldd-part-map.json` carries BrickLink Studio's own `ldraw.xml`
correction columns, and those columns do not reproduce Studio's own placements.
Measured against six sets that have BOTH a native `.lxf` and an authentic Studio
`.io` — and that are NOT in clego's training cohort, so this is held out:

    variant                                                  GEO agreement
    ldraw.xml columns, F = diag(1,-1,1)   (what shipped)          7.15 %
    ldraw.xml columns, F = diag(1,-1,-1)                          7.06 %
    MEASURED table,    F = diag(1,-1,1)                          48.12 %
    MEASURED table,    F = diag(1,-1,-1)                         72.70 %
    no per-part correction at all         (control)               3.78 %

So the shipped path was barely above the do-nothing control, and BOTH halves
matter: the correction payload (+65 pts) and the change of basis (+24.6 pts).
`F = diag(1,-1,1)` has det = -1 — it is a REFLECTION, so it mirrors the model
and lands every chiral part (slopes, wedges, curved shells) in the wrong slot.
LDD and LDraw are both right-handed, so the basis map is a 180 degree rotation
about X: `diag(1,-1,-1)`.

THE TABLE.  clego's `dbix_align_learn.py` measures, per LDD design id, the local
rigid delta `(D, e)` that carries the raw LXFML bone frame onto the authentic
Studio placement, voting over 207 sets that have both a DBIX LXFML dump and an
authentic `.io` (see clego DBIX_SOLVER.md section 4/9).  `e` is already in LDU and
already in the flipped LDraw basis, so the browser composes it POST-flip:

    R_world = (F R_bone F) D            t_world = 25 (F t_bone) + (F R_bone F) e

which is the same algebra `composeLxfPlacement` does in LDD space, with the
correction expressed on the other side of the change of basis.

Output shape — one row per design id, arrays to keep the asset small:
  { "<designID>": ["<ldrawFile>", r0..r8, tx, ty, tz, support], ... }

`r0..r8` is row-major and RE-ORTHONORMALISED here: the learner quantises its
rotation votes to 1/20, so 303 of the 1,843 raw rows are not orthonormal (det
0.94 - 1.06).  Fixing that at generation time keeps an SVD out of the browser.

Designs absent from this table keep falling back to `ldd-part-map.json`; the
`.lxf` loader reports the split in its diagnostics.
"""
import json
from pathlib import Path

import numpy as np

SRC = Path(r'C:\git\clego\dbix_part_align.json')
XMLMAP = Path(r'C:\git\craftmatic\web\public\ldd-part-map.json')
OUT = Path(r'C:\git\craftmatic\web\public\ldd-measured-align.json')

# clego's dbix_align.py drops rows this weakly supported (its own MIN_SUPPORT).
MIN_SUPPORT = 2


def orthonormalise(r9):
    """Nearest proper rotation to a 3x3, via SVD. Keeps det = +1."""
    m = np.asarray(r9, float).reshape(3, 3)
    u, _s, vt = np.linalg.svd(m)
    q = u @ vt
    if np.linalg.det(q) < 0:                 # never accept a reflection
        q = u @ np.diag([1.0, 1.0, -1.0]) @ vt
    return q


def rnd(v):
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def main():
    raw = json.loads(SRC.read_text())
    if tuple(raw.get('S', ())) != (1, -1, -1):
        raise SystemExit(f'unexpected basis map S={raw.get("S")} — the browser '
                         f'composes for diag(1,-1,-1); regenerate or update it')
    xml = json.loads(XMLMAP.read_text()) if XMLMAP.exists() else {}

    # designID -> {ldraw stem: entry}. A design can resolve to several stems
    # (mould revisions); prefer the one ldd-part-map.json already names, so the
    # two tables agree on the FILE and differ only in the correction, then fall
    # back to the best-supported stem.
    by_design: dict[str, dict[str, dict]] = {}
    for key, ent in raw['table'].items():
        design, stem = key.split('|', 1)
        if int(ent.get('n', 0)) < MIN_SUPPORT:
            continue
        by_design.setdefault(design, {})[stem] = ent

    out: dict[str, list] = {}
    reortho = 0
    for design, cands in by_design.items():
        stem = None
        want = xml.get(design)
        if want:
            w = str(want[0]).rsplit('.', 1)[0]
            if w in cands:
                stem = w
        if stem is None:
            stem = max(cands.items(), key=lambda kv: int(kv[1].get('n', 0)))[0]
        ent = cands[stem]
        m = np.asarray(ent['R'], float).reshape(3, 3)
        q = orthonormalise(m)
        if np.abs(q - m).max() > 1e-6:
            reortho += 1
        t = ent['t']
        out[design] = ([f'{stem}.dat']
                       + [rnd(v) for v in q.flatten()]
                       + [rnd(t[0]), rnd(t[1]), rnd(t[2])]
                       + [int(ent.get('n', 0))])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'Wrote {len(out)} measured design corrections -> {OUT} '
          f'({OUT.stat().st_size / 1024:.0f} KB); re-orthonormalised {reortho}')
    print(f'  source: {SRC.name}, {len(raw["table"])} raw rows, '
          f'{len(raw.get("explained_sets", {}))} ground-truth-locked sets')
    for k in ('3001', '3023', '3815', '3814', '3817', '1751'):
        print(f'  {k}: {out.get(k)}')


if __name__ == '__main__':
    main()
