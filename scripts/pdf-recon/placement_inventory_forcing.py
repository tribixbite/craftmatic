"""Can a page's allocation force a placement when the drawing cannot decide it?

The forcing rule proposed for round six: when a page's allocation leaves exactly
one piece, and the legal-mate enumeration offers exactly one collision-legal,
connector-engaged region for it, place it there whatever the drawing shows. That
would convert the visibility class outright, because it never asks the drawing.

The rule is only as good as its premise, and the premise is measurable from the
run's own artifacts. This counts, for every driven page, how many distinct
stud-scale locations the page's own enumerated bank offers each allocated piece,
and whether the reference pose is at one of them.

Two things the measurement had to be corrected for, both recorded because each
one on its own produces a confident wrong answer:

* **Single-linkage clustering chains.** On a dense LEGO body every candidate
  position is within one stud of another, so the whole bank collapses into one
  "region" and six of twenty allocated identities read as forced. They are not.
  The count used is the number of occupied cells of a one-stud lattice, which
  cannot chain; the chained number is still reported beside it as the control.
* **Collision and base engagement are not the filters they look like.** The
  collision test rejects nothing at all - `legal` equals `bank` on every page,
  because the enumeration already screened it. And requiring at least one
  connector engaged *with the base* is wrong rather than expensive: a sample of
  twelve poses per identity finds engagement 0 on nineteen of twenty identities,
  because closure also enumerates poses that mate with a sibling addition rather
  than with the base. Filtering on it would discard legitimate stacked poses.

Evaluation-only. The enumeration is the run's own; the reference model is read
afterwards to say whether a surviving location was right.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def cluster_positions(positions, radius):
    """Single-linkage clusters of 3D positions, as index lists.

    Reported for completeness and *not* used as the forcing count. Single linkage
    chains: on a dense LEGO body every candidate position is within one stud of
    another, so the whole bank collapses to one cluster - 40377 page 16's 8,192
    poses come back as a single "region", which reads as a forced placement and
    is nothing of the sort.
    """
    if not len(positions):
        return []
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import pdist
    if len(positions) == 1:
        return [[0]]
    labels = fcluster(linkage(pdist(np.asarray(positions, float)), method='single'),
                      t=radius, criterion='distance')
    groups = {}
    for index, label in enumerate(labels):
        groups.setdefault(int(label), []).append(index)
    return [sorted(members) for _, members in sorted(groups.items())]


def grid_cells(positions, radius):
    """Distinct occupied cells of a `radius`-LDU lattice, as index lists.

    The non-chaining reading of "how many places could this piece go": two
    candidates in the same cell are the same stud-scale location, and two in
    different cells are genuinely different ones.
    """
    cells = {}
    for index, position in enumerate(positions):
        cells.setdefault(tuple(np.round(np.asarray(position, float) / radius).astype(int)),
                         []).append(index)
    return [members for _, members in sorted(cells.items())]


def page_regions(run, page, truth, library, symmetries, radius=20.0, position_tolerance=1.0,
                 engagement_sample=12):
    from placement_arrow_contacts import read_items
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import frames_equal
    from placement_part_symmetry_table import symmetries as proper_symmetries
    from placement_population_table import canonical_name
    from placement_seated_contact import engaged_mates
    from pose_score import read_parts
    from recon_v8.assembly import Assembly
    step = Path(run) / f'page-{page:03d}'
    registry = json.loads((step / 'registry-00.json').read_text())
    if registry.get('truth_used') is not False or registry.get('runtime_vlm_calls') != 0:
        raise ValueError('Registry provenance lacks truth-free zero-VLM attestation')
    base_source = Path(registry['base_source'])
    base_items, _ = canonicalize(read_parts(base_source), library)
    recall = bank_recall(registry, truth, base_items, symmetries=symmetries)
    base = [(canonical_name(part, library), int(color), np.asarray(T, float))
            for part, color, T in read_items(base_source)]
    assembly = Assembly()
    for part, color, T in base:
        assembly.add(part, color, T)
    allocation = {}
    for part, color in registry['allocated_pieces']:
        key = (canonical_name(part, library), int(color))
        allocation[key] = allocation.get(key, 0) + 1
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    targets = [dict(part=entry['part'], color=int(entry['color']),
                    truth_index=entry['truth_index'],
                    position=inverse @ np.asarray(entry['reference_position'], float) + offset,
                    frame=inverse @ np.asarray(entry['reference_frame'], float))
               for entry in recall['rows']]
    pieces = []
    for (part, color), quota in sorted(allocation.items()):
        poses = [np.asarray(entry['T'], float) for entry in registry['poses']
                 if canonical_name(entry['part'], library) == part]
        # The collision test is kept because it is the run's own physical gate,
        # even though it turns out to reject nothing. Base engagement is sampled
        # rather than applied: this was written expecting every closure pose to
        # mate with the base, and the sample says otherwise, so the assumption is
        # recorded as refuted instead of being used as a filter.
        legal = [T for T in poses if not assembly.collides(part, T)]
        sample = legal[::max(1, len(legal) // engagement_sample)][:engagement_sample]
        engagement = [engaged_mates(base, [(part, color, T)])['engaged'] for T in sample]
        positions = [T[:3, 3] for T in legal]
        regions = cluster_positions(positions, radius)
        cells = grid_cells(positions, radius)
        symmetry = proper_symmetries(part, 'vertex')
        mine = [target for target in targets
                if target['part'] == part and target['color'] == color]
        hit_regions, hit_cells = set(), set()
        for groups, hits in ((regions, hit_regions), (cells, hit_cells)):
            for index, group in enumerate(groups):
                for member in group:
                    T = legal[member]
                    for target in mine:
                        if np.max(np.abs(T[:3, 3] - target['position'])) > position_tolerance:
                            continue
                        if frames_equal(T[:3, :3], target['frame'], symmetry):
                            hits.add(index)
        pieces.append(dict(part=part, color=color, quota=quota, bank_poses=len(poses),
                           legal_poses=len(legal), regions=len(regions),
                           engagement_sample=len(engagement),
                           engagement_sample_min=min(engagement) if engagement else None,
                           reference_targets=len(mine),
                           regions_holding_a_reference_pose=sorted(hit_regions),
                           cells=len(cells), cells_holding_a_reference_pose=sorted(hit_cells),
                           forced=len(cells) == quota,
                           forced_correct=len(cells) == quota and len(hit_cells) == quota,
                           chained_regions_forced=len(regions) == quota,
                           region_sizes=[len(region) for region in regions]))
    return dict(page=page, base_parts=len(base), allocated_identities=len(allocation),
                allocated_pieces=sum(allocation.values()), pieces=pieces)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--region', type=float, default=20.0,
                        help='Single-linkage radius in LDU; 20 is one stud')
    args = parser.parse_args()
    from placement_diagnose_alias_poses import canonicalize
    from placement_part_library import PartLibrary
    from placement_part_symmetry_table import symmetries as part_symmetries
    from pose_score import read_parts
    journal = json.loads((args.run / 'autodrive.json').read_text())
    if journal.get('truth_used') is not False or journal.get('runtime_vlm_calls') != 0:
        raise ValueError('Run journal lacks truth-free zero-VLM attestation')
    library = PartLibrary()
    truth, _ = canonicalize(read_parts(args.truth), library)
    names = {str(part) for part, *_ in truth}
    rows = []
    for step in journal['steps']:
        if not step.get('placement'):
            continue
        registry = json.loads((args.run / f"page-{step['page']:03d}" /
                               'registry-00.json').read_text())
        wanted = names | {str(entry['part']) for entry in registry['poses']}
        symmetries = {part: list(part_symmetries(part, 'vertex')) for part in wanted}
        rows.append(page_regions(args.run, step['page'], truth, library, symmetries, args.region))
    pieces = [piece for row in rows for piece in row['pieces']]
    totals = dict(pages=len(rows), allocated_identities=len(pieces),
                  single_piece_identities=sum(1 for piece in pieces if piece['quota'] == 1),
                  forced=sum(1 for piece in pieces if piece['forced']),
                  forced_correct=sum(1 for piece in pieces if piece['forced_correct']),
                  median_cells=(float(np.median([piece['cells'] for piece in pieces]))
                                if pieces else None),
                  cells_min=min((piece['cells'] for piece in pieces), default=None),
                  cells_max=max((piece['cells'] for piece in pieces), default=None),
                  chained_regions_forced=sum(1 for piece in pieces
                                             if piece['chained_regions_forced']),
                  median_chained_regions=(float(np.median([piece['regions']
                                                           for piece in pieces]))
                                          if pieces else None))
    record = dict(run=str(args.run), truth=args.truth, region_radius_ldu=args.region,
                  totals=totals, rows=rows, truth_used_at_runtime=False, runtime_vlm_calls=0,
                  certified=False,
                  scope='Evaluation-only. The bank, the base body and the physical filters are the '
                        "run's own; the reference model is read afterwards to say whether a "
                        'surviving region was the right one.',
                  limitations='Regions cluster positions only, so a single region can still hold '
                              'several orientations, and the count is therefore a lower bound on '
                              'the ambiguity a forcing rule would have to resolve. Arrow evidence '
                              'is not applied: the pages this rule was proposed for have none.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'page':>5} {'part':<10} {'col':>4} {'quota':>6} {'bank':>6} {'legal':>6} "
          f"{'cells':>6} {'refcells':>9} {'chain':>6} {'forced':>7}")
    for row in rows:
        for piece in row['pieces']:
            print(f"{row['page']:>5} {piece['part']:<10} {piece['color']:>4} {piece['quota']:>6} "
                  f"{piece['bank_poses']:>6} {piece['legal_poses']:>6} {piece['cells']:>6} "
                  f"{str(len(piece['cells_holding_a_reference_pose'])):>9} "
                  f"{piece['regions']:>6} {str(piece['forced']):>7}")
    print(json.dumps(totals))
    print(args.out)


if __name__ == '__main__':
    main()
