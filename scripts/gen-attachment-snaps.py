#!/usr/bin/env python3
"""gen-attachment-snaps.py — emit the browser's attachment-metadata table.

The connectivity audit in the viewer measures SURFACE contact, which is blind to
joints whose mechanical grip is a small or curved patch: a clip on a bar, a pin
in a hole, a hair piece on a minifig head. LDCad's shadow library encodes those
joints explicitly (`0 !LDCAD SNAP_*` metas), so this script resolves them once,
offline, into a compact table the audit can fuse with its surface check
(docs/lego-3d-generation-audit-2026-09-08.md, P1 item 5).

    python scripts/gen-attachment-snaps.py

Reads:  the LDCad shadow library + the local LDraw part library, via the
        resolver already written for scripts/ldcad_connectivity.py (which walks
        each part's real subfile tree so studs defined in primitives are found).
Writes: web/src/viewer/ldraw/attachment-snaps.ts

SELECTION (deliberately not "everything"): the shadow library covers 3,556
parts with cylinder snaps and a full table would be a large payload for joints
the surface test already sees. Included instead:

  1. every part whose own shadow file carries a CLIP snap (SNAP_CLP) — the
     genuinely blind class;
  2. EXTRA_PARTS — clip/bar plates whose clip snap comes from a SUBPART, so the
     part itself has no shadow file and rule 1 cannot see it (4085 and friends
     are among the most common SNOT connectors in the corpus);
  3. minifig heads and everything worn on one (hair, hats, helmets, hoods) —
     the audit's named case, and the class where a wrong local origin looks
     exactly like a floating accessory;
  4. bars, pins and axles — the male halves clips and pin holes grip;
  5. the plain brick/plate/tile stud families up to 6 studs — stud stacking is
     already covered by surface contact, but including it lets the audit REPORT
     honest snap coverage instead of implying the table is complete.

Rules 3-5 are matched against each part's DESCRIPTION in the real library (not
just the shadow library), because a part with no shadow file of its own can
still resolve real connectors through its subparts.

Parts resolving to more than MAX_SNAPS connectors are skipped: a 6x8 baseplate
contributes 96 stud points for a joint the surface test never misses.

KNOWN COVERAGE LIMIT: a clip-bearing part that is neither in EXTRA_PARTS nor
description-matched is absent from the table. Resolving all 12k library parts
to find them takes >10 min, which is too slow for a routine regeneration, so
the audit reports per-model coverage instead of pretending completeness.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import ldcad_connectivity as L  # noqa: E402  (path set above)

OUT = HERE.parent / 'web' / 'src' / 'viewer' / 'ldraw' / 'attachment-snaps.ts'

MAX_SNAPS = 12
# Stud-grid parts above this footprint are skipped before resolution — a
# 2x4 brick is already 16 connectors, all of them stud stacking.
MAX_STUDS = 6

# Part-description patterns for the families above. Matched against the real
# .dat's own description line (line 1), so a rename in the library cannot
# silently drop a family the way a hand-listed part number would.
WANTED = re.compile(
    r'^(?:'
    r'Minifig\s+(?:Head|Hair|Hat|Helmet|Hood|Cap\b|Headdress|Wig)'
    r'|Bar\s'
    r'|Technic\s+(?:Pin|Axle)\b'
    r'|Brick\s+\d+\s*x\s*\d+\s*$'
    r'|Plate\s+\d+\s*x\s*\d+\s*$'
    r'|Tile\s+\d+\s*x\s*\d+\s*$'
    r')', re.I)
SIZE = re.compile(r'(\d+)\s*x\s*(\d+)')

# Clip / bar-holder plates whose clip snap lives in a SUBPART, so they have no
# shadow file of their own and the SNAP_CLP scan cannot find them. These are the
# high-frequency SNOT connectors; verified present in the local library.
EXTRA_PARTS = [
    '4085', '4085a', '4085b', '4085c', '4085d',   # Plate 1x1 with clip vertical
    '6019',                                       # Plate 1x1 with clip horizontal
    '2555',                                       # Tile 1x1 with clip
    '15712', '60897', '61252', '11458',           # 1x1 clip variants / holders
    '48729', '4081', '4081a', '4081b',            # bar holders / clip light
    '30162', '30374', '3957', '3957a',            # bars / antennas
    '2780', '6558', '4274', '32556', '43093',     # Technic pins
    '3700', '3701', '3702', '32316', '41677',     # Technic pin holes / liftarms
]


def description(stem: str) -> str:
    txt = L.get_dat(stem + '.dat')
    if not txt:
        return ''
    first = txt.splitlines()[0] if txt else ''
    return first[2:].strip() if first.startswith('0 ') else first.strip()


def kind_of(k: str) -> str:
    return {'SNAP_CYL': 'cyl', 'SNAP_CLP': 'clp',
            'SNAP_FGR': 'fgr', 'SNAP_GEN': 'gen'}.get(k, 'gen')


def norm_axis(a):
    n = (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) ** 0.5
    return [0.0, 1.0, 0.0] if n < 1e-6 else [a[0] / n, a[1] / n, a[2] / n]


def candidates() -> dict[str, str]:
    """stem -> selection rule, for every part this run will try to resolve."""
    out: dict[str, str] = {}
    # rule 1: shadow files that declare a clip snap directly
    for name, raw in L._shadow.items():
        if name.endswith('.dat') and 'SNAP_CLP' in raw:
            out.setdefault(name.split('/')[-1][:-4], 'clip')
    # rule 2: curated clip/bar/pin parts whose clip lives in a subpart
    for stem in EXTRA_PARTS:
        if L.get_dat(stem + '.dat'):
            out.setdefault(stem, 'extra')
    # rules 3-5: description match over the REAL part library
    pdir = Path(L.LDLIB) / 'parts'
    for f in sorted(pdir.glob('*.dat')):
        stem = f.stem
        if stem in out:
            continue
        desc = description(stem)
        if not WANTED.match(desc):
            continue
        m = SIZE.search(desc)
        if m and int(m.group(1)) * int(m.group(2)) > MAX_STUDS:
            continue
        out[stem] = 'desc'
    return out


def main() -> None:
    table: dict[str, list[dict]] = {}
    skipped_big = 0
    reasons: dict[str, int] = {}
    for stem, why in sorted(candidates().items()):
        try:
            cons = L.resolve_connectors(stem + '.dat')
        except Exception as e:                       # noqa: BLE001 — report, skip
            print(f'  skip {stem}: {e}')
            continue
        if not cons:
            continue
        if len(cons) > MAX_SNAPS:
            skipped_big += 1
            continue
        rows = []
        for c in cons:
            ax = norm_axis(c['axis'])
            rows.append({
                'k': kind_of(c['k']),
                'g': c['g'] if c['g'] in ('M', 'F') else 'X',
                'r': round(float(c['r']), 1),
                'p': [round(float(v), 2) for v in c['pos']],
                'a': [round(v, 4) for v in ax],
            })
        table[stem] = rows
        reasons[why] = reasons.get(why, 0) + 1

    # Drop printed/decorated variants that resolve to exactly their base part's
    # connectors — the browser lookup already falls back to the base name, so
    # '3626bp01' next to an identical '3626b' is pure payload. (Measured: this
    # is most of the description-matched rows, minifig heads especially.)
    n_before = len(table)
    for stem in sorted(table, key=len, reverse=True):
        for cand in L.base_candidates(stem + '.dat')[1:]:
            base = cand[:-4]
            if base != stem and table.get(base) == table[stem]:
                del table[stem]
                break
    n_variant_dedup = n_before - len(table)

    body = '\n'.join(
        f"  '{stem}': [" + ', '.join(
            "{{k:'{k}',g:'{g}',r:{r},p:[{p}],a:[{a}]}}".format(
                k=r['k'], g=r['g'], r=r['r'],
                p=','.join(str(v) for v in r['p']),
                a=','.join(str(v) for v in r['a']))
            for r in rows) + '],'
        for stem, rows in sorted(table.items()))

    n_snaps = sum(len(v) for v in table.values())
    header = f'''/**
 * GENERATED by scripts/gen-attachment-snaps.py — do not edit by hand.
 *
 * Attachment metadata (LEGO connection points) resolved from the LDCad shadow
 * library, for the joint families the viewer's surface-contact audit is blind
 * to: clips on bars, pins in holes, and anything worn on a minifig head.
 *
 * Coverage is DELIBERATELY partial — {len(table)} parts, {n_snaps} connectors:
 * every clip-bearing part in the shadow library, plus bars/pins/axles, minifig
 * heads and headgear, and the plain brick/plate/tile stud families. Parts with
 * more than {MAX_SNAPS} connectors are omitted (a large baseplate's stud grid is a
 * joint surface contact never misses). `auditConnectivity` therefore REPORTS
 * how many pieces the table covered rather than implying it is complete.
 *
 * Coordinates are part-local LDU in the part's own frame (+Y down, LDraw
 * convention), so a placed brick's world snap = rot * p + pos.
 */
'''
    ts = header + f'''
/** Connector family, straight from LDCad: cylinder, clip, finger, generic. */
export type SnapKind = 'cyl' | 'clp' | 'fgr' | 'gen';

export interface SnapPoint {{
  /** connector family */
  k: SnapKind;
  /** 'M' male / 'F' female / 'X' genderless (clips, fingers) */
  g: 'M' | 'F' | 'X';
  /** nominal radius in LDU (0 for genderless kinds) */
  r: number;
  /** part-local position [x, y, z] in LDU */
  p: readonly [number, number, number];
  /** part-local unit axis [x, y, z] */
  a: readonly [number, number, number];
}}

export const ATTACHMENT_SNAPS: Readonly<Record<string, readonly SnapPoint[]>> = {{
{body}
}} as unknown as Readonly<Record<string, readonly SnapPoint[]>>;

/** Number of parts / connectors in the table (reported by the audit). */
export const SNAP_TABLE_PARTS = {len(table)};
export const SNAP_TABLE_CONNECTORS = {n_snaps};
'''
    OUT.write_text(ts, encoding='utf-8', newline='\n')
    print(f'parts: {len(table)}  connectors: {n_snaps}  '
          f'(by rule: {json.dumps(reasons)}; skipped >{MAX_SNAPS} snaps: '
          f'{skipped_big}; base-identical variants dropped: {n_variant_dedup})')
    print(f'wrote {OUT}  ({OUT.stat().st_size / 1024:.1f} KB)')


if __name__ == '__main__':
    main()
