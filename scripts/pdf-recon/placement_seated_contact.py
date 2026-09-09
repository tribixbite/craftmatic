"""Physical seating as a tie-break when the image cannot separate two poses.

40377 page index 18 adds one 4x4 plate to a 51-part body. Both the reference
pose and a pose 4 LDU shallower are enumerated, both survive screening, and the
whole-drawing scorer prefers the wrong one by **0.0012** - 0.488517 against
0.487312, a quarter of one per cent. The channels disagree about it: colour
prefers the reference (0.265415 against 0.259430) and the visible-edge chamfer
prefers the wrong pose (0.717604 against 0.709210), and the edge term is larger.
Restricting the evidence to the region the addition changes does not help; it
splits the same way and more strongly.

An image objective is the wrong instrument for a 4 LDU depth difference on a
plate mostly hidden behind the body it mounts on, so this module measures the
physical question instead. **On page 18 it does not separate them either, and
that is the measured result.**

| pose on page 18          | engaged mates | voxel contacts | voxel overlap |
| ------------------------ | ------------: | -------------: | ------------: |
| selected (0, -112, -44)  |            12 |            653 |           281 |
| reference (0, -112, -48) |            12 |            645 |           364 |
| a third (0, -132, -48)   |            10 |            594 |           303 |

Both candidates engage twelve connectors: they are two *physically valid*
seatings of the same plate on different stud rows of the same body, not a seated
pose against a proud one. So seating cannot decide page 18, and neither can any
of the three measures - the voxel-contact column even prefers the wrong pose.

The first version of this module ranked by that contact column and claimed a 16%
margin for the reference. That number was wrong: it came from counting the
additions' *overlapping* voxels' neighbours as contacts, so it was measuring
interpenetration rather than seating. Excluding overlap, as `seated_contact` now
does, the margin is 1% the other way. The correction is recorded rather than
deleted because the wrong version looked convincing.

What remains, then, is that seating is a real instrument with a real scope and
page 18 is outside it. It stays because the case it addresses - a candidate that
leaves its joint proud engages no connector at all - is common and cheap to
exclude, and because the ranking key is now the exact predicate
`Assembly._consume_coincident` uses rather than a voxel proxy.

It is a **tie-break, never an objective**. Round two measured that maximising
occupancy alone buries pieces inside the model, because a hidden piece explains
the drawing better than a placed one; maximising seating alone would do the same.
So it applies only inside a stated tolerance band below the best image score, and
only among candidates that are otherwise ranked equally - same number of
arrow-attached pieces - so it can reorder near-ties and can never promote a
candidate the image rejected. Off by default.

Seating is comparable only between alternative poses of the same pieces, which is
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


def _world_connectors(items, owner_offset=0):
    """Each item's connectors in world coordinates, as `recon_v8` builds them."""
    from recon_v8.assembly import WorldConn, part_conns
    out = []
    for index, (part, color, transform) in enumerate(items):
        matrix = np.asarray(transform, float)
        for connector in part_conns(str(part)):
            out.append(WorldConn(owner_offset + index, connector, matrix))
    return out


def engaged_mates(body_items, added_items):
    """How many of the additions' connectors actually mate with something.

    This is the physical question a voxel proxy only approximates: a pose that
    leaves its joint 4 LDU proud engages no connector, and a seated one engages
    every stud it covers. It reimplements `Assembly._consume_coincident`'s exact
    predicate - opposite gender, compatible end radius, aligned axis, coincident
    reference point - against tolerances imported from `recon_v8.assembly`, so
    the two cannot drift apart, and without mutating an assembly per candidate.

    Mates between two added pieces count too: a page that adds a stack is more
    seated when its own pieces engage each other.
    """
    from recon_v8.assembly import AXIS_DOT, MATE_POS_TOL, RADIUS_TOL
    body = _world_connectors(body_items)
    added = _world_connectors(added_items, owner_offset=len(body_items))
    engaged, pairs = 0, 0
    for connector in added:
        if connector.kind != 'CYL' or connector.gender not in 'MF':
            continue
        for other in body + added:
            if other is connector or other.owner == connector.owner:
                continue
            if other.kind != 'CYL' or other.gender == connector.gender:
                continue
            if abs((other.r_end or other.radius) - (connector.r_end or connector.radius)) \
                    > RADIUS_TOL:
                continue
            if float(other.axis @ connector.axis) < AXIS_DOT:
                continue
            if float(np.linalg.norm(other.pos - connector.pos)) > MATE_POS_TOL:
                continue
            engaged += 1
            pairs += 1 if other.owner >= len(body_items) else 0
            break
    return dict(engaged=int(engaged), internal_pairs=int(pairs),
                added_connectors=int(len(added)), body_connectors=int(len(body)))


def seated_contact(body_items, added_items):
    """How seated the additions are: engaged connectors first, contact beside it.

    `contacts` counts face-adjacent voxel pairs between the additions' own
    voxels and the body's, excluding voxels that overlap. It is reported for
    inspection and is *not* the ranking key: a first attempt used it and the
    apparent 16% margin on page 18 turned out to come from overlapping voxels,
    i.e. from interpenetration rather than from seating. `overlap` is reported
    for the same reason - the coarse lattice counts a seated stud as an overlap,
    and the collision test upstream is what rejects a real one.
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
    record = dict(contacts=int(contacts), overlap=int(len(added & body)),
                  added_voxels=int(len(added)), body_voxels=int(len(body)))
    record.update(engaged_mates(body_items, added_items))
    return record


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
        'engaged', -1))
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
