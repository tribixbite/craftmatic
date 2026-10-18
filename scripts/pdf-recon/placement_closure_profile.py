"""Where the bounded closure's parent-expansion time actually goes.

Round six established that no page of either fixture has ever finished its
candidate enumeration: the 128-parent budget was hit on all 40 driven pages, and
`unreachable` (the reference pose absent from the page's own bank) is the
largest failure class on both. Raising the budget is "a number in a config" only
if the closure is affordable at the budget that finishes it, and nobody had
measured what a parent costs or what it is spent on.

This module rebuilds one page's `ShapeRegistry` exactly as the driver does -
from the registry the run itself wrote, so the body, the allocation and the
candidate settings are the run's - and then times the closure loop with the
three stages separated:

* `enumerate` - `ShapeRegistry.__init__`: every allocated shape's collision-free
  connector mates on the existing body. Paid once per page, before any budget.
* `relative` - the per-parent-shape child mate table, computed once.
* `expand` - the closure loop itself, split into `transform` (the 4x4 product,
  the rounding and the bank lookup, paid for every candidate) and `collision`
  (`Assembly.collides`, paid only for candidates whose key is new).

The registry's own `seconds` field cannot answer this. In evidence mode the
driver builds one seed registry per page and calls `branch()` per drawing, and
`branch` copies `started` from the seed - so the recorded seconds span the
registration and ranking work done between them. Measured on 40377 page 18 that
field reads 129.7 s for a closure this tool times at a fraction of it.

No reference model, set inventory or VLM participates: the inputs are the run's
own registry JSON and the body LDR it names.
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_arrow_contacts import read_items
from placement_multi_shape_batch import ShapeRegistry, CANDIDATE_KINDS


def profile_closure(bank, max_parents, max_poses):
    """Time one closure round's parent expansion with the stages separated.

    Mirrors `ShapeRegistry.close(closure_rounds=1)` statement for statement,
    including the pose-cap `continue` that skips the collision test once the
    bank is full, so the counts describe the loop the driver runs rather than a
    simplified stand-in. The bank is mutated exactly as `close` would mutate it.
    """
    relative_started = time.perf_counter()
    relative = bank.relative_mates()
    relative_seconds = time.perf_counter() - relative_started

    transform_seconds = collision_seconds = 0.0
    candidates = duplicates = collision_calls = rejected = added = 0
    parents = 0
    started = time.perf_counter()
    for parent in range(min(max_parents, bank.base_attached_count)):
        parents += 1
        bank.processed += 1
        parent_part, parent_T = bank.poses[parent]
        for child_part in bank.parts:
            for candidate in relative[(parent_part, child_part)]:
                mark = time.perf_counter()
                T = parent_T @ candidate['T']
                key = (child_part, tuple(np.round(T.flatten(), 5)))
                existing = bank.lookup.get(key)
                transform_seconds += time.perf_counter() - mark
                candidates += 1
                if existing is not None:
                    duplicates += 1
                    if existing != parent:
                        bank.edges.add(tuple(sorted((parent, existing))))
                    continue
                if len(bank.poses) >= max_poses:
                    bank.limited = bank.pose_limited = True
                    continue
                mark = time.perf_counter()
                hit = bank.assembly.collides(child_part, T)
                collision_seconds += time.perf_counter() - mark
                collision_calls += 1
                if hit:
                    rejected += 1
                    continue
                child, _ = bank.add(child_part, T)
                added += 1
                bank.edges.add(tuple(sorted((parent, child))))
    total = time.perf_counter() - started
    return dict(parents_expanded=parents, candidates=candidates, duplicate_keys=duplicates,
                collision_calls=collision_calls, collision_rejections=rejected,
                poses_added=added, bank_poses=len(bank.poses),
                relative_seconds=relative_seconds, expand_seconds=total,
                transform_seconds=transform_seconds, collision_seconds=collision_seconds,
                other_seconds=total - transform_seconds - collision_seconds,
                seconds_per_parent=total / parents if parents else None,
                seconds_per_collision=collision_seconds / collision_calls if collision_calls else None,
                milliseconds_per_candidate=1000 * transform_seconds / candidates if candidates else None)


def load_page(registry_path):
    """The run's own body and allocation, with the registry's hashes enforced."""
    record = json.loads(Path(registry_path).read_text())
    if record.get('truth_used') is not False or record.get('runtime_vlm_calls') != 0:
        raise ValueError('Registry does not attest a truth-free, VLM-free run')
    base_path = Path(record['base_source'])
    digest = hashlib.sha256(base_path.read_bytes()).hexdigest()
    if digest != record['base_sha256']:
        raise ValueError(f'Body changed on disk since the run: {base_path}')
    pieces = [(str(part), int(color)) for part, color in record['allocated_pieces']]
    return record, read_items(base_path), pieces


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--registry', type=Path, required=True, nargs='+',
                        help="Registry JSON written by the run (registry-NN.json)")
    parser.add_argument('--parents', type=int, default=128,
                        help='Parents to expand while timing (default: the shipped budget)')
    parser.add_argument('--max-poses', type=int, default=8192)
    parser.add_argument('--out', type=Path, default=None)
    args = parser.parse_args()

    rows = []
    for path in args.registry:
        record, base, pieces = load_page(path)
        started = time.perf_counter()
        bank = ShapeRegistry(base, pieces)
        enumerate_seconds = time.perf_counter() - started
        if bank.base_attached_count != record['base_attached_count']:
            raise ValueError('Rebuilt base-attached bank differs from the saved registry '
                             f"({bank.base_attached_count} vs {record['base_attached_count']})")
        row = profile_closure(bank, args.parents, args.max_poses)
        row.update(registry=str(path), page=record['page'], parts=bank.parts,
                   base_attached=bank.base_attached_count,
                   body_parts=len(base), enumerate_seconds=enumerate_seconds,
                   relative_candidates={f'{a}->{b}': len(v)
                                        for (a, b), v in bank.relative.items()})
        # What finishing this page's own first round would cost at this rate,
        # with the pose cap left where it is. It is a projection from a measured
        # per-parent rate, not a measurement of the full run.
        row['projected_full_round_seconds'] = (
            row['seconds_per_parent'] * bank.base_attached_count
            if row['seconds_per_parent'] else None)
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items()
                          if k not in ('relative_candidates',)}, default=str))

    report = dict(rows=rows, parents=args.parents, max_poses=args.max_poses,
                  candidate_kinds=list(CANDIDATE_KINDS), truth_used=False,
                  runtime_vlm_calls=0, certified=False,
                  protocol='Rebuild the page ShapeRegistry from the run\'s own registry JSON and '
                           'time one closure round with transform/lookup separated from the '
                           'collision predicate; per-call timing via time.perf_counter',
                  limitations='Per-candidate perf_counter calls add overhead to the very loop '
                              'they measure, so the stage SHARES are the result and the absolute '
                              'total is an upper bound. Projections assume a constant per-parent '
                              'rate; the real rate falls as the bank fills, because a duplicate '
                              'key costs no collision test. Timed on one machine under whatever '
                              'else it was running.')
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
