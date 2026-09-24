#!/usr/bin/env python3
"""
Generate web/public/ldd-part-map.json from BrickLink Studio's ldraw.xml.

Maps an LDD/LXFML designID → the correct LDraw part filename PLUS the
per-part origin-alignment transform (axis-angle rotation + translation in
LDD units) that aligns the LDraw part origin onto the LDD part origin.

This is the data the .lxf loader needs to place parts correctly (issue #108).
Angle is stored verbatim in RADIANS (the XML's angle values are radians, e.g.
1.570796 = pi/2 — do NOT deg->rad convert them).

Output shape (compact, arrays not objects to keep file small):
  { "<designID>": ["<ldrawFile>", tx, ty, tz, angle, ax, ay, az], ... }

SECOND SOURCE — `ldraw_lxfv56.xml`. Studio ships a second, larger mapping
beside `ldraw.xml` (5,406 design ids against 4,390; 1,007 of them appear ONLY
there). It is what Studio itself uses to import an LXF, and it is where the
coaster moulds `25059`, `26560`, `26561`, `80562` and `80566` live — none of
which `ldraw.xml` names. Without them a coaster track built from an LXFML
placed those moulds at their raw LDD origins and routed nothing: 42703 Mermaid
Roller Coaster Ride showed 12 track pieces as 10 disconnected components and
one 55.5-stud open route, while the SAME bones through these rows close a
220.3-stud circuit with every one of its 24 joins inside 0.74 LDU (measured
2026-09-23; 31142, 60421 and 60501 close the same way).

The fill-in is deliberately narrow:
  * only design ids that NEITHER `ldraw.xml` nor the measured table
    (`ldd-measured-align.json`) names — today those place at identity, and a
    real Studio row cannot be worse than no row. Ids the measured table
    already covers (451 of them, ~133k corpus placements) are left on it
    until a GEO comparison (`scripts/lxf_gt_eval.py`) says which is better.
  * only rows whose LDraw file the upstream library (what the viewer draws)
    actually ships; a row naming a file that cannot load is no better than
    the bare `<designID>.dat` fallback it would replace.
  * rows naming Studio's `bl_*.dat` custom parts are NOT copied: the viewer
    has no such file. The ones measured against the upstream part of the same
    number are re-expressed on that part in `BL_UPSTREAM_ROWS` below.
"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

XML = Path(r'C:\git\clego\extracted\studio_release\app\data\ldraw.xml')
XML_LXFV56 = Path(r'C:\git\clego\extracted\studio_release\app\data\ldraw_lxfv56.xml')
# Repo-relative, so a run from a git worktree writes that worktree's table and
# not the main checkout's.
REPO = Path(__file__).resolve().parent.parent
MEASURED = REPO / 'web' / 'public' / 'ldd-measured-align.json'
UPSTREAM_PART_DIRS = (
    Path(r'C:\git\clego\ldraw_ref\official\parts'),
    Path(r'C:\git\clego\ldraw_ref\unofficial\parts'),
)
OUT = REPO / 'web' / 'public' / 'ldd-part-map.json'

# A Studio row that is the BARE IDENTITY is overridden by the measured table
# when the measured row is a pure translation of at least MIN_LDU, backed by at
# least MIN_VOTES placements. Studio writes identity for a handful of moulds
# whose LDD origin plainly is not the LDraw one. The case that found it,
# 21229 "Fence Spindled 4 x 4 x 2 Quarter Round with 3 Studs": Studio says
# identity, so 76417's two black tower-balcony railings hung 48 LDU low and
# 70 LDU out from the round tower and read on the device as two black shapes
# floating in the air beside it (2026-09-24). Two independent sources agree on
# the real correction: the measured table's (-10, -48, 70) LDU from 16 votes,
# and Studio's OWN row for 30056 (the same fence without studs, which 21229.dat
# includes at identity as `s\30056s01.dat`): (0.4, -1.92, 2.8) LDD units =
# (-10, -48, 70) LDU. 37352 (Brick 1 x 2 curved top) is the same shape of
# fault: identity in Studio, (10, -24, 0) LDU from 488 votes = Studio's own
# 3004 (Brick 1 x 2) row. The rule found exactly four ids on 2026-09-24
# (21229, 37352, 18838 Arch 1 x 12 x 3, 40066 Door 1 x 6 x 7 Arch); the first
# two are cross-checked as above, the last two rest on the vote alone.
IDENTITY_OVERRIDE_MIN_VOTES = 5
IDENTITY_OVERRIDE_MIN_LDU = 20.0
# measured rows are [file, r00..r22, tx, ty, tz (LDU, LDraw basis), votes, rms];
# a Studio row's translation is in LDD units with X reversed: (-x, y, z) / 25
# (3001: measured (30, -24, 10) LDU == Studio (-1.2, -0.96, 0.4)).
LDU_PER_LDD = 25.0

# `ldraw_lxfv56.xml` rows that name a Studio-only `bl_<n>.dat`, re-expressed on
# upstream `<n>.dat`. A bl mesh is the upstream mesh in another frame,
# `bl_local = upstream_local + t_bl` (LDU, LDraw basis, no turn), so the row's
# translation becomes `t_align - F . t_bl / 25` with F = diag(1, -1, -1).
#
#   80566  Studio row (bl_80566.dat, angle 0, t = 3.72, 0.0368, 16.42224);
#          t_bl = (-137.0, -80.9, -420.6) from a vertex-cloud fit of
#          bl_80566.dat against unofficial 80566.dat (SHA-256 30e4453c; bbox
#          corners agree to 0.3 LDU, identity rotation, no other candidate
#          under 96 LDU rms) and refined to the stud grid by the ten 80566
#          joins of 42703, which land within 0.01 LDU on this row.
# Design ids NEITHER Studio table names, mapped by hand onto the LDraw mould
# they share, each with its evidence. Added only when neither table has a row.
#
#   68498  Minifig hair swept back with moulded goblin/elf ears (76417's five
#          goblins). Brickset `design-68498` names base mould 26563, which
#          library.ldraw.org files as the 93230 family (`93230p03.dat`);
#          Studio maps LDD 93230 -> 93230.dat at identity. The ear colour
#          picks the pattern file in lxf-parser.ts `DUAL_MATERIAL_PATTERNS`.
# Studio rows that substitute a DIFFERENT-SHAPED part, refused (same list as
# clego reconvert_dbix.py SUBSTITUTE_DENYLIST). 77083 is a "Grille Bar
# 1 x 4 x 1 2/3 Bull Bar, Squared" (a coaster lap bar); Studio draws it as
# 20309, a solid half-round window, which showed on 42703's cars as black "D"
# shapes on the device (2026-09-24). TODO: author an LDraw part for 77083.
SUBSTITUTE_DENYLIST = {'77083'}

CURATED_ROWS: dict[str, list] = {
    '68498': ['93230.dat', 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
}

BL_UPSTREAM_ROWS: dict[str, list] = {
    '80566': ['80566.dat', 9.2, -3.2, -0.4, 0.0, 1.0, 0.0, 0.0],
}


def r(v: float) -> float:
    """Round to 6 sig-ish places, collapse -0.0 → 0, drop trailing noise."""
    x = round(float(v), 6)
    return 0.0 if x == 0 else x


def upstream_part_names() -> set[str]:
    """Lower-cased file names the upstream library ships (what the viewer can draw)."""
    names: set[str] = set()
    for d in UPSTREAM_PART_DIRS:
        names.update(p.name.lower() for p in d.glob('*.dat'))
    return names


def _row_key(child: ET.Element) -> tuple:
    """What a row places: the LDraw file and its alignment, colour aside."""
    return tuple(child.get(k, '') for k in ('ldraw', 'tx', 'ty', 'tz', 'angle', 'ax', 'ay', 'az'))


def lxfv56_rows() -> list[ET.Element]:
    """One usable `Transformation` row per design id from `ldraw_lxfv56.xml`.

    A row's `type` is either empty (the colour-independent row) or a numeric
    LDD MATERIAL id: `80133` has three identical rows for materials 21, 24 and
    5 (red, yellow, tan), all naming `2430.dat` at the same alignment. Reading
    only untyped rows dropped 95 design ids that Studio names solely through
    material rows (measured 2026-09-23; `77083` -> `20309`, `80133` -> `2430`
    in 42703 and 76417 among them). An untyped row wins; otherwise the
    material rows are used only when every one places the same file at the
    same alignment, since a colour-dependent mould cannot be one map entry.
    `to_lego` rows are the reverse direction and are skipped.
    """
    # Every untyped row is kept in file order: the caller's first-usable-wins
    # rule may skip an early row (a `bl_*` name, a file upstream lacks) and
    # take a later one for the same id.
    untyped: list[ET.Element] = []
    untyped_ids: set[str] = set()
    typed: dict[str, list[ET.Element]] = {}
    for child in ET.parse(XML_LXFV56).getroot():
        if child.tag != 'Transformation':
            continue
        lego = (child.get('lego') or '').strip()
        kind = child.get('type', '')
        if not kind:
            untyped.append(child)
            untyped_ids.add(lego)
        elif kind.isdigit():
            typed.setdefault(lego, []).append(child)
    material_only = [group[0] for lego, group in typed.items()
                     if lego not in untyped_ids and len({_row_key(c) for c in group}) == 1]
    return untyped + material_only


# TODO: `ldraw_lxfv56.xml` also names two ids only through `Assembly` rows that
# are not reverse (`to_lego`): 76138 -> 41838.dat and 1927 -> 2429c01.dat (the
# hinge whose halves 80133/80134 ARE mapped above as parts). Assembly rows
# carry no alignment, so copying them at identity is a guess; measure one
# against a model that places the id as a Part before adding them.
def fill_from_lxfv56(part_map: dict[str, list]) -> tuple[int, int, int, int]:
    """Add `ldraw_lxfv56.xml` rows for design ids no shipped table names.

    Returns (filled, skipped: on measured table, skipped: bl_* name, skipped:
    file missing upstream). `BL_UPSTREAM_ROWS` are added under the same
    "neither table names it" rule.
    """
    measured = json.loads(MEASURED.read_text(encoding='utf-8'))
    measured_ids = set(measured.get('entries', measured))
    upstream = upstream_part_names()
    filled = skipped_measured = skipped_bl = skipped_missing = 0
    for child in lxfv56_rows():
        lego = (child.get('lego') or '').strip()
        ldraw = child.get('ldraw', '')
        if not (lego and ldraw) or lego in part_map:
            continue
        if lego in measured_ids:
            skipped_measured += 1
            continue
        if ldraw.lower().startswith('bl_'):
            if lego in BL_UPSTREAM_ROWS:
                part_map[lego] = list(BL_UPSTREAM_ROWS[lego])
                filled += 1
            else:
                skipped_bl += 1
            continue
        if ldraw.lower() not in upstream:
            skipped_missing += 1
            continue
        try:
            tx = r(child.get('tx', 0)); ty = r(child.get('ty', 0)); tz = r(child.get('tz', 0))
            angle = r(child.get('angle', 0))
            ax = r(child.get('ax', 1)); ay = r(child.get('ay', 0)); az = r(child.get('az', 0))
        except ValueError:
            continue
        part_map[lego] = [ldraw, tx, ty, tz, angle, ax, ay, az]
        filled += 1
    return filled, skipped_measured, skipped_bl, skipped_missing


def override_identity_rows(part_map: dict[str, list]) -> list[str]:
    """Replace bare-identity Studio rows the measured table contradicts (see
    IDENTITY_OVERRIDE_MIN_VOTES). Returns the design ids changed."""
    measured = json.loads(MEASURED.read_text(encoding='utf-8'))
    measured = measured.get('entries', measured)
    identity_rot = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    changed: list[str] = []
    for lego, row in part_map.items():
        if any(abs(float(v)) > 1e-9 for v in row[1:5]):
            continue  # a real Studio correction: left to Studio
        m = measured.get(lego)
        if not m or str(m[0]).lower() != str(row[0]).lower():
            continue  # measured against a different LDraw file
        rot, t, votes = [float(v) for v in m[1:10]], [float(v) for v in m[10:13]], int(m[13])
        if any(abs(a - b) > 1e-6 for a, b in zip(rot, identity_rot)):
            continue
        if votes < IDENTITY_OVERRIDE_MIN_VOTES or (t[0] ** 2 + t[1] ** 2 + t[2] ** 2) ** 0.5 < IDENTITY_OVERRIDE_MIN_LDU:
            continue
        part_map[lego] = [row[0], r(-t[0] / LDU_PER_LDD), r(t[1] / LDU_PER_LDD), r(t[2] / LDU_PER_LDD), 0.0, 1.0, 0.0, 0.0]
        changed.append(lego)
    return changed


def main():
    root = ET.parse(XML).getroot()
    part_map: dict[str, list] = {}

    for child in root:
        if child.tag == 'Transformation':
            if child.get('type', '') == 'to_lego':
                continue  # reverse mapping, skip
            lego = child.get('lego', '')
            ldraw = child.get('ldraw', '')
            if not (lego and ldraw):
                continue
            if lego in part_map:
                continue  # first mapping wins
            try:
                tx = r(child.get('tx', 0)); ty = r(child.get('ty', 0)); tz = r(child.get('tz', 0))
                angle = r(child.get('angle', 0))
                ax = r(child.get('ax', 1)); ay = r(child.get('ay', 0)); az = r(child.get('az', 0))
            except ValueError:
                continue
            part_map[lego] = [ldraw, tx, ty, tz, angle, ax, ay, az]

        elif child.tag == 'Assembly':
            lego = child.get('lego', '')
            ldraw = child.get('ldraw', '')
            if lego and ldraw and lego not in part_map:
                part_map[lego] = [ldraw, 0, 0, 0, 0, 1, 0, 0]

    from_ldraw_xml = len(part_map)
    filled, skipped_measured, skipped_bl, skipped_missing = fill_from_lxfv56(part_map)
    for lego in SUBSTITUTE_DENYLIST:
        part_map.pop(lego, None)
    curated = 0
    for lego, row in CURATED_ROWS.items():
        if lego not in part_map:
            part_map[lego] = list(row)
            curated += 1
    print(f'curated rows added: {curated}')
    overridden = override_identity_rows(part_map)
    print(f'identity Studio rows overridden by the measured table: {len(overridden)} {sorted(overridden)}')
    print(f'ldraw.xml: {from_ldraw_xml} rows; ldraw_lxfv56.xml filled {filled} more '
          f'(skipped {skipped_measured} on the measured table, {skipped_bl} bl_* names, '
          f'{skipped_missing} files upstream lacks)')

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(part_map, separators=(',', ':')), encoding='utf-8')
    size_kb = OUT.stat().st_size / 1024
    print(f'Wrote {len(part_map)} part mappings -> {OUT} ({size_kb:.0f} KB)')
    # spot checks
    for k in ('3001', '3049', '60583', '6014'):
        print(f'  {k}: {part_map.get(k)}')


if __name__ == '__main__':
    main()
