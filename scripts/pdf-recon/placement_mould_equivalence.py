"""Mould variants of one physical part, proven equivalent from universal CAD.

An inventory slot whose element resolves to several LDraw names is refused by
`placement_slot_adapter`, and that refusal is correct as long as the names are
treated as different parts: emitting an arbitrary one would be a guess presented
as fact. On 41601 four of 108 pieces are lost that way
(`15573`/`3794a`/`3794b` and `4032a`/`4032b`), and no drawing and no colour
evidence can separate them - the difference is under-the-plate tube geometry
whose outside is identical.

The principled resolution is an equivalence class, and "equivalent" has to mean
something the pipeline can act on. Two names are **placement-equivalent** when,
at identity and in the pipeline's own representations:

* their 4 LDU collision voxel sets are identical (`dbix_settle.Placement`, the
  set `Assembly.collision` intersects),
* their eroded solid cores are identical (the core the collision predicate uses
  for the deep-overlap test),
* their connector sets are identical up to position, orientation, kind, gender
  and radius (`recon_v8.assembly.part_conns`, what `Assembly.candidates`
  enumerates mates from),
* and their universal CAD bounding boxes agree within `tolerance` LDU.

Under those four, `candidates` and `collides` return the same thing for either
name at every pose on every body, so the search provably cannot distinguish
them: the class is one search candidate with several legal names, and one
capacity pool.

When the voxels or connectors *differ*, the class is still an inventory fact -
one physical piece, one count - but not a search identity, and this module says
so rather than pooling them anyway. That is the whole disposition: the capacity
pool merges on the element (`shares_capacity_pool`), and the search identity
merges only on proven geometric identity (`placement_equivalent`).

Printed moulds are never pooled: a decoration is visible, and two names that
differ by a print are different parts to a drawing as well as to a reader.

No reference model, set inventory or VLM participates. The geometry is universal
CAD read through `placement_part_library`.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, 'C:/git/clego')

from placement_part_library import PartLibrary  # noqa: E402

# The memo's own statement of the class is a bounding-box agreement, so the
# tolerance is stated rather than implied. LDraw's curved primitives are not
# exactly symmetric and this is the same tolerance the mirror proofs use.
TOLERANCE_LDU = 0.01
# A printed decoration is external evidence; two names differing by one are not
# one piece however their tubes compare.
PRINT_MARKERS = ('pb', 'pr', 'pz', 'ps', 'pat', 'stickered')


def looks_printed(part):
    stem = str(part).lower()
    return any(marker in stem for marker in PRINT_MARKERS)


def geometry(part, library=None):
    """The four pipeline representations of one part at identity."""
    from dbix_settle import Placement, part_points
    from recon_v8.assembly import erode, part_conns
    library = library or PartLibrary()
    path = library.resolve(part)
    points = np.asarray(part_points(str(part).lower()), float)
    placement = Placement(0, str(part).lower().replace('.dat', ''),
                          tuple(np.eye(3).flatten()), (0., 0., 0.))
    voxels = placement.voxels()
    connectors = []
    for connector in part_conns(part):
        connectors.append((connector.get('kind'), connector.get('gender'),
                           tuple(np.round(np.asarray(connector.get('pos'), float), 4)),
                           tuple(np.round(np.asarray(connector.get('ori'),
                                                     float).flatten(), 4))
                           if connector.get('ori') is not None else None,
                           round(float(connector.get('radius') or 0.), 4),
                           round(float(connector.get('r_end') or 0.), 4),
                           connector.get('gid')))
    return dict(part=str(part), file=str(path),
                sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                points=len(points),
                bounds=[points.min(0).tolist(), points.max(0).tolist()] if len(points) else None,
                voxels=voxels, core=erode(voxels), connectors=sorted(connectors, key=repr),
                printed=looks_printed(part))


def compare(names, tolerance=TOLERANCE_LDU, library=None):
    """Is this set of names one physical part, and is it one search candidate?"""
    library = library or PartLibrary()
    records = [geometry(name, library) for name in names]
    first = records[0]
    bounds_agree = all(
        record['bounds'] is not None and first['bounds'] is not None
        and np.max(np.abs(np.asarray(record['bounds']) - np.asarray(first['bounds']))) <= tolerance
        for record in records)
    voxels_agree = all(record['voxels'] == first['voxels'] for record in records)
    cores_agree = all(record['core'] == first['core'] for record in records)
    connectors_agree = all(record['connectors'] == first['connectors'] for record in records)
    printed = any(record['printed'] for record in records)
    equivalent = bool(bounds_agree and voxels_agree and cores_agree and connectors_agree
                      and not printed)
    return dict(
        members=[record['part'] for record in records],
        canonical=sorted(record['part'] for record in records)[0],
        bounds_agree=bool(bounds_agree), bounds=[record['bounds'] for record in records],
        bounds_max_difference_ldu=float(max(
            np.max(np.abs(np.asarray(record['bounds']) - np.asarray(first['bounds'])))
            for record in records)) if bounds_agree or all(
                record['bounds'] for record in records) else None,
        voxels_agree=bool(voxels_agree),
        voxel_counts=[len(record['voxels']) for record in records],
        voxel_symmetric_differences=[len(record['voxels'] ^ first['voxels'])
                                     for record in records],
        cores_agree=bool(cores_agree), core_counts=[len(record['core']) for record in records],
        connectors_agree=bool(connectors_agree),
        connector_counts=[len(record['connectors']) for record in records],
        surface_points=[record['points'] for record in records],
        printed_member=printed,
        placement_equivalent=equivalent,
        shares_capacity_pool=bool(bounds_agree and not printed),
        provenance=[dict(part=record['part'], file=record['file'], sha256=record['sha256'])
                    for record in records],
        tolerance_ldu=tolerance,
        disposition=('One search candidate and one capacity pool: every pipeline predicate is '
                     'identical for these names' if equivalent else
                     'One capacity pool only: the names share an external footprint but not every '
                     'pipeline predicate, so the search must keep them distinct'
                     if bounds_agree and not printed else
                     'Not one piece: the members differ externally or by a print'))


def ambiguous_classes(slot_assignment, tolerance=TOLERANCE_LDU, library=None):
    """Every ambiguous inventory slot of a set, tested as a class."""
    payload = json.loads(Path(slot_assignment).read_text())
    if payload.get('truth_used') is not False:
        raise ValueError('Inventory provenance lacks truth-free declaration')
    library = library or PartLibrary()
    classes, seen = [], set()
    for slot in payload['slots']:
        names = sorted({choice['part'] for choice in slot['choices']})
        colors = sorted({int(choice['color']) for choice in slot['choices']})
        if len(names) < 2:
            continue
        signature = (tuple(names), tuple(colors))
        if signature in seen:
            continue
        seen.add(signature)
        record = compare(names, tolerance, library)
        record.update(inventory_record=slot.get('inventory_record'),
                      element_id=slot.get('element_id'), qty=int(slot['qty']),
                      colors=colors,
                      colors_agree=len(colors) == 1)
        classes.append(record)
    return dict(source=str(slot_assignment), classes=classes,
                pieces_in_ambiguous_slots=int(sum(entry['qty'] for entry in classes)),
                recoverable_pieces=int(sum(entry['qty'] for entry in classes
                                           if entry['shares_capacity_pool']
                                           and entry['colors_agree'])),
                search_identical_pieces=int(sum(entry['qty'] for entry in classes
                                                if entry['placement_equivalent']
                                                and entry['colors_agree'])),
                tolerance_ldu=tolerance, truth_used=False, certified=False,
                limitations=['Equivalence is proven at identity; the predicates are pose-invariant '
                             'because both the voxel set and the connector set transform with the '
                             'part',
                             'A class that shares a capacity pool without being placement '
                             'equivalent still needs the search to enumerate every member'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('parts', nargs='*', help='Names to test as one class')
    parser.add_argument('--slots', help='Test every ambiguous slot of a slot assignment')
    parser.add_argument('--tolerance', type=float, default=TOLERANCE_LDU)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    library = PartLibrary()
    payload = dict(tolerance_ldu=args.tolerance, truth_used=False, certified=False, classes=[])
    if args.parts:
        payload['classes'].append(compare(args.parts, args.tolerance, library))
    if args.slots:
        found = ambiguous_classes(args.slots, args.tolerance, library)
        payload['slots'] = {key: value for key, value in found.items() if key != 'classes'}
        payload['classes'].extend(found['classes'])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, default=str))
    print(json.dumps([dict(members=entry['members'], bounds_agree=entry['bounds_agree'],
                           voxels_agree=entry['voxels_agree'],
                           connectors_agree=entry['connectors_agree'],
                           placement_equivalent=entry['placement_equivalent'],
                           shares_capacity_pool=entry['shares_capacity_pool'])
                      for entry in payload['classes']], indent=2))


if __name__ == '__main__':
    main()
