"""Score a page-scoped allocation against a reference model's own steps.

Evaluation-only. A global piece count cannot see an on-ramp regression at all:
a solver that reallocates one slot keeps the whole multiset exactly and can
still put the piece on the wrong page. This asks how much of an allocation's
page structure a reference step structure accounts for, so two allocations of
one fixture are comparable on one scale.

One page is not one step - 41601's PDF page 2 carries the reference's steps 1
AND 2 - so a page-to-step assignment understates a CORRECT allocation, measured
doing exactly that. The alignment here is order-preserving instead: each page in
booklet order takes a contiguous run of reference steps, by dynamic programming
over accounted pieces. Monotonicity is an assumption about the reference, so the
weaker unordered assignment is reported beside it as a control.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

sys.path.insert(0, str(Path(__file__).resolve().parent))


def reference_steps(path):
    """Per-step (part, colour) multisets of an LDraw reference, top level."""
    from placement_part_library import PartLibrary
    from placement_population_table import canonical_name
    library = PartLibrary()
    steps, current = [], Counter()
    for raw in Path(path).read_text(errors='ignore').splitlines():
        line = raw.strip()
        if line.upper().startswith('0 STEP'):
            if current:
                steps.append(current)
            current = Counter()
            continue
        if not line.startswith('1 '):
            continue
        fields = line.split()
        if len(fields) < 15:
            continue
        name = fields[14].rsplit('.', 1)[0]
        current[(canonical_name(name, library), int(fields[1]))] += 1
    if current:
        steps.append(current)
    return steps


def page_bags(allocation):
    """Allocated (part, colour) multiset per page, withheld class rows included."""
    bags = {}
    for row in allocation['evidence']:
        bags.setdefault(int(row['page']), Counter())[(str(row['part']), int(row['color']))] += int(row['qty'])
    for row in allocation.get('withheld_classes') or []:
        bags.setdefault(int(row['page']), Counter())[('<withheld>', int(row['color']))] += int(row['qty'])
    return bags


def overlap(a, b):
    return sum(min(count, b.get(key, 0)) for key, count in a.items())


def unordered_assignment(bags, pages, steps):
    """Best page-to-single-step matching, kept as the weaker control."""
    matrix = np.zeros((len(pages), max(len(steps), len(pages))), float)
    for i, page in enumerate(pages):
        for j, step in enumerate(steps):
            matrix[i, j] = -overlap(bags[page], step)
    rows, cols = linear_sum_assignment(matrix)
    return int(sum(overlap(bags[pages[i]], steps[j]) for i, j in zip(rows, cols) if j < len(steps)))


def monotone_alignment(bags, pages, steps):
    """Each page in order takes a contiguous run of reference steps.

    dp[i][j]: best accounted pieces using the first i pages and the first j
    steps. A page may take an empty run, so a page the reference does not
    separate costs nothing, and a step no page claims is simply unused.
    """
    negative = float('-inf')
    dp = [[negative] * (len(steps) + 1) for _ in range(len(pages) + 1)]
    back = [[None] * (len(steps) + 1) for _ in range(len(pages) + 1)]
    dp[0][0] = 0
    for i in range(len(pages)):
        bag = bags[pages[i]]
        for j in range(len(steps) + 1):
            if dp[i][j] == negative:
                continue
            run = Counter()
            for k in range(j, len(steps) + 1):
                if k > j:
                    run.update(steps[k - 1])
                value = dp[i][j] + overlap(bag, run)
                if value > dp[i + 1][k]:
                    dp[i + 1][k] = value
                    back[i + 1][k] = j
    end = max(range(len(steps) + 1), key=lambda j: dp[len(pages)][j])
    runs, cursor = [], end
    for i in range(len(pages), 0, -1):
        start = back[i][cursor]
        runs.append((start, cursor))
        cursor = start
    runs.reverse()
    return int(dp[len(pages)][end]), runs


def audit(allocation_path, truth_path):
    allocation = json.loads(Path(allocation_path).read_text())
    steps = reference_steps(truth_path)
    bags = page_bags(allocation)
    pages = sorted(bags)
    if not pages or not steps:
        raise ValueError('Allocation or reference carries no grouped pieces')
    control = unordered_assignment(bags, pages, steps)
    matched, runs = monotone_alignment(bags, pages, steps)
    exact, detail = 0, []
    for page, (start, stop) in zip(pages, runs):
        bag = bags[page]
        run = Counter()
        for index in range(start, stop):
            run.update(steps[index])
        common = overlap(bag, run)
        if common == sum(bag.values()) == sum(run.values()):
            exact += 1
        detail.append(dict(page=page, steps=[start, stop],
                           page_pieces=sum(bag.values()), step_pieces=sum(run.values()),
                           accounted=common,
                           unaccounted=sorted(('%s:%s' % (part, color), count - run.get((part, color), 0))
                                              for (part, color), count in bag.items()
                                              if count - run.get((part, color), 0) > 0)))
    total = sum(sum(bag.values()) for bag in bags.values())
    return dict(allocation=str(allocation_path), truth=str(truth_path),
                pages=len(pages), reference_steps=len(steps), allocated_pieces=total,
                accounted_pieces=matched, unordered_assignment_pieces=control,
                exactly_matched_pages=exact,
                accounted_fraction=matched / total if total else 0.0, rows=detail,
                truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                scope='Evaluation only. A high fraction says the allocation groups pieces the way '
                      'the reference groups them; it is not placement accuracy and says nothing '
                      'about poses.',
                limitations='The alignment assumes the reference steps run in booklet order; a '
                            'reference with no step markers, or one that reorders, lowers the '
                            'fraction for reasons that are not allocation errors. Compare two '
                            'allocations of the SAME fixture, never two fixtures.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('allocations', nargs='+', type=Path)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = dict(truth=args.truth, allocations=[])
    for path in args.allocations:
        record = audit(path, args.truth)
        report['allocations'].append(record)
        print('%-44s pages %2d pieces %3d accounted %3d (%.3f) exact-pages %2d control %3d'
              % (path.parent.name, record['pages'], record['allocated_pieces'],
                 record['accounted_pieces'], record['accounted_fraction'],
                 record['exactly_matched_pages'], record['unordered_assignment_pieces']))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))
    print(args.out)


if __name__ == '__main__':
    main()
