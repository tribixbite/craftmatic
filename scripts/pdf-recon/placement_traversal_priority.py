"""Does the traversal priority itself hide the small piece?

The retention stage loses 20 of the 100 measured failures, and widening the
search does not recover them: page 19 at `--beam 256 --top-k 64` writes 200
retained assemblies instead of 44 and contains exactly the same one correct pose.
So the loss is in which candidates the traversal reaches, not in how many
assemblies it keeps at the end.

The traversal order is one expression, in `placement_multi_shape_search` and
`placement_mixed_batch_search`:

    priorities = [float(np.sum((labels[i] == target) & (target > 0))) for i in ...]

That is a raw **count** of agreeing pixels, so it is bounded above by the
candidate's own painted area. A pose covering 11,000 px can score up to 11,000
and a pose covering 500 px can score at most 500, however perfectly the smaller
one agrees. `placement_cardinality_search` then orders by `-priority` within each
colour group, so the small-footprint pose is explored last by construction.

This measures the alternative without changing anything: the same agreement
divided by the candidate's own painted area, which is an agreement **rate** and
is scale-free. For every reference target of a page it reports the rank under
both, and it reports what the run actually selected under both as the control -
a priority that promotes the correct pose by demoting the right answer everywhere
else is not an improvement.

Evaluation-only. The bank, the screen and the camera are the run's own; the
reference model supplies the poses to locate and selects nothing.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def shipped_priority(labels, target):
    """The priority the search uses today: agreeing pixels, counted."""
    target = np.asarray(target)
    scored = target > 0
    return np.array([float(np.sum((np.asarray(labels[i]) == target) & scored))
                     for i in range(len(labels))])


def painted_area(labels):
    """Pixels each candidate paints at all, the natural scale-free normaliser."""
    return np.array([float(np.sum(np.asarray(labels[i]) > 0)) for i in range(len(labels))])


def ranks_of(values, indices):
    order = np.argsort(-np.asarray(values), kind='stable')
    rank = {int(index): position for position, index in enumerate(order, 1)}
    return {int(i): rank[int(i)] for i in indices}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True, help='Driver run directory')
    parser.add_argument('--page', type=int, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--view', type=int, default=None)
    parser.add_argument('--outside-fraction', type=float, default=0.01)
    parser.add_argument('--position-tolerance', type=float, default=1.0)
    args = parser.parse_args()

    from placement_arrow_contacts import read_items
    from placement_cardinality_bank import build_bank
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import frames_equal
    from placement_multi_shape_batch import shape_bank
    from placement_occupancy_screen import screen
    from placement_part_library import PartLibrary
    from placement_part_symmetry_table import symmetries as part_symmetries
    from placement_population_table import canonical_name
    from placement_run_scene import run_scene
    from pose_score import read_parts

    step = args.run / f'page-{args.page:03d}'
    placement = step / 'placement'
    registry = json.loads((step / 'registry-00.json').read_text())
    result = json.loads((placement / 'results.json').read_text())
    if registry.get('truth_used') is not False or result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    registration = json.loads((step / 'registration-refined-00.json').read_text())
    view = args.view if args.view is not None else int(result['results'][0].get('view') or 0)
    view = min(view, len(registration['hypotheses']) - 1)
    hypothesis = registration['hypotheses'][view]
    M = np.asarray(hypothesis['projection'], float)
    origin = np.asarray(hypothesis['origin'], float)

    library = PartLibrary()
    truth, _ = canonicalize(read_parts(args.truth), library)
    base_source = Path(registry['base_source'])
    base_items, _ = canonicalize(read_parts(base_source), library)
    names = {str(part) for part, *_ in truth} | {str(e['part']) for e in registry['poses']}
    symmetries = {part: list(part_symmetries(part, 'vertex')) for part in names}
    recall = bank_recall(registry, truth, base_items, symmetries=symmetries)
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    targets = [dict(part=entry['part'], color=int(entry['color']),
                    truth_index=entry['truth_index'],
                    position=inverse @ np.asarray(entry['reference_position'], float) + offset,
                    frame=inverse @ np.asarray(entry['reference_frame'], float))
               for entry in recall['rows']]

    base = read_items(base_source)
    scene, mask_source = run_scene(result, read_items(placement / 'model.ldr'))
    from placement_material_scene_score import MaterialFeatureSceneScorer
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    shapes = [dict(items=[(str(e['part']), 15, np.asarray(e['T'], float))])
              for e in registry['poses']]
    gate = screen(base, shapes, M, origin, scorer,
                  outside_tolerance_px=int(hypothesis.get('outside_pixels') or 0),
                  outside_fraction=args.outside_fraction)
    subset = dict(registry, poses=[registry['poses'][i] for i in gate['retained_indices']])
    pieces = result.get('image_pieces') or registry['allocated_pieces']
    placements, _quotas = shape_bank(subset, [(p, c) for p, c in pieces])
    bank = build_bank(base, placements, M, origin, scorer, max_host_bytes=12_000_000_000)
    agreement = shipped_priority(bank['labels'], bank['target'])
    painted = painted_area(bank['labels'])
    rate = agreement / np.maximum(1.0, painted)

    # Locate the reference poses and what the run emitted, in the same index space.
    selected = [(canonical_name(part, library), int(color), np.asarray(T, float))
                for part, color, T in read_items(placement / 'model.ldr')][len(base):]
    reference_indices, selected_indices = {}, []
    for index, entry in enumerate(placements):
        part, _color, T = entry['items'][0]
        name = canonical_name(part, library)
        symmetry = part_symmetries(name, 'vertex')
        for target in targets:
            if target['part'] != name:
                continue
            if np.max(np.abs(T[:3, 3] - target['position'])) > args.position_tolerance:
                continue
            if frames_equal(T[:3, :3], target['frame'], symmetry):
                reference_indices.setdefault(target['truth_index'], index)
        for name2, _c2, T2 in selected:
            if name2 != name:
                continue
            if np.max(np.abs(T[:3, 3] - T2[:3, 3])) > args.position_tolerance:
                continue
            if frames_equal(T[:3, :3], T2[:3, :3], symmetry):
                selected_indices.append(index)

    watched = sorted(set(reference_indices.values()) | set(selected_indices))
    count_rank = ranks_of(agreement, watched)
    rate_rank = ranks_of(rate, watched)
    rows = []
    for truth_index, index in sorted(reference_indices.items()):
        rows.append(dict(kind='reference', truth_index=truth_index, placement=index,
                         painted=float(painted[index]), agreement=float(agreement[index]),
                         rate=float(rate[index]), count_rank=count_rank[index],
                         rate_rank=rate_rank[index]))
    for index in selected_indices:
        rows.append(dict(kind='selected_by_the_run', placement=index,
                         painted=float(painted[index]), agreement=float(agreement[index]),
                         rate=float(rate[index]), count_rank=count_rank[index],
                         rate_rank=rate_rank[index]))
    reference_rows = [row for row in rows if row['kind'] == 'reference']
    record = dict(run=str(args.run), page=args.page, view=view, truth=args.truth,
                  mask_source=mask_source, screened_placements=len(placements),
                  reference_targets=len(targets), located_reference_poses=len(reference_indices),
                  rows=rows,
                  median_count_rank=(float(np.median([r['count_rank'] for r in reference_rows]))
                                     if reference_rows else None),
                  median_rate_rank=(float(np.median([r['rate_rank'] for r in reference_rows]))
                                    if reference_rows else None),
                  truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                  scope='Evaluation-only. The bank, screen and camera are the run\'s own; the '
                        'reference model supplies the poses to locate and selects nothing. No '
                        'runtime code is changed by this measurement.',
                  limitations='Ranks are over the screened bank for this page and view only. A '
                              'better rank is a necessary condition for the traversal to reach a '
                              'pose, not a proof that the search would then keep it, because the '
                              'traversal is over combinations and this ranks single placements.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f'screened {len(placements)} placements, located {len(reference_indices)} of '
          f'{len(targets)} reference poses')
    print(f"{'kind':<20} {'painted':>8} {'agree':>8} {'rate':>7} {'count#':>7} {'rate#':>7}")
    for row in rows:
        print(f"{row['kind']:<20} {row['painted']:>8.0f} {row['agreement']:>8.0f} "
              f"{row['rate']:>7.3f} {row['count_rank']:>7} {row['rate_rank']:>7}")
    print(f"median reference rank: by count {record['median_count_rank']}, "
          f"by rate {record['median_rate_rank']}")
    print(args.out)


if __name__ == '__main__':
    main()
