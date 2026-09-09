"""A CAD-size consistency gate for the inventory slot solver.

`canonical` normalises every crop to 64x64 before the frozen encoder sees it, so
the matcher is scale-blind by construction - and a 4x4 plate and a 2x2 plate are
the same SHAPE. That is exactly the confusion round ten's wider crop set walked
into: three callouts competing for 41601's two `3031` slots, resolved by taking
the opening page's near-certain match away.

The evidence the matcher throws away is recoverable, and not from the inventory
icon - a printed BOM scales each icon to its cell, so a big part's icon is
relatively smaller and crop/icon area is NOT constant across a page. Universal
CAD is the right yardstick: for a candidate identity, the part's own bounding-box
diagonal is known in LDU, and

    implied page scale = crop diagonal / CAD bounding-box diagonal

must agree across the callouts of ONE page, because one page draws its PLI at
one scale. Measured on 41601 the separation is clean and one-sided: the three
wrong assignments deviate from their page's median by 0.93, 0.67 and 0.41 in
log, and every one of the other assignments across twenty-five pages by at most
0.155.

The gate is applied by re-solving, not by overriding: violating (callout, slot)
pairs are removed from the solver's own candidate set and the global assignment
is solved again, to a fixed point. So the solver still chooses, capacity is
still exact, and no identity is ever asserted by this module.

A page with too few callouts has no reliable median and is skipped rather than
guessed at, and the tolerance is swept across fixtures rather than fitted to
one.
"""
import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

DEFAULT_TOLERANCE = 0.30
DEFAULT_MIN_ROWS = 3


def cad_diagonal(part, library, cache):
    """Universal CAD bounding-box diagonal in LDU, or None when unresolvable."""
    if part not in cache:
        from placement_mould_equivalence import geometry
        try:
            bounds = geometry(str(part), library)['bounds']
            low, high = np.asarray(bounds[0], float), np.asarray(bounds[1], float)
            cache[part] = float(np.linalg.norm(high - low))
        except Exception:
            cache[part] = None
    return cache[part]


def implied_scales(rows, library, cache):
    """Per-row implied page scale, keyed by the row's index in `rows`."""
    scales = {}
    for index, row in enumerate(rows):
        part = row.get('part')
        if part is None or 'bbox' not in row:
            continue
        diagonal = cad_diagonal(part, library, cache)
        if not diagonal:
            continue
        x0, y0, x1, y1 = row['bbox']
        scales[index] = math.hypot(x1 - x0, y1 - y0) / diagonal
    return scales


def violations(rows, library, cache, tolerance=DEFAULT_TOLERANCE, min_rows=DEFAULT_MIN_ROWS):
    """Rows whose implied page scale disagrees with their page's own median."""
    scales = implied_scales(rows, library, cache)
    per_page = defaultdict(list)
    for index, value in scales.items():
        per_page[int(rows[index]['page'])].append(index)
    flagged, detail = [], []
    for page, indices in sorted(per_page.items()):
        if len(indices) < min_rows:
            continue
        median = float(np.median([scales[i] for i in indices]))
        if median <= 0:
            continue
        for index in indices:
            deviation = abs(math.log(scales[index] / median))
            record = dict(page=page, part=rows[index].get('part'), color=rows[index].get('color'),
                          inventory_slot=rows[index].get('inventory_slot'),
                          bbox=list(rows[index]['bbox']), score=rows[index].get('score'),
                          implied_scale=scales[index], page_median=median,
                          log_deviation=deviation)
            detail.append(record)
            if deviation > tolerance:
                flagged.append(record)
    return flagged, detail


def gated_assignment(directory, floor=0.30, tolerance=DEFAULT_TOLERANCE,
                     min_rows=DEFAULT_MIN_ROWS, rounds=12):
    """Re-solve the saved slot assignment with size-inconsistent pairs removed."""
    from global_pdf_slot_assignment import solve_slots
    from placement_part_library import PartLibrary
    from placement_slot_floor import resolve
    directory = Path(directory)
    report = json.loads((directory / 'slot-assignment.json').read_text())
    items = json.loads((directory / 'callouts.json').read_text())
    scores = np.load(directory / 'scores.npy').copy()
    slots = report['slots']
    library, cache = PartLibrary(), {}
    # A callout is identified by its page and its crop box, which is what both
    # the item list and the solved evidence carry.
    item_index = {(int(item['page']), tuple(item['bbox'])): index
                  for index, item in enumerate(items) if 'bbox' in item}
    forbidden, history = set(), []
    assignment = resolve(directory, floor)
    for iteration in range(rounds):
        flagged, detail = violations(assignment['evidence'], library, cache, tolerance, min_rows)
        history.append(dict(iteration=iteration, assigned_callouts=assignment['assigned_callouts'],
                            assigned_pieces=assignment['assigned_pieces'],
                            violations=[dict(row) for row in flagged],
                            max_log_deviation=max((row['log_deviation'] for row in detail),
                                                  default=0.0)))
        new = {(item_index[(row['page'], tuple(row['bbox']))], int(row['inventory_slot']))
               for row in flagged if (row['page'], tuple(row['bbox'])) in item_index}
        new -= forbidden
        if not new:
            break
        forbidden |= new
        working = scores.copy()
        for index, slot in forbidden:
            working[index, slot] = floor - 1.0
        selected, solver = solve_slots(items, slots, working, floor=floor)
        evidence, assigned = [], set()
        for i, j, score in selected:
            assigned.add(i)
            slot = slots[j]
            entry = dict(items[i], inventory_slot=j, element_id=slot['element_id'], score=score,
                         part_choices=slot['choices'])
            if len(slot['choices']) == 1:
                entry.update(slot['choices'][0])
            evidence.append(entry)
        unresolved = [dict(item, reason='No inventory slot assigned')
                      for index, item in enumerate(items) if index not in assigned and 'bbox' in item]
        unresolved += [dict(item) for item in items if 'bbox' not in item]
        assignment = dict(report, evidence=evidence, unresolved=unresolved, floor=floor,
                          assigned_callouts=len(assigned),
                          assigned_pieces=sum(row['qty'] for row in evidence), solver=solver)
    flagged, detail = violations(assignment['evidence'], library, cache, tolerance, min_rows)
    assignment['size_gate'] = dict(tolerance=tolerance, min_rows=min_rows,
                                   converged=not flagged, residual_violations=len(flagged),
                                   max_log_deviation=max((row['log_deviation']
                                                          for row in detail), default=0.0),
                                   forbidden_pairs=sorted(map(list, forbidden)),
                                   iterations=history,
                                   protocol='Implied page scale is the crop diagonal over the '
                                            'candidate part\'s universal CAD bounding-box '
                                            'diagonal; a page draws its PLI at one scale, so the '
                                            'callouts of one page must agree. Violating pairs are '
                                            'removed from the solver\'s candidate set and the '
                                            'global assignment is solved again.')
    return assignment


def apply_gate(directory, out, floor=0.30, tolerance=DEFAULT_TOLERANCE,
               min_rows=DEFAULT_MIN_ROWS, rounds=12):
    """Write one gated slot assignment beside its unchanged inputs. No reference."""
    directory, out = Path(directory), Path(out)
    assignment = gated_assignment(directory, floor, tolerance, min_rows, rounds)
    out.mkdir(parents=True, exist_ok=True)
    for name in ('callouts.json', 'scores.npy'):
        source = directory / name
        if source.is_file() and not (out / name).is_file():
            (out / name).write_bytes(source.read_bytes())
    (out / 'slot-assignment.json').write_text(json.dumps(assignment, indent=2))
    gate = assignment['size_gate']
    print(json.dumps(dict(assigned_callouts=assignment['assigned_callouts'],
                          assigned_pieces=assignment['assigned_pieces'],
                          gated_pairs=len(gate['forbidden_pairs']), converged=gate['converged'],
                          max_log_deviation=round(gate['max_log_deviation'], 4),
                          out=str(out))))
    return assignment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--apply', action='store_true',
                        help='Write one gated assignment instead of sweeping; needs no reference')
    parser.add_argument('--tolerance', type=float, default=DEFAULT_TOLERANCE)
    parser.add_argument('--truth')
    parser.add_argument('--tolerances', type=float, nargs='+',
                        default=[0.20, 0.25, 0.30, 0.35, 0.40])
    parser.add_argument('--floor', type=float, default=0.30)
    parser.add_argument('--min-rows', type=int, default=DEFAULT_MIN_ROWS)
    parser.add_argument('--rounds', type=int, default=12)
    parser.add_argument('--mould-classes', type=Path)
    parser.add_argument('--mould-policy', default='withhold')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.apply:
        apply_gate(args.directory, args.out, args.floor, args.tolerance, args.min_rows,
                   args.rounds)
        return
    if not args.truth:
        raise SystemExit('A sweep needs --truth; use --apply to write one gated assignment')
    from placement_allocation_audit import audit
    from placement_slot_adapter import adapt, admissible_pages
    table = json.loads(args.mould_classes.read_text()) if args.mould_classes else None
    rows = []
    for tolerance in args.tolerances:
        assignment = gated_assignment(args.directory, args.floor, tolerance, args.min_rows,
                                      args.rounds)
        staging = args.out / ('tolerance-%03d' % round(tolerance * 100))
        staging.mkdir(parents=True, exist_ok=True)
        (staging / 'slot-assignment.json').write_text(json.dumps(assignment, indent=2))
        pages, excluded = admissible_pages(assignment, table, args.mould_policy)
        row = dict(tolerance=tolerance, assigned_callouts=assignment['assigned_callouts'],
                   assigned_pieces=assignment['assigned_pieces'], scope_pages=len(pages),
                   excluded_pages=[entry['page'] for entry in excluded],
                   forbidden=len(assignment['size_gate']['forbidden_pairs']),
                   converged=assignment['size_gate']['converged'],
                   max_log_deviation=assignment['size_gate']['max_log_deviation'])
        if pages:
            allocation = adapt(assignment, pages, table, args.mould_policy)
            (staging / 'global-assignment.json').write_text(json.dumps(allocation, indent=2))
            record = audit(staging / 'global-assignment.json', args.truth)
            row.update(scope_pieces=allocation['assigned_pieces'] + allocation['withheld_pieces'],
                       accounted=record['accounted_pieces'],
                       accounted_fraction=record['accounted_fraction'],
                       exact_pages=record['exactly_matched_pages'])
        rows.append(row)
        print('tolerance %.2f  gated %2d pairs  converged %-5s  callouts %2d  scope %2d pages / '
              '%3d pieces  accounted %3d (%.3f)  exact %2d'
              % (tolerance, row['forbidden'], str(row['converged']),
                 row['assigned_callouts'], row['scope_pages'], row.get('scope_pieces', 0),
                 row.get('accounted', 0), row.get('accounted_fraction', 0.),
                 row.get('exact_pages', 0)), flush=True)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'sweep.json').write_text(json.dumps(
        dict(directory=str(args.directory), truth=args.truth, floor=args.floor,
             min_rows=args.min_rows, rows=rows, truth_used_at_runtime=False,
             runtime_vlm_calls=0, certified=False,
             scope='The gate reads PDF crop geometry and universal CAD only. The reference scores '
                   'the outcome afterwards and chooses nothing.',
             limitations='A page with fewer than min_rows callouts is skipped rather than guessed '
                         'at; the median is only as good as the page it is taken over; accounted '
                         'pieces are an allocation-grouping measure, not identity accuracy.'),
        indent=2))
    print(args.out / 'sweep.json')


if __name__ == '__main__':
    main()
