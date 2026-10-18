"""Inventory capacity as evidence: what the BOM constrains, and what it cannot.

The PDF's own inventory page lists every element with a quantity, so the set's
part pool is known before a single pose is searched, and the page callouts say
how much of each pool each step draws. Round six proposed using that as a
*forcing* rule and measured the premise false by two orders of magnitude (110 to
669 distinct one-stud locations per allocated identity against quotas of one to
four). Round nine's brief asks the opposite question: not a filter, a
**likelihood** that breaks the objective's ties.

Three things are separable here and this module keeps them separate, because two
of them are provably vacuous as a per-page ranker and saying so is the result:

1. **Count capacity is already satisfied by construction.** The page allocation
   is exact per key, the search enforces that quota, and every retained assembly
   therefore uses exactly the allocated multiset. Measured on 41601: 34 of 46
   unambiguous keys have their whole pool allocated to pages in the scope, and
   every driven page placed its whole allocation. A count term cannot rank two
   assemblies of the same page - they are count-identical. What it *can* do is
   audit the allocation itself, and that is `audit`.
2. **Draw-down order is a real, cheap contradiction test.** If the pages before
   page P have consumed more of a key than its pool holds, something upstream is
   wrong - a mis-assigned callout, or a page scoped in twice. That is a
   pool-level statement about the run, so it composes as a backtracking trigger
   (`placement_backtrack.assess`, `capacity_violation`) rather than as a score.
3. **Remaining-capacity feasibility is the only pose-dependent reading, and it
   is a look-ahead.** After committing an assembly, the rest of the booklet's
   allocation still has to fit somewhere: `capacity_of_body` counts, for every
   key the later pages need, how many collision-free connector mates the
   committed body offers and how many *distinct one-stud locations* those mates
   occupy - the non-chaining measure round six had to correct to. A body that
   cannot host what the inventory says is still to come is inconsistent with the
   inventory whatever its pixels say.

The honest caveat on (3), inherited from round six's own measurement and not
softened: a key with zero base-attached mates is **not** proven infeasible,
because closure also places pieces onto sibling additions rather than onto the
body. So a deficit is evidence, not proof, and this module reports the deficit
and the slack rather than refusing anything.

`rank` applies the term the way the brief specifies - inside a stated band below
the best objective score, so it reorders what the objective says it cannot
separate and never overrides a clear image preference. The band is a parameter
with no default: a run that uses one records it.

No reference model is read anywhere in this module.
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from placement_inventory_forcing import grid_cells

# One stud. Two candidate poses inside one cell are the same stud-scale location;
# in different cells they are genuinely different ones.
LATTICE_LDU = 20.0


def format_key(part, color):
    return f'{part}:{int(color)}'


def parse_key(text):
    """`part:colour` back to a tuple. Part names never contain a colon."""
    part, _, color = str(text).rpartition(':')
    return (part, int(color))


def slot_pool(slot_assignment, equivalence=None):
    """Pooled inventory per key from the PDF inventory slots.

    `equivalence` maps a part name to its mould-equivalence canonical name (see
    `placement_mould_equivalence`). With it, a slot whose candidates are all
    members of one class contributes to that class's single pool instead of being
    unusable ambiguity - which is the whole point of the class: the pieces exist
    and their count is known even when their filename is not.
    """
    payload = json.loads(Path(slot_assignment).read_text()) if not isinstance(
        slot_assignment, dict) else slot_assignment
    if payload.get('truth_used') is not False:
        raise ValueError('Inventory provenance lacks truth-free declaration')
    equivalence = equivalence or {}

    def canonical(part):
        return equivalence.get(part, part)

    pool, ambiguous, classes = Counter(), [], {}
    for slot in payload['slots']:
        keys = {(canonical(choice['part']), int(choice['color'])) for choice in slot['choices']}
        if len(keys) == 1:
            key = keys.pop()
            pool[key] += int(slot['qty'])
            if len(slot['choices']) > 1:
                classes[key] = sorted({choice['part'] for choice in slot['choices']})
            continue
        ambiguous.append(dict(inventory_record=slot.get('inventory_record'), qty=int(slot['qty']),
                              element_id=slot.get('element_id'),
                              choices=[[choice['part'], int(choice['color'])]
                                       for choice in slot['choices']]))
    return dict(pool={f'{part}:{color}': count for (part, color), count in sorted(pool.items())},
                pool_pieces=int(sum(pool.values())),
                ambiguous_slots=ambiguous,
                ambiguous_pieces=int(sum(slot['qty'] for slot in ambiguous)),
                pooled_by_equivalence={f'{part}:{color}': names
                                       for (part, color), names in sorted(classes.items())},
                source=str(slot_assignment) if not isinstance(slot_assignment, dict) else 'inline',
                truth_used=False)


def page_allocations(global_assignment):
    """Per-page key counts from a global slot assignment."""
    payload = json.loads(Path(global_assignment).read_text()) if not isinstance(
        global_assignment, dict) else global_assignment
    if payload.get('truth_used') is not False:
        raise ValueError('Allocation provenance lacks truth-free declaration')
    pages = defaultdict(Counter)
    for row in payload['evidence']:
        pages[int(row['page'])][(str(row['part']), int(row['color']))] += int(row['qty'])
    return {page: counter for page, counter in sorted(pages.items())}


def audit(pool_record, allocations, pages=None, equivalence=None):
    """Draw-down of the pool by page, with every contradiction named.

    `pages` restricts the audit to a driven scope, in page order; the pool is
    consumed in that order so a deficit is attributed to the page that overdrew
    it. A key the scope never allocates simply keeps its slack.
    """
    equivalence = equivalence or {}
    pool = Counter({parse_key(key): count for key, count in pool_record['pool'].items()})
    order = list(pages) if pages is not None else list(allocations)
    remaining, deficits, rows = Counter(pool), [], []
    consumed = Counter()
    for page in order:
        counter = allocations.get(page, Counter())
        for (part, color), count in sorted(counter.items()):
            key = (equivalence.get(part, part), color)
            available = remaining.get(key, 0)
            consumed[key] += count
            if key not in pool:
                deficits.append(dict(page=page, key=[key[0], key[1]], required=count,
                                     available=0,
                                     reason='The allocated key is in no unambiguous inventory '
                                            'slot, so its pool is unknown'))
            elif count > available:
                deficits.append(dict(page=page, key=[key[0], key[1]], required=count,
                                     available=int(available),
                                     reason='The pages up to here have already consumed the pool'))
            remaining[key] = available - count
            rows.append(dict(page=page, key=f'{key[0]}:{key[1]}', drawn=count,
                             remaining=int(remaining[key])))
    slack = {f'{part}:{color}': int(pool[(part, color)] - consumed.get((part, color), 0))
             for (part, color) in sorted(pool)}
    return dict(pool_pieces=pool_record['pool_pieces'], allocated_pieces=int(sum(consumed.values())),
                keys=len(pool),
                exhausted_keys=sum(1 for key in pool
                                   if consumed.get(key) and pool[key] == consumed[key]),
                slack=slack, deficits=deficits, draw_down=rows,
                ambiguous_pieces=pool_record['ambiguous_pieces'],
                scope=list(order), truth_used=False, certified=False,
                finding=('Count capacity is satisfied by construction wherever the page quota is '
                         'exact; this audit constrains the allocation, not a pose.'))


def capacity_of_body(body_items, required, lattice=LATTICE_LDU, radius_cells=True):
    """Remaining-capacity look-ahead of one committed body.

    `required` is a mapping from (part, colour) to the count the later pages still
    need. For each distinct *part* - colour does not change geometry - this
    enumerates the collision-free connector mates the body offers and counts the
    distinct one-stud lattice cells they occupy, then compares that with the
    count still required.

    Returns per-key rows plus the aggregate the ranker consumes: the number of
    deficient keys, the total deficit, and the minimum slack.
    """
    from placement_multi_shape_batch import ShapeRegistry
    pieces = sorted({(str(part), int(color)) for part, color in required})
    if not pieces:
        return dict(rows=[], deficient_keys=0, total_deficit=0, min_slack=None,
                    mates=0, locations=0)
    seed = ShapeRegistry(body_items, pieces)
    positions = defaultdict(list)
    for part, matrix in seed.poses:
        positions[part].append(np.asarray(matrix, float)[:3, 3])
    rows, per_part_required = [], Counter()
    for (part, color), count in required.items():
        per_part_required[str(part)] += int(count)
    for part in sorted(per_part_required):
        mates = int(seed.native.get(part, 0))
        cells = grid_cells(positions.get(part, []), lattice) if radius_cells else []
        locations = len(cells)
        need = int(per_part_required[part])
        rows.append(dict(part=part, required=need, base_attached_mates=mates,
                         distinct_locations=locations, slack=locations - need,
                         enumerated_poses=len(positions.get(part, []))))
    deficient = [row for row in rows if row['slack'] < 0]
    return dict(rows=rows, deficient_keys=len(deficient),
                total_deficit=int(sum(-row['slack'] for row in deficient)),
                min_slack=min((row['slack'] for row in rows), default=None),
                mates=int(sum(row['base_attached_mates'] for row in rows)),
                locations=int(sum(row['distinct_locations'] for row in rows)),
                limitations=['A key with no base-attached mate is not proven infeasible: closure '
                             'also mates a piece onto a sibling addition',
                             'Per-key locations ignore cross-key interference, so the count is an '
                             'upper bound on simultaneous placement'])


def rank(candidates, band, key='score'):
    """Reorder only what the objective cannot separate.

    `candidates` are dictionaries carrying the objective score and a capacity
    record. Everything whose score is within `band` (an absolute score
    difference) of the best keeps its objective ordering *unless* capacity
    separates it: inside the band the order becomes fewest deficient keys, then
    smallest total deficit, then largest minimum slack, then the objective score.
    Outside the band nothing moves, so a clear image preference is never
    overridden.
    """
    if not candidates:
        return [], dict(band=band, reordered=0, in_band=0)
    ordered = sorted(candidates, key=lambda row: -row[key])
    best = ordered[0][key]
    in_band = [row for row in ordered if best - row[key] <= band]
    outside = [row for row in ordered if best - row[key] > band]
    promoted = sorted(in_band, key=lambda row: (row['capacity']['deficient_keys'],
                                                row['capacity']['total_deficit'],
                                                -(row['capacity']['min_slack'] or 0),
                                                -row[key]))
    result = promoted + outside
    moved = sum(1 for a, b in zip(result, ordered) if a is not b)
    return result, dict(band=band, in_band=len(in_band), reordered=moved,
                        best_score=best,
                        selected_before=ordered[0].get('label'),
                        selected_after=result[0].get('label'))


def probe_directory(directory, required, band=0.0, lattice=LATTICE_LDU):
    """Capacity of every retained assembly of one placement directory.

    The measurement the brief asks for: does an inventory look-ahead separate the
    bodies an image objective declared tied? Reports each retained body's
    capacity record, the ranking the band would produce, and the objective score
    each body carries.
    """
    from placement_arrow_contacts import read_items
    from placement_backtrack import score_classes
    directory = Path(directory)
    census = score_classes(directory)
    rows = []
    for class_index, entry in enumerate(census['classes']):
        for member in entry['members']:
            if member['duplicate_of'] is not None:
                continue
            body = read_items(directory / member['file'])
            rows.append(dict(label=member['file'], rank=member['rank'], score=entry['score'],
                             score_class=class_index, view=member['view'],
                             capacity=capacity_of_body(body, required, lattice)))
    ordered, summary = rank(rows, band)
    return dict(directory=str(directory), page=census['page'], band=band,
                required={f'{part}:{color}': count for (part, color), count in
                          sorted(required.items())},
                required_pieces=int(sum(required.values())),
                classes=[dict(score=entry['score'], width=len(entry['members']),
                              distinct=entry['distinct_bodies']) for entry in census['classes']],
                candidates=[{k: v for k, v in row.items()} for row in rows],
                ranked=[row['label'] for row in ordered], ranking=summary,
                truth_used=False, certified=False)


def required_after(allocations, pages, after_page=None, include=None):
    """What the booklet still needs after a page, from the allocation alone."""
    counter = Counter()
    for page in pages:
        if after_page is not None and page <= after_page:
            continue
        if include is not None and page not in include:
            continue
        counter.update(allocations.get(page, Counter()))
    return counter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--slots', required=True, help='A slot-assignment record with inventory')
    parser.add_argument('--allocation', required=True, help='A global-assignment record')
    parser.add_argument('--pages', type=int, nargs='*', help='The driven scope, in page order')
    parser.add_argument('--equivalence', type=Path,
                        help='A placement_mould_equivalence table to pool variant names with')
    parser.add_argument('--probe-directory', type=Path, action='append', default=[],
                        help='Score every retained assembly of this placement directory')
    parser.add_argument('--after-page', type=int,
                        help='Capacity is measured against what the pages after this one need')
    parser.add_argument('--band', type=float, default=0.0,
                        help='Absolute objective-score band the capacity ranking may reorder')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    equivalence = {}
    if args.equivalence:
        table = json.loads(args.equivalence.read_text())
        equivalence = {name: entry['canonical'] for entry in table['classes']
                       for name in entry['members']}
    pool_record = slot_pool(args.slots, equivalence)
    allocations = page_allocations(args.allocation)
    pages = args.pages if args.pages else list(allocations)
    payload = dict(pool=pool_record, audit=audit(pool_record, allocations, pages, equivalence),
                   equivalence_source=str(args.equivalence) if args.equivalence else None,
                   truth_used=False, certified=False)
    if args.probe_directory:
        required = required_after(allocations, pages, args.after_page)
        payload['probes'] = [probe_directory(directory, required, args.band)
                             for directory in args.probe_directory]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, default=str))
    print(args.out)


if __name__ == '__main__':
    main()
