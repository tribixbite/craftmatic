"""Multi-shape PDF-allocated pose registry and bounded connector closure.

Generalizes the single-shape registry to a page whose allocation contains
several distinct CAD shapes in several colors. One flat pose bank is produced
across all shapes so that joint cardinality search can enforce a per
(part, colour) quota, cross-shape collision exclusion and cross-shape support.

No reference model, set inventory or VLM participates. A bounded closure is
never claimed to be an exhaustive pose enumeration, and the witnessed support
graph may omit legal edges, which can only lose candidates, never invent them.
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


def registry(base, pieces, closure_rounds=1, max_closure_parents=64, max_poses=8192):
    """Enumerate base-attached poses for every allocated shape, then close once.

    `pieces` is the PDF allocation as (part, colour) records; colours do not
    affect geometry and are used only to derive the distinct shape set.
    """
    if not pieces:
        raise ValueError('No allocated pieces')
    started = time.perf_counter()
    parts = sorted({str(part) for part, _ in pieces})
    assembly = make_assembly(base)
    poses, lookup = [], {}
    anchored, edges = set(), set()

    def add(part, T):
        key = (part, tuple(np.round(np.asarray(T, float).flatten(), 5)))
        if key in lookup:
            return lookup[key], False
        lookup[key] = len(poses)
        poses.append((part, np.asarray(T, float).copy()))
        return len(poses) - 1, True

    native = {}
    for part in parts:
        candidates = assembly.candidates(part, kinds=CANDIDATE_KINDS,
                                         check_collision=True, check_occlusion=False)
        native[part] = len(candidates)
        for candidate in candidates:
            index, _ = add(part, candidate['T'])
            anchored.add(index)
    base_count = len(poses)

    # Relative mates of every child shape on one parent shape at identity. The
    # parent's own pose then maps the whole family into the scene frame.
    relative = {}
    for parent_part in parts:
        single = make_assembly([(parent_part, 15, np.eye(4))])
        for child_part in parts:
            relative[(parent_part, child_part)] = single.candidates(
                child_part, kinds=CANDIDATE_KINDS, check_collision=True, check_occlusion=False)

    frontier = list(range(len(poses)))
    processed, limited, rounds_done = 0, False, 0
    for _ in range(max(0, closure_rounds)):
        next_frontier = []
        for parent in frontier:
            if processed >= max_closure_parents:
                limited = True
                break
            processed += 1
            parent_part, parent_T = poses[parent]
            for child_part in parts:
                for candidate in relative[(parent_part, child_part)]:
                    T = parent_T @ candidate['T']
                    key = (child_part, tuple(np.round(T.flatten(), 5)))
                    existing = lookup.get(key)
                    if existing is not None:
                        if existing != parent:
                            edges.add(tuple(sorted((parent, existing))))
                        continue
                    if len(poses) >= max_poses:
                        limited = True
                        continue
                    if assembly.collides(child_part, T):
                        continue
                    child, _ = add(child_part, T)
                    next_frontier.append(child)
                    edges.add(tuple(sorted((parent, child))))
        rounds_done += 1
        if limited:
            break
        frontier = next_frontier
        if not frontier:
            break
    return dict(parts=parts,
                poses=[dict(part=part, T=T.tolist()) for part, T in poses],
                base_supported=sorted(anchored), support_edges=sorted(edges),
                base_attached_count=base_count, native_base_candidate_count=native,
                relative_candidate_count={f'{a}->{b}': len(v) for (a, b), v in relative.items()},
                closure_parents_processed=processed, closure_rounds_completed=rounds_done,
                closure_budget_hit=limited, closure_exhaustive=False,
                seconds=time.perf_counter() - started, truth_used=False,
                candidate_settings=dict(kinds=list(CANDIDATE_KINDS), check_collision=True,
                                        check_occlusion=False, with_slide=False),
                limitations='Bounded one-parent connector closure across shapes; not a complete '
                            'multi-part occupancy/connectivity search. Native voxel collision, no '
                            'sliding candidates. The support graph is witnessed, not proven '
                            'complete: legal disconnected subsets may be false negatives. '
                            'Base-attached candidates are retained without image pruning.')


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
    args = parser.parse_args()
    pieces, provenance = load_allocations(args.pdf, args.page, args.allocation_run)
    metadata = json.loads((args.base_run / 'results.json').read_text())
    path = args.base_run / 'model.ldr'
    if (metadata.get('truth_used') is not False or metadata.get('runtime_vlm_calls') != 0
            or metadata.get('pdf_sha256') != provenance['pdf_sha256']):
        raise ValueError('Existing-body provenance mismatch')
    result = registry(read_items(path), pieces, args.closure_rounds,
                      args.max_closure_parents, args.max_poses)
    result.update(provenance, pdf=str(args.pdf), page=args.page, base_source=str(path),
                  base_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                  allocated_pieces=pieces, runtime_vlm_calls=0)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ('poses', 'support_edges', 'base_supported', 'allocation_evidence')}))
