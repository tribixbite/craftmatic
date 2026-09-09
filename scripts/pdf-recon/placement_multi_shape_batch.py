"""Multi-shape PDF-allocated pose registry and bounded connector closure.

Generalizes the single-shape registry to a page whose allocation contains
several distinct CAD shapes in several colors. One flat pose bank is produced
across all shapes so that joint cardinality search can enforce a per
(part, colour) quota, cross-shape collision exclusion and cross-shape support.

No reference model, set inventory or VLM participates. A bounded closure is
never claimed to be an exhaustive pose enumeration, and the witnessed support
graph may omit legal edges, which can only lose candidates, never invent them.

`ShapeRegistry` separates the two stages the closure budget couples together:
enumerating base-attached mates, and expanding a bounded number of those as
closure parents. Because the budget stops after `max_closure_parents`, the
*order* parents are visited in decides which second-layer poses exist at all.
Measured on 40377 page index 17, the parent whose child is the stacked second
60474 sits at bank index 3927 of 4147, so no budget below that index can reach
it and the correct pose is absent from the bank however large the pose cap is.
`close(parent_order=...)` therefore accepts an explicit permutation of the
base-attached poses; `placement_evidence_closure` supplies one derived from PDF
silhouette evidence at the page's own registration.
"""
import argparse
import hashlib
import json
import time
from collections import Counter
from pathlib import Path
import numpy as np
from placement_attach_group import make_assembly
from placement_arrow_contacts import read_items
from placement_pdf_group_evidence import load_allocations

CANDIDATE_KINDS = ('CYL', 'CLP', 'FGR', 'GEN')


class ShapeRegistry:
    """Mutable pose bank for one page's allocated shapes.

    Construction enumerates every allocated shape's collision-free connector
    mates on the existing body. `close` then expands bounded closure rounds over
    a caller-chosen parent order. `record` emits the serialisable bank.
    """

    def __init__(self, base, pieces):
        if not pieces:
            raise ValueError('No allocated pieces')
        self.started = time.perf_counter()
        self.parts = sorted({str(part) for part, _ in pieces})
        self.assembly = make_assembly(base)
        self.poses, self.lookup = [], {}
        self.anchored, self.edges = set(), set()
        self.native = {}
        for part in self.parts:
            candidates = self.assembly.candidates(part, kinds=CANDIDATE_KINDS,
                                                  check_collision=True, check_occlusion=False)
            self.native[part] = len(candidates)
            for candidate in candidates:
                index, _ = self.add(part, candidate['T'])
                self.anchored.add(index)
        self.base_attached_count = len(self.poses)
        self.relative = None
        self.processed, self.limited, self.rounds_done = 0, False, 0
        self.round_limited, self.pose_limited, self.per_round_parents = False, False, False
        self.parent_order_source = 'bank_order'

    def add(self, part, T):
        key = (part, tuple(np.round(np.asarray(T, float).flatten(), 5)))
        if key in self.lookup:
            return self.lookup[key], False
        self.lookup[key] = len(self.poses)
        self.poses.append((part, np.asarray(T, float).copy()))
        return len(self.poses) - 1, True

    def branch(self):
        """Independent bank sharing this one's immutable enumeration work.

        Closure order depends on the page registration, and one page can offer
        several drawings, so each attempt needs its own bank. The body assembly
        and the relative-mate table are read-only and are shared rather than
        recomputed; the pose list, index, anchors and edges are copied.
        """
        clone = object.__new__(type(self))
        clone.__dict__.update(self.__dict__)
        clone.poses = list(self.poses)
        clone.lookup = dict(self.lookup)
        clone.anchored = set(self.anchored)
        clone.edges = set(self.edges)
        clone.native = dict(self.native)
        clone.processed, clone.limited, clone.rounds_done = 0, False, 0
        clone.round_limited, clone.pose_limited, clone.per_round_parents = False, False, False
        clone.parent_order_source = 'bank_order'
        return clone

    def relative_mates(self):
        """Relative mates of every child shape on one parent shape at identity.

        The parent's own pose then maps the whole family into the scene frame,
        so this table is computed once per page rather than per parent pose.
        """
        if self.relative is None:
            self.relative = {}
            for parent_part in self.parts:
                single = make_assembly([(parent_part, 15, np.eye(4))])
                for child_part in self.parts:
                    self.relative[(parent_part, child_part)] = single.candidates(
                        child_part, kinds=CANDIDATE_KINDS, check_collision=True,
                        check_occlusion=False)
        return self.relative

    def close(self, closure_rounds=1, max_closure_parents=64, max_poses=8192,
              parent_order=None, order_source=None, per_round_parents=False):
        """Expand bounded closure rounds, visiting parents in `parent_order`.

        `parent_order` is a permutation of the current base-attached pose
        indices. It changes only which parents fit inside the budget, never
        which children are legal, so a better order can add correct poses but
        can never invent an illegal one.

        `max_closure_parents` is counted **globally across rounds** by default,
        and hitting it stops every remaining round. That makes a second hop
        unreachable on any page whose base-attached set is larger than the
        budget: 40377 page index 19 has 3,587 base-attached poses, so round one
        alone exhausts 128 or 512 parents and `closure_rounds_completed` stays 1
        however many rounds are asked for. Its `41740` plate is reachable in one
        hop and the five pieces that mount on *it* need two.

        `per_round_parents=True` counts the budget per round instead, so each
        round expands its own best-ranked prefix. Round two's frontier is the
        children of round one's expanded parents, in the order those parents were
        visited, so an evidence-ordered first round hands the second round an
        inherited ordering rather than an arbitrary one. Pose exhaustion still
        stops everything, because a bank that is already full cannot hold another
        round's children. The default is unchanged, byte for byte.
        """
        relative = self.relative_mates()
        if parent_order is None:
            frontier = list(range(len(self.poses)))
        else:
            frontier = [int(index) for index in parent_order]
            if sorted(frontier) != list(range(self.base_attached_count)):
                raise ValueError('Parent order must be a permutation of the base-attached poses')
            self.parent_order_source = order_source or 'explicit'
        self.per_round_parents = bool(per_round_parents)
        for _ in range(max(0, closure_rounds)):
            next_frontier = []
            round_processed = 0
            for parent in frontier:
                spent = round_processed if per_round_parents else self.processed
                if spent >= max_closure_parents:
                    self.limited = True
                    self.round_limited = True
                    break
                self.processed += 1
                round_processed += 1
                parent_part, parent_T = self.poses[parent]
                for child_part in self.parts:
                    for candidate in relative[(parent_part, child_part)]:
                        T = parent_T @ candidate['T']
                        key = (child_part, tuple(np.round(T.flatten(), 5)))
                        existing = self.lookup.get(key)
                        if existing is not None:
                            if existing != parent:
                                self.edges.add(tuple(sorted((parent, existing))))
                            continue
                        if len(self.poses) >= max_poses:
                            self.limited = True
                            self.pose_limited = True
                            continue
                        if self.assembly.collides(child_part, T):
                            continue
                        child, _ = self.add(child_part, T)
                        next_frontier.append(child)
                        self.edges.add(tuple(sorted((parent, child))))
            self.rounds_done += 1
            # A full pose bank cannot hold another round's children, so that stops
            # everything. A spent per-round parent budget does not: the point of
            # the per-round mode is that the next round gets its own.
            if self.pose_limited or (self.limited and not per_round_parents):
                break
            frontier = next_frontier
            if not frontier:
                break
        return self

    def record(self):
        return dict(parts=self.parts,
                    poses=[dict(part=part, T=T.tolist()) for part, T in self.poses],
                    base_supported=sorted(self.anchored), support_edges=sorted(self.edges),
                    base_attached_count=self.base_attached_count,
                    native_base_candidate_count=self.native,
                    relative_candidate_count={f'{a}->{b}': len(v)
                                              for (a, b), v in (self.relative or {}).items()},
                    closure_parents_processed=self.processed,
                    closure_rounds_completed=self.rounds_done,
                    closure_budget_hit=self.limited, closure_exhaustive=False,
                    closure_parent_budget_hit=self.round_limited,
                    closure_pose_budget_hit=self.pose_limited,
                    closure_per_round_parents=self.per_round_parents,
                    closure_parent_order=self.parent_order_source,
                    seconds=time.perf_counter() - self.started, truth_used=False,
                    candidate_settings=dict(kinds=list(CANDIDATE_KINDS), check_collision=True,
                                            check_occlusion=False, with_slide=False),
                    limitations='Bounded one-parent connector closure across shapes; not a complete '
                                'multi-part occupancy/connectivity search. Native voxel collision, no '
                                'sliding candidates. The support graph is witnessed, not proven '
                                'complete: legal disconnected subsets may be false negatives. '
                                'Base-attached candidates are retained without image pruning. '
                                'Only the first max_closure_parents parents in the recorded order '
                                'are expanded, so second-layer recall depends on that order.')


def registry(base, pieces, closure_rounds=1, max_closure_parents=64, max_poses=8192,
             parent_order=None, order_source=None, per_round_parents=False):
    """Enumerate base-attached poses for every allocated shape, then close.

    `pieces` is the PDF allocation as (part, colour) records; colours do not
    affect geometry and are used only to derive the distinct shape set.
    """
    bank = ShapeRegistry(base, pieces)
    bank.close(closure_rounds, max_closure_parents, max_poses, parent_order, order_source, per_round_parents)
    return bank.record()


def shape_bank(record, pieces):
    """Flat (part, colour) placement bank plus the exact per-key quota."""
    quotas = Counter((str(part), int(color)) for part, color in pieces)
    by_part = {}
    for part, color in quotas:
        by_part.setdefault(part, []).append(int(color))
    placements = []
    for pose_index, entry in enumerate(record['poses']):
        part = str(entry['part'])
        for color in sorted(by_part.get(part, [])):
            placements.append(dict(items=[(part, color, np.asarray(entry['T'], float))],
                                   pose_index=pose_index, part=part, color=color,
                                   key=(part, color)))
    if not placements:
        raise ValueError('No placement matches an allocated shape')
    return placements, dict(quotas)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', required=True, type=Path)
    parser.add_argument('--page', required=True, type=int)
    parser.add_argument('--allocation-run', required=True, type=Path)
    parser.add_argument('--base-run', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--closure-rounds', type=int, default=1)
    parser.add_argument('--max-closure-parents', type=int, default=64)
    parser.add_argument('--max-poses', type=int, default=8192)
    parser.add_argument('--per-round-parents', action='store_true',
                        help='Count the parent budget per closure round instead of '
                             'globally, so a second hop is reachable on a page whose '
                             'base-attached set already exceeds the budget')
    args = parser.parse_args()
    pieces, provenance = load_allocations(args.pdf, args.page, args.allocation_run)
    metadata = json.loads((args.base_run / 'results.json').read_text())
    path = args.base_run / 'model.ldr'
    if (metadata.get('truth_used') is not False or metadata.get('runtime_vlm_calls') != 0
            or metadata.get('pdf_sha256') != provenance['pdf_sha256']):
        raise ValueError('Existing-body provenance mismatch')
    result = registry(read_items(path), pieces, args.closure_rounds,
                      args.max_closure_parents, args.max_poses,
                      per_round_parents=args.per_round_parents)
    result.update(provenance, pdf=str(args.pdf), page=args.page, base_source=str(path),
                  base_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                  allocated_pieces=pieces, runtime_vlm_calls=0)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ('poses', 'support_edges', 'base_supported', 'allocation_evidence')}))
