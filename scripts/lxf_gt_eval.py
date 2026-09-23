#!/usr/bin/env python3
"""
lxf_gt_eval.py — score the browser's `.lxf` placement maths against authentic
Studio ground truth, and sweep alternative conventions.

WHY. `web/src/engine/lxf-parser.ts` places every LDD part through Studio's
`ldraw.xml` row applied as its INVERSE, clego's MEASURED table for the designs
that row does not name, and — for the mini-doll moulds NEITHER names — a
per-slot origin correction (`--no-minidoll` reproduces the placements from
before that third case existed).

The shipped maths was held out at 72.70 % GEO on six sets; this tool
measures it on EVERY native `.lxf` in clego that has an authentic (non-laundered)
Studio `.io`, 91 of them, and lets a candidate convention be scored the same way
before it is ported to TypeScript.

The placement maths below mirrors the TypeScript exactly (`parseBoneTransform`,
`composeLxfPlacement`, `composeLxfMeasured`); the `variant` argument selects an
alternative composition so a hypothesis can be measured, not argued.

Usage (from the craftmatic root):
  python scripts/lxf_gt_eval.py --sets 10242 21303 --variants shipped xml_inv_ldr
  python scripts/lxf_gt_eval.py --all --variants shipped --json output/lxf-gt/shipped.json
  python scripts/lxf_gt_eval.py --sets 10242 --variants shipped --dump output/lxf-gt/10242.ldr

Requires C:/git/clego (its `dbix_gt_compare`, `io_authenticity` and geograde
part points) and the shipped tables in `web/public/`.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

CLEGO = Path(os.environ.get('CLEGO_ROOT', 'C:/git/clego'))
sys.path.insert(0, str(CLEGO))
from dbix_gt_compare import compare, load_any, best_alignment, geo_match, norm_stem  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# `CRAFTMATIC_PART_MAP` / `CRAFTMATIC_MEASURED_ALIGN` point a run at a candidate
# table, so two tables can be scored side by side without swapping the shipped
# files in the working tree.
PART_MAP = Path(os.environ.get('CRAFTMATIC_PART_MAP', ROOT / 'web' / 'public' / 'ldd-part-map.json'))
MEASURED = Path(os.environ.get('CRAFTMATIC_MEASURED_ALIGN', ROOT / 'web' / 'public' / 'ldd-measured-align.json'))
LXF_DIR = CLEGO / 'lego_sets' / 'LXF'
IO_DIR = CLEGO / 'lego_sets' / 'IO'
CM_TO_LDU = 25.0
F = np.diag([1.0, -1.0, -1.0])


# ── LDD material id → LDraw colour (a small subset is enough for scoring) ────
def ldd_colour(material: int) -> int:
    return material if material else 16


# ── LXFML records ────────────────────────────────────────────────────────────
def read_lxf_records(path: Path) -> list[dict]:
    """Every <Part> of every <Brick>: designID, material, transformation, bones."""
    data = path.read_bytes()
    if data[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            name = next((n for n in z.namelist() if n.upper().endswith('.LXFML')), None)
            if name is None:
                raise RuntimeError(f'{path.name}: no LXFML entry')
            xml = z.read(name)
    else:
        xml = data
    root = ET.fromstring(xml)
    out = []
    for brick in root.iter('Brick'):
        b_design = (brick.get('designID') or '').split(';')[0].strip()
        for part in brick.findall('Part'):
            bones = part.findall('Bone')
            design = (part.get('designID') or b_design or '3001').split(';')[0].strip()
            mats = (part.get('materials') or '').split(',')
            try:
                material = int(mats[0]) if mats and mats[0] else 194
            except ValueError:
                material = 194
            out.append({
                'designID': design,
                'material': material,
                'transformation': bones[0].get('transformation', '') if bones else '',
                'boneCount': len(bones),
            })
    return out


def parse_bone(tf: str):
    v = [float(x) for x in tf.split(',')] if tf else []
    if len(v) < 12:
        return None
    # The TypeScript reads the nine values COLUMN-major and returns the
    # transposed row-major R (parseBoneTransform).
    m = np.array(v[:9]).reshape(3, 3)
    return m.T.copy(), np.array(v[9:12])


def axis_angle(angle: float, ax: float, ay: float, az: float) -> np.ndarray:
    if abs(angle) < 1e-9:
        return np.eye(3)
    n = np.hypot(np.hypot(ax, ay), az)
    if n < 1e-9:
        return np.eye(3)
    ax, ay, az = ax / n, ay / n, az / n
    c, s, t = np.cos(angle), np.sin(angle), 1 - np.cos(angle)
    return np.array([
        [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay],
        [t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax],
        [t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c],
    ])


# ── placement variants ───────────────────────────────────────────────────────
# Each variant maps (R_bone row-major, t_bone cm, xml row, measured row) to
# (rot 3x3 in LDraw, pos LDU, ldraw file).  `shipped` is the TypeScript,
# which is `hybrid_xml_first`; `legacy_measured_first` is what it replaced.

def xml_parts(align):
    t_align = np.array(align[1:4], dtype=float)
    r_align = axis_angle(align[4], align[5], align[6], align[7])
    return r_align, t_align


def place_legacy_measured_first(rb, tb, align, meas):
    """What shipped BEFORE 38ea28c: the measured table first, ldraw.xml forward
    as the fallback. Kept so the improvement stays re-measurable; it is no
    longer what the TypeScript does."""
    if meas is not None:
        r_ldr = F @ rb @ F
        d = np.array(meas[1:10]).reshape(3, 3)
        e = np.array(meas[10:13])
        return r_ldr @ d, F @ tb * CM_TO_LDU + r_ldr @ e, meas[0]
    if align is not None:
        r_align, t_align = xml_parts(align)
        r_world = rb @ r_align
        pos = F @ (rb @ t_align + tb) * CM_TO_LDU
        return F @ r_world @ F, pos, align[0]
    return F @ rb @ F, F @ tb * CM_TO_LDU, None


def place_xml_only(rb, tb, align, meas, *, inverse=False, left=False, ldr_side=False, transpose_bone=False):
    """The ldraw.xml path alone (measured table ignored) under one convention."""
    if transpose_bone:
        rb = rb.T
    if align is None:
        return F @ rb @ F, F @ tb * CM_TO_LDU, None
    r_align, t_align = xml_parts(align)
    if inverse:
        r_align, t_align = r_align.T, -(r_align.T @ t_align)
    if not ldr_side:
        # compose in LDD space, then change basis
        if left:
            r_world = r_align @ rb
            t_world = r_align @ tb + t_align
        else:
            r_world = rb @ r_align
            t_world = rb @ t_align + tb
        return F @ r_world @ F, F @ t_world * CM_TO_LDU, align[0]
    # change basis first, apply the (flipped, scaled) correction on the LDraw side
    r_ldr = F @ rb @ F
    t_ldr = F @ tb * CM_TO_LDU
    ra = F @ r_align @ F
    ta = F @ t_align * CM_TO_LDU
    if left:
        return ra @ r_ldr, ra @ t_ldr + ta, align[0]
    return r_ldr @ ra, r_ldr @ ta + t_ldr, align[0]


def place_measured_only(rb, tb, align, meas, *, transpose_bone=False):
    if transpose_bone:
        rb = rb.T
    if meas is None:
        return F @ rb @ F, F @ tb * CM_TO_LDU, (align[0] if align else None)
    r_ldr = F @ rb @ F
    d = np.array(meas[1:10]).reshape(3, 3)
    e = np.array(meas[10:13])
    return r_ldr @ d, F @ tb * CM_TO_LDU + r_ldr @ e, meas[0]


def place_hybrid_xml_first(rb, tb, align, meas):
    """ldraw.xml (inverse, right, LDD side) when the design has a row; the measured table otherwise."""
    if align is not None:
        return place_xml_only(rb, tb, align, None, inverse=True)
    return place_measured_only(rb, tb, align, meas)


# `shipped` MUST track web/src/engine/lxf-parser.ts. Since 38ea28c that is
# Studio's ldraw.xml row applied as its INVERSE first, clego's measured table
# only for designs ldraw.xml does not name — i.e. the hybrid below. Leaving the
# old alias here would silently measure a placement the app no longer uses.
VARIANTS = {
    'shipped': place_hybrid_xml_first,
    'hybrid_xml_first': place_hybrid_xml_first,
    'legacy_measured_first': place_legacy_measured_first,
    'none': lambda rb, tb, a, m: (F @ rb @ F, F @ tb * CM_TO_LDU, (a[0] if a else (m[0] if m else None))),
    'measured_only': place_measured_only,
    'measured_only_T': lambda rb, tb, a, m: place_measured_only(rb, tb, a, m, transpose_bone=True),
}
for inv in (False, True):
    for left in (False, True):
        for ldr in (False, True):
            for tr in (False, True):
                name = 'xml' + ('_inv' if inv else '') + ('_left' if left else '_right') + ('_ldr' if ldr else '_ldd') + ('_T' if tr else '')
                VARIANTS[name] = (lambda inv=inv, left=left, ldr=ldr, tr=tr: (
                    lambda rb, tb, a, m: place_xml_only(rb, tb, a, m, inverse=inv, left=left, ldr_side=ldr, transpose_bone=tr)))()


# ── the mini-doll third case ────────────────────────────────────────────────
# `web/src/engine/lxf-parser.ts` applies a per-SLOT origin correction to the
# mini-doll moulds NEITHER table covers (clego DBIX_SOLVER.md section 11).  The
# slot table is read out of the GENERATED TypeScript rather than re-derived
# here, so this harness cannot drift from what the app does — which is the only
# reason the number it prints is worth anything.
MINIDOLL_SLOTS_TS = ROOT / 'web' / 'src' / 'engine' / 'minidoll-slots-generated.ts'
MINIDOLL_CORRECTION = {
    'doll_leg': np.array([10.01, 0.00, 0.00]),
    'doll_torso': np.array([0.00, -19.09, 1.72]),
    'doll_hips': np.array([0.01, 10.33, 2.83]),
    'doll_arm': np.array([0.00, -2.26, 0.94]),
    'doll_head': np.array([0.00, -2.24, 3.28]),
    'doll_hair': np.array([0.00, -2.29, 0.28]),
}
_SLOT_RE = re.compile(r"^  '([^']+)': '([^']+)',$", re.M)
MINIDOLL_SLOTS = dict(_SLOT_RE.findall(MINIDOLL_SLOTS_TS.read_text(encoding='utf-8')))
NO_MINIDOLL = False


def minidoll_correction(part: str):
    """The slot correction for an LDraw filename, or None (mirrors `miniDollCorrectionFor`)."""
    stem = re.sub(r'\.dat$', '', part.split('/')[-1].split(chr(92))[-1], flags=re.I).lower()
    unprinted = re.sub(r'^([0-9]+[a-z]?)p[0-9a-z]*?(c[0-9]+)?$', r'\1\2', stem)
    slot = MINIDOLL_SLOTS.get(stem) or MINIDOLL_SLOTS.get(unprinted)
    return MINIDOLL_CORRECTION.get(slot) if slot else None


def identity_xml_row(align) -> bool:
    if align is None:
        return True
    return (max(abs(v) for v in align[1:4]) < 1e-6
            and (abs(align[4]) < 1e-9 or np.linalg.norm(align[5:8]) < 1e-9))


def identity_measured_row(meas) -> bool:
    if meas is None:
        return True
    d = np.array(meas[1:10]).reshape(3, 3)
    return np.allclose(d, np.eye(3), atol=1e-6) and max(abs(v) for v in meas[10:13]) < 1e-6


def ldr_text(records, table, measured, variant) -> tuple[str, Counter]:
    fn = VARIANTS[variant]
    lines = ['0 lxf_gt_eval ' + variant]
    stats = Counter()
    for rec in records:
        bone = parse_bone(rec['transformation'])
        if bone is None:
            stats['skipped'] += 1
            continue
        rb, tb = bone
        align = table.get(rec['designID'])
        meas = measured.get(rec['designID'])
        rot, pos, part = fn(rb, tb, align, meas)
        if part is None:
            part = f"{rec['designID']}.dat"
            stats['unmapped'] += 1
        elif meas is not None and (
                variant in ('legacy_measured_first', 'measured_only', 'measured_only_T')
                or (variant in ('shipped', 'hybrid_xml_first') and align is None)):
            stats['measured'] += 1
        else:
            stats['xml'] += 1
        # The mini-doll slot correction, for the variants that claim to be the
        # shipped maths.  Same precedence as the TypeScript: the filename comes
        # from the tables, the correction is replaced only where both rows
        # correct nothing.
        if variant in ('shipped', 'hybrid_xml_first') and not NO_MINIDOLL:
            e = minidoll_correction(part)
            ident = identity_xml_row(align) if align is not None else identity_measured_row(meas)
            if e is not None and ident:
                r_ldr = F @ rb @ F
                rot, pos = r_ldr, F @ tb * CM_TO_LDU + r_ldr @ e
                stats['minidoll'] += 1
        r = rot.flatten()
        lines.append('1 %d %.4f %.4f %.4f %s %s' % (
            ldd_colour(rec['material']), pos[0], pos[1], pos[2],
            ' '.join('%.6f' % v for v in r), part))
    return '\n'.join(lines) + '\n', stats


def cohort() -> list[tuple[str, Path, Path]]:
    """(set, lxf, io) for every native .lxf whose set has an authentic Studio .io."""
    auth = json.loads((CLEGO / 'io_authenticity.json').read_text(encoding='utf-8'))['files']
    studio: dict[str, list[str]] = defaultdict(list)
    for e in auth:
        if e.get('verdict') == 'studio':
            studio[e['set']].append(e['file'])
    rows = []
    for f in sorted(os.listdir(LXF_DIR)):
        if not f.lower().endswith('.lxf'):
            continue
        m = re.match(r'(\d+)', f)
        if not m or m.group(1) not in studio:
            continue
        ios = sorted(studio[m.group(1)])
        # A "[Model B]" alternate build is truth only against a "[Model B]" .io:
        # scored against Model A it reads ~1 % and says nothing about placement.
        variant = re.search(r'\[Model ([A-Z])\]', f)
        if variant:
            same = [i for i in ios if f'[Model {variant.group(1)}]' in i]
            if not same:
                continue
            ios = same
        elif any('[Model' in i for i in ios) and not any('[Model A]' in i for i in ios):
            # the io files are all alternates and the lxf is the main model: no truth
            ios = [i for i in ios if '[Model' not in i] or ios
        rows.append((m.group(1), LXF_DIR / f, IO_DIR / ios[0]))
    return rows


def score_one(set_num: str, lxf: Path, io_path: Path, variant: str, table, measured, dump: Path | None):
    records = read_lxf_records(lxf)
    text, stats = ldr_text(records, table, measured, variant)
    tmp = ROOT / 'output' / 'lxf-gt' / '_tmp'
    tmp.mkdir(parents=True, exist_ok=True)
    conv = tmp / f'{set_num}__{variant}.ldr'
    conv.write_text(text, encoding='utf-8')
    if dump:
        dump.parent.mkdir(parents=True, exist_ok=True)
        dump.write_text(text, encoding='utf-8')
    r = compare(set_num, conv, io_path)
    r['variant'] = variant
    r['lxf'] = lxf.name
    r['io'] = io_path.name
    r['placements'] = dict(stats)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sets', nargs='*', help='set numbers (default: a 4-set probe)')
    ap.add_argument('--all', action='store_true', help='every native .lxf with an authentic .io')
    ap.add_argument('--variants', nargs='*', default=['shipped'])
    ap.add_argument('--no-minidoll', action='store_true',
                    help='reproduce the pre-fix placements (the mini-doll A/B)')
    ap.add_argument('--list-variants', action='store_true')
    ap.add_argument('--json')
    ap.add_argument('--dump', help='write the first set/variant placement as this .ldr')
    args = ap.parse_args()
    global NO_MINIDOLL
    NO_MINIDOLL = args.no_minidoll
    if args.list_variants:
        print('\n'.join(sorted(VARIANTS)))
        return

    table = json.loads(PART_MAP.read_text(encoding='utf-8'))
    measured = json.loads(MEASURED.read_text(encoding='utf-8'))
    rows = cohort()
    if not args.all:
        want = set(args.sets or ['10242', '21303', '8880', '10187'])
        rows = [r for r in rows if r[0] in want]
    print(f'{len(rows)} lxf files × {len(args.variants)} variants', flush=True)

    results = []
    per_variant = defaultdict(list)
    for set_num, lxf, io_path in rows:
        for variant in args.variants:
            t0 = time.time()
            dump = Path(args.dump) if (args.dump and not results) else None
            try:
                r = score_one(set_num, lxf, io_path, variant, table, measured, dump)
            except Exception as e:  # a broken file must not stop the cohort
                r = {'set': set_num, 'variant': variant, 'lxf': lxf.name, 'error': f'{type(e).__name__}: {e}'}
            r['seconds'] = round(time.time() - t0, 1)
            results.append(r)
            per_variant[variant].append(r)
            if 'error' in r:
                print(f'  {set_num:>6} {variant:<22} ERROR {r["error"]}', flush=True)
            else:
                print(f'  {set_num:>6} {variant:<22} GEO {r["geo_pct"]:6.2f}%  exact {r["exact_pct"]:6.2f}%  '
                      f'gt {r["n_gt"]:5d} conv {r["n_conv"]:5d}  {r["seconds"]}s  {lxf.name}', flush=True)

    print()
    for variant, rs in per_variant.items():
        ok = [r for r in rs if 'error' not in r]
        if not ok:
            print(f'{variant:<22} no scored sets')
            continue
        hit = sum(r['geo_hit'] for r in ok)
        seen = sum(r['geo_seen'] for r in ok)
        med = float(np.median([r['geo_pct'] for r in ok]))
        print(f'{variant:<22} {len(ok):3d} files  weighted GEO {100.0 * hit / max(seen, 1):6.2f}%  '
              f'median {med:6.2f}%  GT parts {seen}')
    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(results, indent=1), encoding='utf-8')
        print(f'wrote {out}')


if __name__ == '__main__':
    main()
