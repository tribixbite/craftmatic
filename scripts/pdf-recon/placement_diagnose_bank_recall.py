"""Post-hoc diagnostic: does an enumerated pose bank contain the true poses?

Separates two very different failures that look identical in the output:

* candidate generation missed the correct pose entirely (connector enumeration,
  closure budget, collision or occupancy screening), or
* the correct pose was enumerated and the search or the score rejected it.

The independent model is read here for evaluation only, after the run. It never
enters candidate generation, scoring or selection. The alignment between the
reconstruction frame and the reference frame is recovered from the already
placed body, not supplied by hand.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from pose_score import read_parts, score


def align(base_items, truth):
    """Rigid map from the reconstruction frame into the reference frame."""
    result = score(base_items, truth)
    if not result.get('alignment'):
        raise ValueError('No proper rigid alignment is implied by the existing body')
    rotation = np.asarray(result['alignment']['rotation'], float)
    translation = np.asarray(result['alignment']['translation'], float)
    return rotation, translation, result


def bank_recall(registry, truth, base_items, position_tolerance=1.0, rotation_tolerance=1e-4,
                symmetries=None):
    rotation, translation, alignment = align(base_items, truth)
    placed = {(part, int(color), tuple(np.round(rotation @ position + translation, 3)))
              for part, color, position, _ in base_items}
    quotas = {}
    for part, color in registry['allocated_pieces']:
        quotas[(str(part), int(color))] = quotas.get((str(part), int(color)), 0) + 1
    wanted = []
    for index, (part, color, position, frame) in enumerate(truth):
        if (part, int(color)) not in quotas:
            continue
        if (part, int(color), tuple(np.round(position, 3))) in placed:
            continue  # already in the body: this is a later page's copy
        wanted.append((index, part, int(color), position, frame))
    rows = []
    for truth_index, part, color, position, frame in wanted:
        hits = []
        for index, entry in enumerate(registry['poses']):
            if str(entry['part']) != part:
                continue
            T = np.asarray(entry['T'], float)
            mapped_position = rotation @ T[:3, 3] + translation
            mapped_frame = rotation @ T[:3, :3]
            if np.max(np.abs(mapped_position - position)) > position_tolerance:
                continue
            local = (symmetries or {}).get(part, [np.eye(3)])
            if any(np.allclose(mapped_frame, frame @ variant, atol=rotation_tolerance, rtol=0)
                   for variant in local):
                hits.append(index)
        rows.append(dict(part=part, color=color, reference_position=position.tolist(),
                         # The reference file index identifies the instance exactly, so a
                         # downstream table can join a page's target on the same object a
                         # whole-model matching reports rather than on a rounded position.
                         truth_index=int(truth_index),
                         reference_frame=np.asarray(frame, float).tolist(),
                         bank_indices=hits, present=bool(hits)))
    return dict(alignment=alignment, allocated_quotas={f'{p}:{c}': q for (p, c), q in quotas.items()},
                reference_targets=len(rows), present=sum(1 for r in rows if r['present']),
                rows=rows, position_tolerance_ldu=position_tolerance,
                rotation_tolerance=rotation_tolerance,
                scope='Evaluation-only diagnostic executed after the run; no reference pose '
                      'participates in candidate generation, scoring or selection.',
                limitations='Reference targets are the reference parts of this page allocation not '
                            'already present in the body; the reference file order need not equal '
                            'PDF step order, so a missing target can also mean the part genuinely '
                            'belongs to another page. Local symmetries are applied only when '
                            'supplied and never to printed parts.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--truth', default='C:/git/clego/lego_sets/OMR/40377-1.mpd')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--position-tolerance', type=float, default=1.0)
    parser.add_argument('--symmetry-level', choices=('vertex', 'triangle'), default='vertex')
    args = parser.parse_args()
    registry = json.loads(args.registry.read_text())
    if registry.get('truth_used') is not False or registry.get('runtime_vlm_calls') != 0:
        raise ValueError('Registry provenance lacks truth-free zero-VLM attestation')
    from placement_diagnose_alias_poses import canonicalize
    from placement_part_library import PartLibrary
    from placement_part_symmetry_table import symmetries as part_symmetries, table
    library = PartLibrary()
    truth, _ = canonicalize(read_parts(args.truth), library)
    base_items, _ = canonicalize(read_parts(args.base), library)
    # Local symmetries come from the saved universal-CAD proofs, not a hand list.
    # The previous hand list omitted whole families - it had no entry for 60474
    # at all - so a pose enumerated in an equivalent frame was reported missing
    # and understated recall exactly where recall was being measured.
    wanted = sorted({str(entry['part']) for entry in registry['poses']}
                    | {str(part) for part, *_ in truth})
    symmetries = {part: list(part_symmetries(part, args.symmetry_level)) for part in wanted}
    result = bank_recall(registry, truth, base_items, args.position_tolerance,
                         symmetries=symmetries)
    result.update(registry=str(args.registry), base=str(args.base), truth=str(args.truth),
                  bank_poses=len(registry['poses']),
                  base_attached=registry.get('base_attached_count'),
                  closure_budget_hit=registry.get('closure_budget_hit'),
                  closure_parent_order=registry.get('closure_parent_order'),
                  closure_parents_processed=registry.get('closure_parents_processed'),
                  symmetry_table=table(wanted, args.symmetry_level))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(json.dumps(dict(reference_targets=result['reference_targets'],
                          present=result['present'], bank_poses=result['bank_poses'],
                          missing=[r['part'] for r in result['rows'] if not r['present']])))
