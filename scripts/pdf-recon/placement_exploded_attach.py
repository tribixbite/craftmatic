"""Place a page's drawn-detached pieces from its arrows, not from its pixels.

A piece the drawing shows floating above the assembly contributes no pixels to
the assembly's own silhouette, so image evidence cannot place it. The arrow
that points at it can: an instruction arrowhead stops at the connector that
receives the piece, and `placement_arrow_contacts` already scores a candidate
pose by how well its incoming female connectors land on a recipient male
connector whose cap projects to an arrowhead.

Measured on 40377 page index 17. With the drawn black plate placed at
(30, -152, 0), the two red arrowheads select the stacked pose (30, -160, 0)
out of 8,192 enumerated poses at 0.51 px mean arrowhead error and score 1.0,
against 0.1244 and 11.34 px for the next distinct translation. That pose is the
one the independent model holds; nothing here reads it.

Abstention is explicit. When no enumerated pose is contact-supported, or every
supported pose collides with the assembly, this returns nothing and the caller
falls back to its previous behaviour rather than guessing.
"""
import numpy as np

from placement_arrow_contacts import batch_score_insertion_targets
from placement_attach_group import make_assembly


def _distinct(transforms, scores, decimals=5):
    """Best-scoring representative of each distinct enumerated transform."""
    best = {}
    for index, T in enumerate(transforms):
        key = tuple(np.round(np.asarray(T, float).flatten(), decimals))
        if key not in best or scores[index] > scores[best[key]]:
            best[key] = index
    return sorted(best.values(), key=lambda i: -scores[i])


def attach_detached(items, pieces, poses, projection, origin, arrows,
                    tolerance_ldu=2, examine=32):
    """Attach each withheld piece at its best arrow-supported enumerated pose.

    `items` is the assembly the drawing shows, `pieces` the withheld
    (part, colour) allocations, and `poses` the page's enumerated pose bank.
    Returns (placed_items, record); `placed_items` is empty when the evidence
    abstains, and the record always says why.
    """
    M = np.asarray(projection, float)
    origin = np.asarray(origin, float)
    current = list(items)
    placed = []
    steps = []
    for part, color in pieces:
        transforms = [np.asarray(entry['T'], float) for entry in poses
                      if str(entry['part']) == str(part)]
        if not transforms:
            steps.append(dict(part=str(part), color=int(color), status='no_enumerated_pose'))
            return [], dict(status='abstained', steps=steps, reason='no_enumerated_pose',
                            arrows=len(arrows))
        evidence = batch_score_insertion_targets(current, str(part), transforms, M, origin,
                                                 arrows, tolerance_ldu=tolerance_ldu)
        scores = np.asarray([row['score'] if row.get('supported') else -1. for row in evidence])
        supported = int(np.sum(scores >= 0))
        if supported == 0:
            steps.append(dict(part=str(part), color=int(color), status='no_contact_support',
                              candidates=len(transforms)))
            return [], dict(status='abstained', steps=steps, reason='no_contact_support',
                            arrows=len(arrows))
        order = [index for index in _distinct(transforms, scores) if scores[index] >= 0]
        assembly = make_assembly(current)
        chosen = None
        for index in order[:examine]:
            if assembly.collides(str(part), transforms[index]):
                continue
            chosen = index
            break
        if chosen is None:
            steps.append(dict(part=str(part), color=int(color), status='every_supported_pose_collides',
                              examined=min(len(order), examine)))
            return [], dict(status='abstained', steps=steps, reason='every_supported_pose_collides',
                            arrows=len(arrows))
        item = (str(part), int(color), transforms[chosen])
        current.append(item)
        placed.append(item)
        runner_up = float(scores[order[1]]) if len(order) > 1 else None
        steps.append(dict(part=str(part), color=int(color), status='placed',
                          score=float(scores[chosen]),
                          mean_head_error_px=evidence[chosen].get('mean_head_error_px'),
                          incoming_gender=evidence[chosen].get('incoming_gender'),
                          translation=[float(v) for v in transforms[chosen][:3, 3]],
                          supported_poses=supported, distinct_supported=len(order),
                          runner_up_score=runner_up,
                          skipped_for_collision=order.index(chosen)))
    return placed, dict(status='placed', steps=steps, arrows=len(arrows),
                        certified=False, truth_used=False,
                        protocol='PDF arrowheads against universal connector caps of the drawn '
                                 'assembly; enumerated poses only',
                        limitations='Pieces are attached one at a time against the whole arrow '
                                    'set, so a page whose arrows split across several incoming '
                                    'pieces is not jointly assigned. Contact evidence abstains '
                                    'rather than declaring a pose impossible.')
