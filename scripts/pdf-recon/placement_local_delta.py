"""Page-local placement evidence: only the pixels an addition can influence.

The whole-drawing scorer answers "does this assembly look like this drawing".
On a page that adds two small plates to a 49-part body that is the wrong
question: 49 parts are common to every candidate, so the answer is dominated by
evidence no candidate can change, and two candidates whose additions differ by
half a stud score within a thousandth of each other.

This module restricts the same PDF evidence to the region an addition can
influence:

* the pixels the addition itself paints in front of everything else, and
* the drawing's own ink that the body alone does not explain.

Both come from the PDF and universal CAD only. No reference model, inventory
pose or VLM participates, and this module selects nothing on its own - it
returns evidence for a caller to weigh.
"""
import cv2
import numpy as np

from placement_palette_classes import palette_labels, material_render
from placement_colored_cad import _rgb

# The addition's own pixels plus a small neighbourhood: an edge one pixel out of
# place still lands inside the band, so the term measures the placement rather
# than the rasteriser's rounding.
REGION_DILATION = 5


def render_layers(scorer, items, projection):
    """Buffers for the assembly the scorer most recently rendered.

    Returns the visible mask, per-pixel owning triangle index, the visible-edge
    mask and per-pixel CAD material class labels (1-based into `colors`).
    """
    layer = scorer.last_layer
    if layer is None:
        raise ValueError('Scorer holds no depth layer; call it with plane_depth=True first')
    rendered = material_render(scorer, items, projection)
    counts = [len(scorer.geometry[(p, str(c))]['triangles']) for p, c, T in items]
    return dict(mask=np.asarray(layer['mask'][0], bool),
                owner=np.asarray(layer['owner'][0], np.int64),
                rgb=np.asarray(layer['rgb'][0], np.uint8),
                edges=np.asarray(scorer.last_edges, bool),
                labels=np.asarray(rendered['labels'], np.uint8),
                colors=list(rendered['colors']),
                triangle_counts=counts,
                triangle_total=int(sum(counts)))


def added_region(base_layer, layer, target_mask, dilation=REGION_DILATION):
    """Pixels an addition can influence, given the body-only render.

    `layer` must be the render of `base_items + additions`, in that order, so
    every triangle index above the body's triangle count belongs to an addition.
    """
    base_triangles = base_layer['triangle_total']
    owner = layer['owner']
    added = layer['mask'] & (owner > base_triangles)
    unexplained = np.asarray(target_mask, bool) & ~base_layer['mask']
    core = added | unexplained
    if not core.any():
        return dict(region=core, changed=added, added=added, unexplained=unexplained, box=None)
    kernel = np.ones((2 * dilation + 1, 2 * dilation + 1), np.uint8)
    region = cv2.dilate(core.astype(np.uint8), kernel) > 0
    yy, xx = np.nonzero(region)
    pad = 4
    box = (max(0, int(yy.min()) - pad), min(region.shape[0], int(yy.max()) + pad + 1),
           max(0, int(xx.min()) - pad), min(region.shape[1], int(xx.max()) + pad + 1))
    return dict(region=region, changed=added, added=added, unexplained=unexplained, box=box)


def _chamfer(first, second, scale=4.):
    if not first.any() or not second.any():
        return 0.
    a = cv2.distanceTransform((~first).astype(np.uint8), cv2.DIST_L2, 3)
    b = cv2.distanceTransform((~second).astype(np.uint8), cv2.DIST_L2, 3)
    distance = (float(a[second].mean()) + float(b[first].mean())) / 2
    return float(np.exp(-distance / scale))


def target_edges(rgb, mask):
    gray = cv2.cvtColor(np.asarray(rgb, np.uint8), cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), .6)
    return (cv2.Canny(gray, 35, 85) > 0) & np.asarray(mask, bool)


def local_evidence(scorer, base_layer, layer, region_record, class_weight=.4,
                   edge_weight=.4, false_weight=.3):
    """Colour, edge and overflow agreement inside the region an addition changes.

    Colour is counted only on pixels where the addition actually *changes* the
    class the body already renders. That restriction is what makes the term
    usable: a red plate laid on a red plate changes no class anywhere, so on
    41624 page index 2 the unrestricted colour IoU and the coverage fraction
    both reward sliding the plate inboard - the body underneath is already red,
    so a piece placed over it is "explained" for free - and they duly rank the
    one-stud-wrong pose first, 0.8598 against 0.8518. With the restriction the
    colour term abstains there and the visible-edge chamfer decides, which
    ranks the reference pose first: 0.7841 against 0.7727 for the pose the run
    selected and 0.7496 for the far edge.

    On 40377 page index 17, where the addition is a black plate on a white head,
    the colour term is measurable and agrees with the edge term: the reference
    pose leads on both (0.2514 and 0.7990 against 0.2228 and 0.6691).

    Two fixtures are not a population. This is a diagnostic instrument that
    reports its parts separately; the caller decides what to weigh.
    """
    region = region_record['region']
    target_mask = scorer.mask
    if not region.any():
        return dict(local_score=0., local_class=None, local_coverage=0., local_false=1.,
                    local_edge=0., local_classes=0, discriminative_pixels=0)
    palette = np.stack([_rgb(c) for c in layer['colors']]).astype(np.uint8)
    target_labels, valid = palette_labels(scorer.rgb, target_mask, palette)
    changed = region & (layer['labels'] != base_layer['labels'])
    ious = []
    for index in range(1, len(layer['colors']) + 1):
        a = (target_labels == index) & valid & changed
        b = (layer['labels'] == index) & valid & changed
        if not (a | b).any():
            continue
        ious.append(float((a & b).sum() / max(1, (a | b).sum())))
    local_class = float(np.mean(ious)) if ious else None
    ink = target_mask & region
    covered = float((ink & layer['mask']).sum() / max(1, ink.sum()))
    painted = layer['mask'] & region
    false = float((painted & ~target_mask).sum() / max(1, painted.sum()))
    edge = _chamfer(layer['edges'] & region, target_edges(scorer.rgb, target_mask) & region)
    # When colour cannot discriminate, its weight moves to the edge term rather
    # than to a constant, so candidates stay comparable.
    weight = class_weight if local_class is not None else 0.
    score = (weight * (local_class or 0.) + (edge_weight + class_weight - weight) * edge
             - false_weight * false)
    return dict(local_score=float(score), local_class=local_class, local_coverage=covered,
                local_false=false, local_edge=edge, local_classes=len(ious),
                discriminative_pixels=int(changed.sum()))
