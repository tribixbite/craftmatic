"""Put a female anti-stud's reference point back on the part's bottom face.

Page index 20 of 40377 allocates two printed round tiles, `98138pb072`, and the
construction could not place them at any closure depth. The reason is not depth:
against every host tried, the part offers **four legal mates with collision
checking off and zero with it on**. Every mate it has is rejected as an overlap.

The measurement that explains it is exact. LDCad's convention, quoted in
`recon_v8.connectors` itself and verified against two parts, is that a female
anti-stud's reference point sits **on the part's bottom face** - its maximum y -
with the axis pointing out of the part. `3024`'s own shadow record declares
`[gender=F] [pos=0 8 0]` against a bbox of y in [-4, 8], and `s/25269s01`
declares `[gender=F] [caps=one] [secs=R 6 4] [pos=0 8 0]` at identity.

`98138` carries no shadow record of its own and none for its subparts, so its
female is recovered from the primitive reference tree instead: `s/98138s02`
references `stud4o` at translation (0, 4, 0) through the matrix diag(1, -1, 1).
`stud4o`'s bbox is y in [-4, 0], so that reference does put the tube at y in
[4, 8], which is right - but it puts the *primitive's origin*, and therefore the
connector's reference point, at the tube's inner end, y = 4, with the axis
reversed to point back through the part. A stud mating to a point 4 LDU inside
the tile is driven 4 LDU too deep, and the collision test correctly refuses it.

So the record describes the right tube from the wrong end. This module moves it
to the other end, which is a correction with an argument rather than a guess, and
it fires only when that other end is provably the face:

* the record is a female CYL at the anti-stud radius and depth,
* its axis is parallel to y, so an axle bore or a side connector is never
  touched,
* its reference point is *not* on the part's maximum-y face, and
* `pos - axis x length` is on that face, at the same x and z.

Under those four conditions the repaired record for `98138pb072` becomes
`pos = (0, 8, 0)` with the identity orientation - the exact form `s/25269s01`
declares - and the part gains its mates back.

Installed by seeding `recon_v8.assembly._pconn_cache`, so no upstream file is
modified and the change is scoped to the parts a run explicitly asks for. Opt-in
per run. No reference model, set inventory or VLM participates.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, 'C:/git/clego')

# The anti-stud signature, in LDU. A female CYL of another radius or depth is a
# different joint and is left alone.
STUD_RADIUS = 6.0
STUD_DEPTH = 4.0
RADIUS_TOL = 0.51
FACE_TOL = 0.51
AXIS_TOL = 1e-3


def _axis(connector):
    """The connector's mating direction in the part frame.

    The record carries an explicit `axis`, and that is the field
    `recon_v8.assembly.expand_variants` and the candidate generator actually
    read, so it is authoritative; the orientation's +Y column is the fallback
    for a record that predates it. A repair that moved one without the other
    would leave the two disagreeing, which is exactly the 16 LDU discrepancy the
    first attempt produced.
    """
    if connector.get('axis') is not None:
        return np.asarray(connector['axis'], float)
    return np.asarray(connector['ori'], float).reshape(3, 3)[:, 1]


def _flip_axis(ori):
    """The same frame with its +Y column reversed."""
    matrix = np.asarray(ori, float).reshape(3, 3).copy()
    matrix[:, 1] = -matrix[:, 1]
    return [float(v) for v in matrix.flatten()]


def misplaced_anti_stud(connector, bottom_y):
    """Is this record an anti-stud described from its inner end?

    Returns the corrected (position, orientation) or None. `bottom_y` is the
    part's maximum y, which is the face a stud enters through.
    """
    if connector.get('kind') != 'CYL' or connector.get('gender') != 'F':
        return None
    radius = connector.get('radius')
    length = connector.get('length')
    if radius is None or length is None:
        return None
    if abs(float(radius) - STUD_RADIUS) > RADIUS_TOL:
        return None
    if abs(float(length) - STUD_DEPTH) > RADIUS_TOL:
        return None
    position = np.asarray(connector['pos'], float)
    axis = _axis(connector)
    if abs(abs(axis[1]) - 1.0) > AXIS_TOL or abs(axis[0]) > AXIS_TOL or abs(axis[2]) > AXIS_TOL:
        return None
    if abs(position[1] - bottom_y) <= FACE_TOL:
        return None                                # already on the face
    other = position - axis * float(length)
    if abs(other[1] - bottom_y) > FACE_TOL:
        return None                                # the far end is not the face either
    return ([float(v) for v in other], _flip_axis(connector['ori']),
            [float(v) for v in -axis])


def repaired_connectors(part_id, connectors=None, bbox=None):
    """This part's connector list with any inner-end anti-stud moved to the face.

    Returns (records, repairs); `repairs` is empty when nothing applied, and the
    records are then the originals unchanged.
    """
    from recon_v8.connectors import part_bbox, part_connectors
    if connectors is None:
        connectors = part_connectors(str(part_id).lower().replace('.dat', ''))
    if bbox is None:
        bbox = part_bbox(str(part_id).lower().replace('.dat', ''))
    bottom_y = float(np.asarray(bbox[1], float)[1])
    records, repairs = [], []
    for connector in connectors:
        correction = misplaced_anti_stud(connector, bottom_y)
        if correction is None:
            records.append(connector)
            continue
        position, ori, axis = correction
        repaired = dict(connector, pos=position, ori=ori, repaired='anti_stud_face',
                        original_pos=[float(v) for v in connector['pos']],
                        original_ori=[float(v) for v in connector['ori']])
        if connector.get('axis') is not None:
            repaired['axis'] = axis
            repaired['original_axis'] = [float(v) for v in np.asarray(connector['axis'], float)]
        records.append(repaired)
        repairs.append(dict(part=str(part_id), kind=connector['kind'],
                            from_pos=[float(v) for v in connector['pos']], to_pos=position,
                            from_axis=[float(v) for v in _axis(connector)], to_axis=axis,
                            bottom_y=bottom_y, radius=float(connector['radius']),
                            length=float(connector['length'])))
    return records, repairs


def install(part_ids):
    """Seed `recon_v8.assembly`'s connector cache with the repaired records.

    Every requested part is seeded, repaired or not, so the cache cannot later be
    filled from the unrepaired path for one of them. Returns the audit record.
    """
    from recon_v8 import assembly
    audit, seeded = [], []
    for part in dict.fromkeys(str(p).lower().replace('.dat', '') for p in part_ids):
        try:
            records, repairs = repaired_connectors(part)
        except Exception as exc:                                            # noqa: BLE001
            audit.append(dict(part=part, status='unavailable', error=f'{type(exc).__name__}: {exc}'))
            continue
        assembly._pconn_cache[part] = assembly.expand_variants(records)
        seeded.append(part)
        audit.extend(repairs)
    return dict(seeded=seeded, repairs=[row for row in audit if 'to_pos' in row],
                unavailable=[row for row in audit if row.get('status') == 'unavailable'],
                radius_ldu=STUD_RADIUS, depth_ldu=STUD_DEPTH, face_tolerance_ldu=FACE_TOL,
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol="A female CYL at the anti-stud radius and depth, with its axis parallel "
                         "to y, whose reference point is not on the part's maximum-y face while "
                         "the opposite end of the same tube is, is that tube described from its "
                         "inner end; it is moved to the face and its axis reversed",
                limitations='A correction to connector metadata, not to geometry: it changes which '
                            'mates are enumerated, and a part whose real joint genuinely sits off '
                            'the bottom face at the anti-stud radius and depth would be moved '
                            'wrongly. It is applied only to the parts a run asks for, and every '
                            'change is recorded.')


if __name__ == '__main__':
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument('parts', nargs='+', help='Part ids to audit')
    parser.add_argument('--out', type=Path)
    arguments = parser.parse_args()
    report = install(arguments.parts)
    if arguments.out:
        arguments.out.parent.mkdir(parents=True, exist_ok=True)
        arguments.out.write_text(json.dumps(report, indent=2))
    print(json.dumps(dict(seeded=len(report['seeded']), repaired=report['repairs'],
                          unavailable=report['unavailable']), indent=2))
