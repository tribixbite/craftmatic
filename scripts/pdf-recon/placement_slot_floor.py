"""Re-solve a saved slot assignment at other acceptance floors, and score it.

The slot solver maximises the total of `qty x similarity` over a global
assignment, so it will trade one callout's near-certain match for a marginal
gain elsewhere. Round ten measured that directly: repairing two association
failures on 41601 added two callouts, and the solver's new optimum moved page
2's plate from `3031`:72 at 0.998 to `3022`:72 at 0.939 while sending page 7's
pair to `3958`:0 at **0.483**. Every one of those is inside the solver's own
0.30 acceptance floor.

This re-solves from the saved artifacts - `scores.npy` and `callouts.json`
beside the assignment, so no image is embedded twice and no encoder runs - at a
sweep of floors, and pairs each with `placement_allocation_audit`. A floor is a
calibration, so it is chosen on the sweep across fixtures and reported with the
sweep, never asserted.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def resolve(directory, floor):
    """The assignment this directory's own scores produce at `floor`."""
    from global_pdf_slot_assignment import solve_slots
    directory = Path(directory)
    report = json.loads((directory / 'slot-assignment.json').read_text())
    items = json.loads((directory / 'callouts.json').read_text())
    scores = np.load(directory / 'scores.npy')
    slots = report['slots']
    selected, solver = solve_slots(items, slots, scores, floor=floor)
    evidence, assigned = [], set()
    for i, j, score in selected:
        assigned.add(i)
        slot = slots[j]
        row = dict(items[i], inventory_slot=j, element_id=slot['element_id'], score=score,
                   part_choices=slot['choices'])
        if len(slot['choices']) == 1:
            row.update(slot['choices'][0])
        evidence.append(row)
    unresolved = [dict(item, page=item['page'], reason='No inventory slot assigned')
                  for i, item in enumerate(items) if i not in assigned and 'bbox' in item]
    unresolved += [dict(item) for item in items if 'bbox' not in item]
    return dict(report, evidence=evidence, unresolved=unresolved, floor=floor,
                assigned_callouts=len(assigned),
                assigned_pieces=sum(row['qty'] for row in evidence),
                solver=solver, resolved_from=str(directory))


def sweep(directory, floors, truth, mould_classes=None, mould_policy='withhold', out=None):
    from placement_allocation_audit import audit
    from placement_slot_adapter import adapt, admissible_pages
    table = json.loads(Path(mould_classes).read_text()) if mould_classes else None
    out = Path(out) if out else None
    rows = []
    for floor in floors:
        assignment = resolve(directory, floor)
        staging = (out or Path('.')) / ('floor-%03d' % round(floor * 100))
        staging.mkdir(parents=True, exist_ok=True)
        (staging / 'slot-assignment.json').write_text(json.dumps(assignment, indent=2))
        pages, excluded = admissible_pages(assignment, table, mould_policy)
        row = dict(floor=floor, assigned_callouts=assignment['assigned_callouts'],
                   assigned_pieces=assignment['assigned_pieces'],
                   scope_pages=len(pages),
                   excluded_pages=[entry['page'] for entry in excluded])
        if pages:
            allocation = adapt(assignment, pages, table, mould_policy)
            (staging / 'global-assignment.json').write_text(json.dumps(allocation, indent=2))
            record = audit(staging / 'global-assignment.json', truth)
            row.update(scope_pieces=allocation['assigned_pieces'] + allocation['withheld_pieces'],
                       accounted=record['accounted_pieces'],
                       accounted_fraction=record['accounted_fraction'],
                       exact_pages=record['exactly_matched_pages'])
        rows.append(row)
        print('floor %.2f  callouts %2d  pieces %3d  scope %2d pages / %3d pieces  '
              'accounted %3d (%.3f)  exact %2d'
              % (floor, row['assigned_callouts'], row['assigned_pieces'], row['scope_pages'],
                 row.get('scope_pieces', 0), row.get('accounted', 0),
                 row.get('accounted_fraction', 0.), row.get('exact_pages', 0)), flush=True)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--floors', type=float, nargs='+',
                        default=[0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90])
    parser.add_argument('--mould-classes', type=Path)
    parser.add_argument('--mould-policy', default='withhold')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rows = sweep(args.directory, args.floors, args.truth, args.mould_classes,
                 args.mould_policy, args.out)
    (args.out / 'sweep.json').write_text(json.dumps(
        dict(directory=str(args.directory), truth=args.truth, rows=rows,
             truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
             scope='The floor is a calibration measured against reference step structure; the '
                   'assignment itself reads only PDF pixels and the printed inventory.',
             limitations='Accounted pieces are an allocation-grouping measure, not identity '
                         'accuracy and not placement accuracy.'), indent=2))
    print(args.out / 'sweep.json')


if __name__ == '__main__':
    main()
