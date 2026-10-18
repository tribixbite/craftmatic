"""Which of a page's allocated pieces the drawing shows detached, not attached.

An instruction page can draw a new piece floating above the assembly with an
arrow pointing at where it goes. The main drawing then shows the assembly
*without* that piece, so scoring a complete candidate assembly against that
drawing asks the wrong question: it rewards a candidate that hides the piece
inside the body and penalises the correct one for the pixels the drawing does
not contain yet.

Measured on 40377 page index 17, which draws one black 4x4 round plate placed
and an identical one exploded above it. Scoring the whole two-plate assembly
against the drawing, the reference-equivalent stacked pair loses 0.5409 to
0.5442 - the search hides its second plate at y=-96, buried in the torso.
Scoring the same candidates with one plate withheld, the reference-equivalent
wins 0.5679 to 0.5436. The evidence was never missing; the objective was.

Detection is deliberately narrow. A component is called a detached piece only
when it is separate from the body in the conservative component graph, the page
carries an accepted arrow, and its drawn area matches what one allocated part
covers at this page's own camera. Everything else leaves the page unchanged.
No reference model, set inventory or VLM participates.
"""
import numpy as np

from placement_arrow_mask import conservative_components
from placement_colored_cad import colored_triangles
from placement_page_mask import part_palette
from placement_part_library import PartLibrary

# A drawn piece is rendered at the same camera as the body, so its component
# area is bounded by its own silhouette over the orientations it could take.
# The band is wide because the drawing may clip or overlap the piece slightly.
AREA_LOW = .45
AREA_HIGH = 2.2
# Below this fraction of the body a component is antialiasing debris, not a
# piece: page index 17's two spurious components are 28 and 27 pixels against a
# 52,177-pixel body and a 10,037-pixel plate.
MIN_BODY_FRACTION = .01


def _rotations():
    rotations = []
    for permutation in ((0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)):
        for signs in ((1, 1, 1), (1, 1, -1), (1, -1, 1), (-1, 1, 1),
                      (1, -1, -1), (-1, 1, -1), (-1, -1, 1), (-1, -1, -1)):
            rotation = np.eye(3)[:, permutation] * np.asarray(signs, float)
            if np.linalg.det(rotation) > .5:
                rotations.append(rotation)
    return rotations


def silhouette_area_range(part, color, projection, resolver=None):
    """Pixel area a single part covers at this camera, over all cube yaws.

    Uses the convex hull of the projected triangle vertices, which bounds the
    real silhouette from above and is exact for the compact parts this gate
    cares about; the acceptance band absorbs the difference.
    """
    import cv2
    resolver = resolver or PartLibrary().resolve
    triangles = colored_triangles(part, color, resolver=resolver)['triangles']
    M = np.asarray(projection, float)
    areas = []
    for rotation in _rotations():
        xy = (triangles.reshape(-1, 3) @ rotation.T) @ M.T
        hull = cv2.convexHull(xy.astype(np.float32).reshape(-1, 1, 2))
        areas.append(abs(float(cv2.contourArea(hull))))
    return float(min(areas)), float(max(areas))


def detached_pieces(scene, pieces, projection, palette=None, require_arrow=True):
    """Allocated pieces this drawing shows detached from the assembly.

    Returns a record with `count` (how many allocated pieces to withhold from
    the image-judged phase), the matched (part, colour) keys, and the reason a
    page was left unchanged. Ambiguity is refused, never guessed: a component
    that matches two different allocated shapes withholds nothing.
    """
    keys = list(dict.fromkeys((str(part), int(color)) for part, color in pieces))
    record = dict(count=0, withheld=[], components=[], arrows=0, reason=None,
                  protocol='Conservative component graph, page camera silhouette area and an '
                           'accepted arrow; no reference model or VLM')
    if not keys:
        record['reason'] = 'no_allocated_piece'
        return record
    palette = palette or part_palette(pieces)
    graph = conservative_components(scene, protected_colors=palette['rgb'])
    record['arrows'] = len(graph['arrows'])
    components = graph['components']
    if len(components) < 2:
        record['reason'] = 'single_drawn_component'
        return record
    if require_arrow and not graph['arrows']:
        record['reason'] = 'no_accepted_arrow'
        return record
    body = components[0]['area']
    bands = {key: silhouette_area_range(key[0], key[1], projection) for key in keys}
    quotas = {}
    for part, color in pieces:
        quotas[(str(part), int(color))] = quotas.get((str(part), int(color)), 0) + 1
    withheld = []
    for component in components[1:]:
        area = int(component['area'])
        entry = dict(area=area, bbox=component['bbox'])
        if area < MIN_BODY_FRACTION * body:
            entry['verdict'] = 'below_body_fraction'
            record['components'].append(entry)
            continue
        matches = [key for key, (low, high) in bands.items()
                   if AREA_LOW * low <= area <= AREA_HIGH * high]
        entry['matches'] = ['%s:%d' % key for key in matches]
        if len(matches) != 1:
            entry['verdict'] = 'no_unique_allocated_shape'
            record['components'].append(entry)
            record['reason'] = 'ambiguous_detached_component'
            return dict(record, count=0, withheld=[])
        key = matches[0]
        low, high = bands[key]
        # A component can draw a short stack of the same piece. Count what the
        # drawn area supports, never more than the page allocates.
        drawn = max(1, min(quotas[key] - sum(1 for k in withheld if k == key),
                           int(round(area / max(1., (low + high) / 2)))))
        if quotas[key] - sum(1 for k in withheld if k == key) <= 0:
            entry['verdict'] = 'allocation_exhausted'
            record['components'].append(entry)
            continue
        entry['verdict'] = 'detached_piece'
        entry['pieces'] = drawn
        record['components'].append(entry)
        withheld.extend([key] * drawn)
    if not withheld:
        record['reason'] = record['reason'] or 'no_component_matched_an_allocated_shape'
        return record
    if len(withheld) >= len(pieces):
        # Nothing would remain for the image to judge. That is a legitimate page
        # shape, but it is not what this change is for, so it is refused with a
        # reason instead of silently emptying the search.
        record['reason'] = 'every_allocated_piece_is_detached'
        return dict(record, count=0, withheld=[])
    record['count'] = len(withheld)
    record['withheld'] = ['%s:%d' % key for key in withheld]
    record['withheld_keys'] = [list(key) for key in withheld]
    record['reason'] = 'detached_pieces_withheld_from_image_phase'
    return record


def withhold(pieces, withheld_keys):
    """Split the page allocation into image-judged and arrow-placed pieces."""
    remaining = list(pieces)
    taken = []
    for part, color in withheld_keys:
        key = (str(part), int(color))
        for index, candidate in enumerate(remaining):
            if (str(candidate[0]), int(candidate[1])) == key:
                taken.append(remaining.pop(index))
                break
        else:
            raise ValueError(f'Withheld piece {key} is not in the page allocation')
    return remaining, taken
