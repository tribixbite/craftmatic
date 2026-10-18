"""Would a mirror-consistency tie-break have picked a better retained assembly?

The mirror ceiling says the channel can reach two of 40377's distinct wrong
parts, but a post-hoc *replacement* rule cannot use it: when a page allocates
three copies of a mould and gets one right, runtime has no way to know which one
to overwrite, and every strict determinism gate then declines to fire.

The formulation that does not need that knowledge is a selection one. The search
already retains a dozen complete assemblies per page and ranks them by the image
objective. Mirror consistency - how many of an assembly's own additions are the
reflection, about the body's detected plane, of something already placed - is a
property of a whole assembly, needs no drawing evidence, and is exactly the shape
of the existing local-rerank and seated tie-break levers.

This measures it the same way those were measured: for every retained beam of
every driven page, its image score, its mirror consistency and how many of its
additions agree with the reference. It then reports what a tie-break inside a
score band would have selected. Evaluation-only; the reference model is read
after the run and chooses nothing.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def mirror_consistency(base, additions, plane, position_tolerance=1.0):
    """Additions that are the reflection of something already in the assembly."""
    from placement_mirror_completion import frames_equal, mirror_transform
    from placement_part_mirror_table import reflections
    from placement_part_symmetry_table import symmetries as proper_symmetries
    whole = list(base) + list(additions)
    axis, offset = plane['axis'], plane['offset']
    consistent = 0
    for part, color, T in additions:
        variants = reflections(part)
        if not variants:
            continue
        symmetry = proper_symmetries(part, 'vertex')
        hit = False
        for Q in variants:
            mirrored = mirror_transform(T, axis, offset, Q)
            for opart, ocolor, oT in whole:
                if (opart, ocolor) != (part, color):
                    continue
                if oT is T:
                    continue
                if np.max(np.abs(np.asarray(oT)[:3, 3] - mirrored[:3, 3])) > position_tolerance:
                    continue
                if frames_equal(mirrored[:3, :3], np.asarray(oT)[:3, :3], symmetry):
                    hit = True
                    break
            if hit:
                break
        consistent += 1 if hit else 0
    return consistent


def page_rows(run, page, truth, library, symmetries, band, minimum_fraction=0.5,
              position_tolerance=1.0):
    from placement_arrow_contacts import read_items
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import detect_plane, frames_equal
    from placement_part_symmetry_table import symmetries as proper_symmetries
    from placement_population_table import canonical_name
    from pose_score import read_parts
    step = Path(run) / f'page-{page:03d}'
    placement = step / 'placement'
    registry = json.loads((step / 'registry-00.json').read_text())
    result = json.loads((placement / 'results.json').read_text())
    if registry.get('truth_used') is not False or result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    base_source = Path(registry['base_source'])
    base_items, _ = canonicalize(read_parts(base_source), library)
    recall = bank_recall(registry, truth, base_items, symmetries=symmetries)
    base = [(canonical_name(part, library), int(color), np.asarray(T, float))
            for part, color, T in read_items(base_source)]
    plane = detect_plane(base, minimum_fraction)
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    targets = [dict(part=entry['part'], color=int(entry['color']),
                    truth_index=entry['truth_index'],
                    position=inverse @ np.asarray(entry['reference_position'], float) + offset,
                    frame=inverse @ np.asarray(entry['reference_frame'], float))
               for entry in recall['rows']]

    def correct_additions(additions):
        used, hits = set(), 0
        for part, color, T in additions:
            symmetry = proper_symmetries(part, 'vertex')
            for index, target in enumerate(targets):
                if index in used or target['part'] != part or target['color'] != color:
                    continue
                if np.max(np.abs(T[:3, 3] - target['position'])) > position_tolerance:
                    continue
                if frames_equal(T[:3, :3], target['frame'], symmetry):
                    used.add(index)
                    hits += 1
                    break
        return hits, sorted(targets[i]['truth_index'] for i in used)

    beams = []
    for entry in result['results']:
        path = placement / entry['file']
        if not path.is_file():
            continue
        items = [(canonical_name(part, library), int(color), np.asarray(T, float))
                 for part, color, T in read_items(path)]
        additions = items[len(base):]
        hits, indices = correct_additions(additions)
        beams.append(dict(file=entry['file'], score=float(entry['evidence']['score']),
                          additions=len(additions), correct=hits, correct_indices=indices,
                          mirror_consistent=(mirror_consistency(base, additions, plane,
                                                                position_tolerance)
                                             if plane and plane.get('accepted') else None)))
    row = dict(page=page, plane=plane, beams=beams, band=band,
               reference_targets=len(targets))
    if not beams:
        row['status'] = 'no_retained_beams'
        return row
    selected = beams[0]
    row['selected'] = selected
    if not plane or not plane.get('accepted'):
        row['status'] = 'plane_refused'
        return row
    # A tie-break, not a new objective: only assemblies whose image score is
    # within `band` of the selected one are eligible to be reordered.
    eligible = [beam for beam in beams if beam['score'] >= selected['score'] - band]
    reranked = max(eligible, key=lambda beam: (beam['mirror_consistent'], beam['score']))
    row.update(status='measured', eligible=len(eligible), reranked=reranked,
               delta=reranked['correct'] - selected['correct'],
               best_available=max(beam['correct'] for beam in beams))
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--band', type=float, default=0.05,
                        help='Image-score window inside which the tie-break may reorder')
    parser.add_argument('--minimum-fraction', type=float, default=0.5)
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
        rows.append(page_rows(args.run, step['page'], truth, library, symmetries, args.band,
                              args.minimum_fraction))
    measured = [row for row in rows if row.get('status') == 'measured']
    totals = dict(pages=len(rows), measured=len(measured),
                  selected_correct=sum(row['selected']['correct'] for row in measured),
                  reranked_correct=sum(row['reranked']['correct'] for row in measured),
                  oracle_best=sum(row['best_available'] for row in measured),
                  pages_improved=sum(1 for row in measured if row['delta'] > 0),
                  pages_worsened=sum(1 for row in measured if row['delta'] < 0))
    record = dict(run=str(args.run), truth=args.truth, band=args.band, totals=totals, rows=rows,
                  truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                  scope='Evaluation-only. Beams, scores and planes come from the completed run; '
                        'the reference model scores them afterwards and selects nothing.',
                  limitations='Each page is judged against the body the run actually gave it, so '
                              'this is a per-page reordering and not a re-drive: a page whose '
                              'selection changes would hand a different body to the next page.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'page':>5} {'beams':>6} {'elig':>5} {'sel':>4} {'mir':>4} {'rer':>4} {'mir':>4} "
          f"{'best':>5} {'delta':>6}")
    for row in rows:
        if row.get('status') != 'measured':
            print(f"{row['page']:>5} {len(row['beams']):>6} {row.get('status'):>40}")
            continue
        print(f"{row['page']:>5} {len(row['beams']):>6} {row['eligible']:>5} "
              f"{row['selected']['correct']:>4} {row['selected']['mirror_consistent']:>4} "
              f"{row['reranked']['correct']:>4} {row['reranked']['mirror_consistent']:>4} "
              f"{row['best_available']:>5} {row['delta']:>+6}")
    print(json.dumps(totals))
    print(args.out)


if __name__ == '__main__':
    main()
