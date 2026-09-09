"""What kind of build step a page is, measured rather than assumed.

The driver holds one body and treats every page as an addition to it. Three of
40377's pages are not that, and each failed in a way that looked like a camera
or search problem:

* page index 13 draws a four-piece stack that is not attached to anything, and
* page index 20 draws two small part views and a numbered substep, no assembly;
* page index 14 adds no allocated piece at all - it attaches page 13's stack -
  and page index 21 both finishes page 20's subassembly and attaches it.

The discriminator is physical, not a layout guess. A drawing that shows the
current assembly cannot be much smaller than that assembly's own rendered
silhouette. Measured on 40377 with the largest non-panel drawing per page:

    page  12  14  15  16  17  18  19  21  22  32   <- body views
    area  40k 42k 50k 52k 66k 56k 56k 57k 60k 83k

    page  13     20                                <- no body view
    area  18k    8k

So a page whose largest drawing falls below a stated fraction of the body's
rendered area is drawing something else, and the driver should say so in its
journal instead of reporting a camera failure. PDF pixels and universal CAD
only; no reference model, set inventory or VLM participates, and this classifies
pages, it never places anything.
"""
import numpy as np

KINDS = ('addition', 'attachment', 'subassembly', 'no_allocation')


def classify(scene_areas, body_area, allocated, pending=False, ratio=0.6):
    """Return (kind, evidence) for one page.

    `scene_areas` are the foreground pixel counts of the page's candidate
    drawings, `body_area` the rendered silhouette area of the current body at
    the page's camera, `allocated` the number of pieces the PDF allocates to
    this page, and `pending` whether a separate body is waiting to be attached.

    A page with no measurable body area cannot be judged, so it is reported as
    an ordinary addition and left to the existing registration evidence: this
    test only ever adds an explanation, never removes a page the driver could
    otherwise have handled.
    """
    if not 0.0 < ratio <= 1.0:
        raise ValueError('Body-area ratio must lie in (0, 1]')
    largest = max([int(area) for area in scene_areas], default=0)
    threshold = int(ratio * body_area) if body_area else 0
    shows_body = bool(body_area) and largest >= threshold
    evidence = dict(largest_scene_area=largest, body_render_area=int(body_area or 0),
                    body_area_threshold=threshold, shows_body=shows_body,
                    allocated_pieces=int(allocated), pending_body=bool(pending),
                    ratio=ratio, scene_areas=[int(area) for area in scene_areas],
                    truth_used=False, runtime_vlm_calls=0, certified=False,
                    protocol='Largest non-panel drawing foreground against the current body '
                             "silhouette rendered at the page's camera",
                    limitations='A page can legitimately draw the body small, or draw a '
                                'subassembly nearly as large as the body; the ratio is a stated '
                                'threshold, not a proof. An unmeasurable body area abstains to '
                                'the ordinary addition path.')
    if not allocated:
        return ('attachment' if pending and shows_body else 'no_allocation'), evidence
    if not shows_body and body_area:
        return 'subassembly', evidence
    return 'addition', evidence


def body_area(base, matrix, scorer, raster=None):
    """Rendered silhouette area of `base` under `matrix`, origin independent."""
    from placement_evidence_closure import _footprint
    if raster is None:
        from placement_cuda_layers import LayerRasterizer
        raster = LayerRasterizer()
    if not base:
        return 0
    gx, _ = _footprint(base, np.asarray(matrix, float), (0.0, 0.0), scorer, raster)
    return int(len(gx))
