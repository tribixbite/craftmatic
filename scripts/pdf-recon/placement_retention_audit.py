"""Where between the bank and the output does a correct pose get lost?

The population table's `mis_selected` class says the reference pose was
enumerated and not chosen. That is three different failures wearing one name,
and they have different owners:

1. the occupancy screen rejected it before the search ever saw it,
2. the search saw it and no retained assembly contains it,
3. a retained assembly contains it and the objective ranked another first.

Only the third is a scoring problem. Rounds three, five and six between them have
measured re-ranking five ways and bought +2 poses; nothing has ever measured the
first two, and the round-six ceiling memo names them as the second-largest lever
on 40377. This audits all three from artifacts the run already wrote.

The measurement is exact rather than inferred. A page's occupancy record stores
`input_candidates` equal to its bank size and `retained_indices` as indices into
that same bank, so "did the screen keep the correct pose" is a set membership
test, not a re-derivation.

Evaluation-only: bank membership and correctness come from the reference model,
read strictly after the run.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def page_retention(run, page, truth, library, symmetries, position_tolerance=1.0):
    from placement_arrow_contacts import read_items
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import frames_equal
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
    view = int(result['results'][0].get('view') or 0)
    occupancy_path = placement / f'view-{view:02d}-occupancy.json'
    retained = None
    if occupancy_path.is_file():
        occupancy = json.loads(occupancy_path.read_text())
        if occupancy.get('input_candidates') != len(registry['poses']):
            raise ValueError('Occupancy record does not index this page bank')
        retained = set(occupancy['retained_indices'])
        screen_skipped = bool(occupancy.get('candidate_screen_skipped'))
    else:
        screen_skipped = None
    # Which reference targets appear in ANY retained assembly, and in the selected
    # one. Read from the beams the run wrote, so this is what the search really
    # held rather than what it could have held.
    base = [(canonical_name(part, library), int(color), np.asarray(T, float))
            for part, color, T in read_items(base_source)]
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    targets = []
    for entry in recall['rows']:
        targets.append(dict(part=entry['part'], color=int(entry['color']),
                            truth_index=entry['truth_index'],
                            position=inverse @ np.asarray(entry['reference_position'], float)
                            + offset,
                            frame=inverse @ np.asarray(entry['reference_frame'], float),
                            in_bank=bool(entry['present']),
                            survived_screen=(None if retained is None else
                                             any(index in retained
                                                 for index in entry['bank_indices'])),
                            in_any_beam=False, in_selected=False))
    for order, entry in enumerate(result['results']):
        path = placement / entry['file']
        if not path.is_file():
            continue
        items = [(canonical_name(part, library), int(color), np.asarray(T, float))
                 for part, color, T in read_items(path)]
        for part, color, T in items[len(base):]:
            symmetry = proper_symmetries(part, 'vertex')
            for target in targets:
                if target['part'] != part or target['color'] != color:
                    continue
                if np.max(np.abs(T[:3, 3] - target['position'])) > position_tolerance:
                    continue
                if frames_equal(T[:3, :3], target['frame'], symmetry):
                    target['in_any_beam'] = True
                    if order == 0:
                        target['in_selected'] = True
                    break
    return dict(page=page, bank_poses=len(registry['poses']), view=view,
                candidate_screen_skipped=screen_skipped,
                retained_candidates=(None if retained is None else len(retained)),
                targets=[{k: v for k, v in target.items() if k not in ('position', 'frame')}
                         for target in targets])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
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
        rows.append(page_retention(args.run, step['page'], truth, library, symmetries))
    # Distinct reference instances, not per-page opportunities: a target of two
    # pages would otherwise be counted twice on both sides of every ratio.
    stages = {}
    for row in rows:
        for target in row['targets']:
            key = target['truth_index']
            current = stages.setdefault(key, dict(in_bank=False, survived_screen=False,
                                                  in_any_beam=False, in_selected=False))
            current['in_bank'] |= bool(target['in_bank'])
            current['survived_screen'] |= bool(target['survived_screen'])
            current['in_any_beam'] |= bool(target['in_any_beam'])
            current['in_selected'] |= bool(target['in_selected'])
    totals = dict(distinct_reference_targets=len(stages),
                  in_bank=sum(1 for v in stages.values() if v['in_bank']),
                  survived_screen=sum(1 for v in stages.values() if v['survived_screen']),
                  in_any_retained_assembly=sum(1 for v in stages.values() if v['in_any_beam']),
                  in_selected_assembly=sum(1 for v in stages.values() if v['in_selected']))
    totals['lost_before_enumeration'] = totals['distinct_reference_targets'] - totals['in_bank']
    totals['lost_to_occupancy_screen'] = totals['in_bank'] - totals['survived_screen']
    totals['lost_to_search_retention'] = totals['survived_screen'] - \
        totals['in_any_retained_assembly']
    totals['lost_to_ranking'] = totals['in_any_retained_assembly'] - totals['in_selected_assembly']
    record = dict(run=str(args.run), truth=args.truth, totals=totals, rows=rows,
                  truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                  scope='Evaluation-only. Bank membership, screen survival and beam membership are '
                        "read from the run's own artifacts; the reference model supplies the poses "
                        'and selects nothing.',
                  limitations='Screen survival is measured on the view the search selected, so a '
                              'pose kept on another view is reported as dropped. Beam membership '
                              'is over the assemblies the run wrote, which is the top of the beam '
                              'and not everything the search touched.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'page':>5} {'bank':>7} {'kept':>7} {'targets':>8} {'inbank':>7} {'screen':>7} "
          f"{'beam':>5} {'sel':>4}")
    for row in rows:
        targets = row['targets']
        print(f"{row['page']:>5} {row['bank_poses']:>7} "
              f"{str(row['retained_candidates']):>7} {len(targets):>8} "
              f"{sum(1 for t in targets if t['in_bank']):>7} "
              f"{sum(1 for t in targets if t['survived_screen']):>7} "
              f"{sum(1 for t in targets if t['in_any_beam']):>5} "
              f"{sum(1 for t in targets if t['in_selected']):>4}")
    print(json.dumps(totals, indent=1))
    print(args.out)


if __name__ == '__main__':
    main()
