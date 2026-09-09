"""Prefer the more fully seated joint when the image cannot separate two poses.

40377 page index 18 adds one 4x4 plate to a 51-part body. Both the reference
pose and a pose 4 LDU shallower are enumerated, both survive screening, and the
whole-drawing scorer prefers the wrong one by **0.0012** - 0.488517 against
0.487312, a quarter of one per cent. The channels disagree about it: colour
prefers the reference (0.265415 against 0.259430) and the visible-edge chamfer
prefers the wrong pose (0.717604 against 0.709210), and the edge term is larger.
Restricting the evidence to the region the addition changes does not help; it
splits the same way and more strongly.

An image objective is the wrong instrument for a 4 LDU depth difference on a
plate that is mostly behind the body it mounts on. A physical one separates them
easily. LEGO joints seat: a piece is pressed home until its faces touch, and a
pose that leaves the same joint 4 LDU proud has measurably less surface contact.
Measured on those two candidates against the page-17 body, in the coarse voxel
model the collision test already uses:

| pose                    | own voxels | face contacts with the body |
| ----------------------- | ---------: | --------------------------: |
| selected (0, -112, -44) |      1,310 |                       1,949 |
| reference (0, -112, -48)|      1,302 |                     **2,256** |

A 16% margin where the image margin is 0.25%.

This is a **tie-break, never an objective**. Round two measured that maximising
occupancy alone buries pieces inside the model, because a hidden piece explains
the drawing better than a placed one; maximising contact alone would do the same.
So it applies only inside a stated tolerance band below the best image score, and
only among candidates that are otherwise ranked equally - same number of
arrow-attached pieces - so it can reorder near-ties and can never promote a
candidate the image rejected.

Contact is comparable only between alternative poses of the same pieces, which is
exactly this scope: every candidate in a band adds the same multiset of parts to
the same body. It is not comparable between different part sets, and nothing here
compares those.

No reference model, set inventory or VLM participates.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, 'C:/git/clego')

# Six-neighbour face adjacency in the collision voxel lattice. Face adjacency,
# not edge or corner: two bricks that merely touch along an edge are not seated
# against one another.
FACES = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
_cache: dict = {}


def _voxels(part, color, transform):
    from recon_v8.assembly import Placed
    key = (str(part), int(color), tuple(np.round(np.asarray(transform, float).flatten(), 4)))
    if key not in _cache:
        _cache[key] = frozenset(Placed(str(part), int(color),
                                       np.asarray(transform, float)).voxels())
    return _cache[key]


def seated_contact(body_items, added_items):
    """Face-adjacent voxel pairs between the additions and the body.

    `overlap` is reported beside it because the coarse lattice counts a seated
    stud as an overlap; it is descriptive, and the collision test upstream is
    what actually rejects a real interpenetration.
    """
    body = set()
    for part, color, transform in body_items:
        body |= _voxels(part, color, transform)
    added = set()
    for part, color, transform in added_items:
        added |= _voxels(part, color, transform)
    outside = added - body
    contacts = 0
    for x, y, z in outside:
        for dx, dy, dz in FACES:
            if (x + dx, y + dy, z + dz) in body:
                contacts += 1
    return dict(contacts=int(contacts), overlap=int(len(added & body)),
                added_voxels=int(len(added)), body_voxels=int(len(body)))


def reorder(rows, tolerance, score_of=None, contacts_of=None, group_of=None):
    """Reorder only the leading near-tie band by contact, preserving the rest.

    `rows` must already be in the order the image objective chose. A row enters
    the band when it shares the leading row's group key and its score is within
    `tolerance` times the leading absolute score. Returns (rows, record).
    """
    if not 0.0 <= tolerance < 1.0:
        raise ValueError('Seated tolerance must be a fraction below one')
    if not rows or not tolerance:
        return list(rows), dict(applied=False, reason='no rows or zero tolerance',
                                band=0, moved=False)
    score_of = score_of or (lambda row: row['evidence'].get(
        'combined_score', row['evidence']['score']))
    contacts_of = contacts_of or (lambda row: (row['evidence'].get('seated') or {}).get(
        'contacts', -1))
    group_of = group_of or (lambda row: row.get('attached_pieces', 0))
    best = score_of(rows[0])
    key = group_of(rows[0])
    limit = abs(best) * float(tolerance)
    band = [row for row in rows if group_of(row) == key and best - score_of(row) <= limit]
    rest = [row for row in rows if row not in band]
    if any(contacts_of(row) < 0 for row in band):
        return list(rows), dict(applied=False, reason='a candidate carries no contact measurement',
                                band=len(band), moved=False)
    ordered = sorted(band, key=lambda row: (-contacts_of(row), -score_of(row)))
    moved = ordered[0] is not rows[0]
    return ordered + rest, dict(applied=True, tolerance=float(tolerance), band=len(band),
                                score_window=float(limit), leading_score=float(best),
                                leading_contacts=int(contacts_of(rows[0])),
                                chosen_score=float(score_of(ordered[0])),
                                chosen_contacts=int(contacts_of(ordered[0])), moved=bool(moved),
                                truth_used=False, runtime_vlm_calls=0, certified=False,
                                protocol='Within a stated score band below the image best, and only '
                                         'among candidates the earlier keys rank equally, prefer '
                                         'the assembly whose additions have more face-adjacent '
                                         'contact with the body',
                                limitations='A tie-break on a coarse voxel lattice, not a seating '
                                            'proof. Contact is comparable only between alternative '
                                            'poses of the same pieces. A wider band would let '
                                            'contact override the image, which round two measured '
                                            'to bury pieces inside the model.')
