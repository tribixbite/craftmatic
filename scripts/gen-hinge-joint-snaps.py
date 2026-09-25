#!/usr/bin/env python3
"""gen-hinge-joint-snaps.py — emit the ROTATIONAL connector table the
brick-built hinge detector reads (`web/src/engine/brick-hinges.ts`).

A brick-built door, gate, flap or mechanism moves because it hangs on a joint
that turns: a finger hinge (3937 + 6134, click hinges 44301/60471), a swivel
hinge brick or plate (3830/3831, 2429/2430), a clip on a bar, a turntable, a
Technic pin or axle in a round hole. LDCad's shadow library encodes every one
of those as a connector with a position and an axis, so this script resolves
them once, offline, into a compact table (docs/bedrock-interactivity.md,
"Brick-built doors, gates and mechanisms").

    python scripts/gen-hinge-joint-snaps.py

Reads:  the LDCad shadow library + the local LDraw part library, through the
        resolver in scripts/ldcad_connectivity.py (it walks each part's real
        subfile tree, so a connector defined in a subpart is found).
Writes: web/src/engine/hinge-joint-snaps.ts

SELECTION. Official library parts whose DESCRIPTION names a joint family
(`JOINT_FAMILY`: hinges, clips, bars, handles, turntables, Technic pins and
axles and the bricks, beams and connectors they turn in), keeping only the
connectors that can TURN:
  - SNAP_FGR  finger hinges (both halves carry one; they pair by group);
  - SNAP_CLP  clips (genderless; a clip turns about the bar it grips);
  - SNAP_CYL  cylinders with no STUD section (`S`): a round pin, bar or hole
              (`R`), an axle (`A`), a collar (`_L`). A stud turns in its
              anti-stud too, but a stud joint is how every wall is built, so
              it is never a hinge here.
A part whose rotational connectors number more than MAX_CONNECTORS (a long
Technic beam's row of holes) is left out: it is structure, not a pivot, and
its holes would dominate the table.

Each row is part-local LDU in the part's own frame (+Y down), so a placed
brick's world connector is rot * p + pos, and its axis rot * a.
"""
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import ldcad_connectivity as L  # noqa: E402  (path set above)

OUT = HERE.parent / 'web' / 'src' / 'engine' / 'hinge-joint-snaps.ts'
MAX_CONNECTORS = 12
STUD_PRIMITIVE = re.compile(r'^(stu[dg]|tube)')

JOINT_FAMILY = re.compile(
    r'\b(Hinge|Clip|Clips|Turntable|Bar|Bars|Handle|Swivel|Click|Ladder|'
    r'Technic (Pin|Axle|Brick|Beam|Liftarm|Connector|Bush|Cross Block|Plate)|'
    r'Technic,? (Pin|Axle|Brick|Beam|Liftarm|Connector|Bush|Cross Block|Plate)|'
    r'with (Pin|Pin Hole|Axle Hole|Hole)|Rotor|Propeller)\b', re.I)


def description_of(path: str) -> str:
    """The part's description: its first `0` line, or the SECOND when the first is a `0 FILE` header."""
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            t = line.strip()
            if not t:
                continue
            if not t.startswith('0'):
                return ''
            body = t[1:].strip()
            if body.upper().startswith('FILE '):
                continue
            return body
    return ''


def parse_secs(secs: str):
    """`R 6 14   _L 6.5 2` -> [('R', 6.0, 14.0), ('_L', 6.5, 2.0)]."""
    t = secs.split()
    out = []
    for i in range(0, len(t) - 2, 3):
        try:
            out.append((t[i], float(t[i + 1]), float(t[i + 2])))
        except ValueError:
            pass
    return out


def rotational(name: str):
    """The part's turning connectors in its own frame, from the shadow metas of its whole subfile tree."""
    rows = []

    def walk(n, mat, pos, depth, shadow_only=False):
        if depth > 30:
            return
        # The stud system (studs, anti-stud tubes, stud groups) is how every wall
        # is built: never a hinge. Its primitives are `stud*` / `stug*`.
        if STUD_PRIMITIVE.match(n.lower().replace(chr(92), '/').split('/')[-1]):
            return
        sh = L.shadow_for(n)
        if sh:
            for raw in sh.splitlines():
                line = raw.strip()
                if not line.startswith('0 !LDCAD SNAP_'):
                    continue
                kind = line.split()[2]
                kv = L.parse_kv(line)
                # A grid repeats the snap in its OWN frame (after `ori`): 3701's
                # three holes are one include on a 3 x 1 grid.
                if kind == 'SNAP_INCL' and kv.get('ref'):
                    # A shadow-level include (4085c includes 4085a's clip; 3701 its holes), at its own offsets.
                    ip = [float(x) for x in kv.get('pos', '0 0 0').split()]
                    io = tuple(float(x) for x in kv['ori'].split()) if 'ori' in kv else L.I3
                    for g in (L.expand_grid(kv['grid']) if 'grid' in kv else [(0.0, 0.0, 0.0)]):
                        at = L.vadd(ip, L.mvec(io, g))
                        walk(kv['ref'], L.mmul(mat, io), L.vadd(L.mvec(mat, at), pos), depth + 1, shadow_only=True)
                    continue
                if kind not in ('SNAP_CYL', 'SNAP_CLP', 'SNAP_FGR'):
                    continue
                lp = [float(x) for x in kv.get('pos', '0 0 0').split()]
                lori = tuple(float(x) for x in kv['ori'].split()) if 'ori' in kv else L.I3
                axis_local = L.mvec(lori, (0, 1, 0))
                offsets = [L.mvec(lori, g) for g in L.expand_grid(kv['grid'])] if 'grid' in kv else [(0.0, 0.0, 0.0)]
                if kind == 'SNAP_CYL':
                    secs = parse_secs(kv.get('secs', ''))
                    if not secs or any(s[0].upper() == 'S' for s in secs):
                        continue
                    shapes = ''.join(sorted({'A' if s[0].upper() == 'A' else 'R' for s in secs}))
                    # The radius of the longest section: a bar with a thick stop is a 4 LDU bar.
                    radius = max(secs, key=lambda s: s[2])[1]
                    length = sum(s[2] for s in secs)
                    g = kv.get('gender', '?')[:1].upper()
                    extra = {'s': shapes, 'r': round(radius, 2), 'l': round(length, 2), 'g': g}
                    if kv.get('slide', '').lower() == 'true':
                        extra['sl'] = 1
                    # A centred cylinder straddles its position (a pin, 2780: 20 LDU each way).
                    if kv.get('center', '').lower() == 'true':
                        extra['c'] = 1
                elif kind == 'SNAP_CLP':
                    extra = {'r': float(kv.get('radius', '4') or 4), 'l': float(kv.get('length', '8') or 8), 'g': 'X'}
                    if kv.get('center', '').lower() == 'true':
                        extra['c'] = 1
                else:
                    seq = [float(x) for x in kv.get('seq', '').split()] if kv.get('seq') else []
                    extra = {'l': round(sum(seq), 2), 'g': 'X', 'grp': kv.get('group', '')}
                for (gx, gy, gz) in offsets:
                    p_local = (lp[0] + gx, lp[1] + gy, lp[2] + gz)
                    wp = L.vadd(L.mvec(mat, p_local), pos)
                    wax = L.mvec(mat, axis_local)
                    rows.append({'k': {'SNAP_CYL': 'cyl', 'SNAP_CLP': 'clp', 'SNAP_FGR': 'fgr'}[kind],
                                 'p': [round(v, 2) for v in wp], 'a': [round(v, 4) for v in wax], **extra})
        real = None if shadow_only else L.get_dat(n)
        if real:
            for line in real.splitlines():
                t = line.split()
                if len(t) >= 15 and t[0] == '1':
                    try:
                        x, y, z = float(t[2]), float(t[3]), float(t[4])
                        R = tuple(float(v) for v in t[5:14])
                    except ValueError:
                        continue
                    sub = ' '.join(t[14:]).strip()
                    walk(sub, L.mmul(mat, R), L.vadd(L.mvec(mat, (x, y, z)), pos), depth + 1)

    for cand in L.base_candidates(name):
        walk(cand, L.I3, (0.0, 0.0, 0.0), 0)
        if rows:
            break
    # One connector per (kind, position, axis): LDCad files and their subparts can repeat one.
    seen = set()
    out = []
    for r in rows:
        key = (r['k'], tuple(r['p']), tuple(r['a']), r.get('g'))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def main():
    # Official parts, then Studio's unofficial ones (57360, the click-hinge
    # cylinder, exists only there); an official file wins a name both carry.
    paths = {}
    for sub in ('UnOfficial/parts', 'parts'):
        d = os.path.join(L.LDLIB, sub)
        for f in os.listdir(d):
            if f.lower().endswith('.dat'):
                paths[f.lower()] = os.path.join(d, f)
    names = sorted(paths)
    table = {}
    considered = 0
    for f in names:
        d = description_of(paths[f])
        if not d or not JOINT_FAMILY.search(d) or d.startswith('~') and 'Moved to' in d:
            continue
        considered += 1
        rows = rotational(f)
        if not rows or len(rows) > MAX_CONNECTORS:
            continue
        table[f[:-4].lower()] = rows
    lines = [
        '/**',
        ' * GENERATED by scripts/gen-hinge-joint-snaps.py - do not edit by hand.',
        ' *',
        ' * The connectors that can TURN (finger hinges, clips, round pins, bars,',
        ' * holes, axles, turntable rings), resolved from the LDCad shadow library',
        f' * for {len(table)} parts ({considered} official parts named a joint family).',
        ' * Packed one string per part (`brick-hinges.ts` `jointSnapsOf` unpacks it):',
        ' * connectors split by `;`, each `kind gender shapes radius length px py pz',
        ' * ax ay az flags group`, `-` for an empty field. kind: f finger hinge, c clip,',
        ' * y cylinder; gender M / F / X; shapes R round, A axle; flags S slides, C a',
        " * clip centred on its position. Part-local LDU, +Y down: a placed brick's",
        ' * world connector is rot * p + pos. docs/bedrock-interactivity.md,',
        ' * "Brick-built doors, gates and mechanisms".',
        ' */',
        '',
        'export const HINGE_JOINT_SNAPS: Readonly<Record<string, string>> = {',
    ]

    def fmt(v):
        return '%g' % round(v, 2)

    for k in sorted(table):
        packed = []
        for r in table[k]:
            a = r['a']
            n = (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) ** 0.5 or 1.0
            flags = ('S' if r.get('sl') else '') + ('C' if r.get('c') else '')
            packed.append(' '.join([
                {'fgr': 'f', 'clp': 'c', 'cyl': 'y'}[r['k']], r.get('g', '?') or '?', r.get('s') or '-',
                fmt(r.get('r', 0) or 0), fmt(r.get('l', 0) or 0),
                *[fmt(v) for v in r['p']], *[('%g' % round(v / n, 4)) for v in a],
                flags or '-', r.get('grp') or '-',
            ]))
        lines.append(f"  '{k}': '{';'.join(packed)}',")
    lines.append('};')
    lines.append('')
    OUT.write_text('\n'.join(lines), encoding='utf-8', newline='\n')
    print(f'{len(table)} parts, {sum(len(v) for v in table.values())} connectors ({considered} considered) -> {OUT}')


if __name__ == '__main__':
    main()
