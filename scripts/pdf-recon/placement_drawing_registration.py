"""Register a page against the previous page's drawing, not against the body.

Every camera the driver has ever accepted passed through the emitted assembly:
the page's own stud-row matrices are ranked by how well the rendered body's
stable-colour pixels template-match the drawing, and the accepted origin is the
translation that maximises that match. So a body carrying one wrong part
registers worse, a worse registration places worse, and the error compounds
forwards. Round three measured that mechanism on 40377 page index 18 - the
carried camera was rejected because the body overflowed the drawing by 4,007
pixels, the page fell back to its own stud rows at 12.6% small, and page 19
inherited that scale.

The drawings themselves carry the same information and do not depend on the
body being right. Consecutive instruction pages draw the same assembly plus the
pieces the step adds, so the similarity that maps one drawing's foreground onto
the next maps the previous page's *accepted registration* onto this page:

    p_current = s * p_previous + t                     (measured by `align`)
    p_previous = M_previous @ X + o_previous           (the accepted registration)
    => M_current = s * M_previous,  o_current = s * o_previous + t

`placement_drawing_scale.align` already measures (s, t) from PDF pixels alone,
and reported 0.99 to 1.03 at IoU 0.89 to 0.99 across 40377 including a
non-adjacent pair. Round three used only its scale, as one extra matrix among
many that body-template registration still had to choose between. This module
uses the whole similarity, so the resulting camera *and origin* never touch the
emitted body.

What the body is still used for is unchanged and deliberate: containment
refinement, the camera acceptance test, collision and scoring. A propagated
registration is a proposal like every other one - it inherits whatever error the
previous accepted registration held, and it is only as good as the assumption
that the two drawings share a viewpoint. That assumption is measured, not
assumed: a page drawn from a different angle fits badly and the IoU says so, and
`min_iou` refuses rather than propagating a bad alignment.

No reference model, set inventory or VLM participates.
"""
import numpy as np

from placement_drawing_scale import DEFAULT_LADDER, align

# Below this silhouette agreement the two drawings are not the same assembly at
# the same viewpoint, and propagating the previous origin through the fit would
# be arithmetic on an alignment that did not happen. Measured on 40377, adjacent
# instruction drawings reach 0.959 to 0.987 and even the non-adjacent 19->22
# pair reaches 0.894.
MIN_IOU = 0.60


def propagate(previous_mask, current_mask, projection, origin,
              scales=DEFAULT_LADDER, keep=2, min_iou=MIN_IOU, rotation_index=None):
    """Camera hypotheses for one drawing from the previous drawing's registration.

    `projection` and `origin` are the previous page's *accepted* registration in
    its own drawing's pixel frame, so that ``pixel = projection @ world +
    origin``. `previous_mask` must be the target mask that registration was
    accepted against, and `current_mask` this page's target mask.

    Returns a record whose `hypotheses` are in the shape
    `placement_origin_refine.refine` consumes - `projection`, `origin`, `score`
    and `rotation_index` - ordered by the silhouette agreement of the alignment
    that produced them. The record always says why it produced none.
    """
    if keep < 1 or int(keep) != keep:
        raise ValueError('Keep count must be a positive integer')
    if not 0.0 <= min_iou <= 1.0:
        raise ValueError('Minimum silhouette agreement must be a fraction')
    previous_mask = np.asarray(previous_mask, bool)
    current_mask = np.asarray(current_mask, bool)
    M = np.asarray(projection, float)
    if M.shape != (2, 3):
        raise ValueError('A native projection is 2x3')
    o = np.asarray(origin, float)
    if o.shape != (2,):
        raise ValueError('An origin is a pixel pair')
    if not previous_mask.any() or not current_mask.any():
        return _empty('One of the two drawings has no foreground pixels')
    fit = align(previous_mask, current_mask, scales=scales)
    if fit['iou'] < min_iou:
        return _empty(f"Best silhouette agreement {fit['iou']:.4f} is below {min_iou:.2f}, so the "
                      'two drawings are not the same assembly at the same viewpoint', fit=fit)
    # Every ladder entry is a legitimate proposal; the optimum can be a hair
    # above its neighbour and containment is a stronger test than IoU. Keep the
    # best few distinct scales rather than only the argmax.
    ladder = sorted(fit['ladder'], key=lambda row: -row['iou'])[:int(keep)]
    hypotheses = []
    for row in ladder:
        scale = float(row['scale'])
        offset = np.asarray(row['offset'], float)
        hypotheses.append(dict(score=float(row['iou']), projection=(M * scale).tolist(),
                               origin=(o * scale + offset).tolist(),
                               rotation_index=rotation_index, source='drawing_to_drawing',
                               drawing_scale=scale, drawing_offset=[int(v) for v in row['offset']],
                               drawing_iou=float(row['iou'])))
    return dict(status='propagated', hypotheses=hypotheses, best_scale=fit['scale'],
                best_iou=fit['iou'], best_offset=fit['offset'], min_iou=min_iou,
                ladder=fit['ladder'], previous_pixels=int(previous_mask.sum()),
                current_pixels=int(current_mask.sum()),
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='The previous page\'s accepted registration composed with the uniform '
                         'similarity that maximises silhouette agreement between the two drawings; '
                         'the emitted body takes no part in choosing this camera or origin',
                limitations='Inherits any error in the previous accepted registration, and models '
                            'only uniform scale and integer translation between drawings - a '
                            'viewpoint change is reported as low agreement and refused, not '
                            'corrected. Not a certified camera.')


def _empty(reason, fit=None):
    return dict(status='not_propagated', hypotheses=[], reason=reason,
                best_iou=fit and fit['iou'], best_scale=fit and fit['scale'],
                truth_used=False, runtime_vlm_calls=0, certified=False)


def registration_of_run(directory):
    """The accepted registration and target mask of a completed placement run.

    Lets the first page of a scope propagate from the checkpoint it starts on
    rather than having to register against the body once before the mechanism
    can take over. Returns None with a reason when the run is an attachment or
    otherwise records no registration.
    """
    import json
    from pathlib import Path
    from placement_run_scene import run_scene_from_directory
    directory = Path(directory)
    meta = json.loads((directory / 'results.json').read_text())
    source = meta.get('registration_source')
    if not source:
        return None, 'The starting checkpoint records no registration to propagate from'
    path = Path(source)
    if not path.is_file():
        return None, f'The starting checkpoint\'s registration file is missing: {path}'
    record = json.loads(path.read_text())
    if record.get('truth_used') is not False:
        raise ValueError('Registration provenance lacks truth-free attestation')
    if not record.get('hypotheses'):
        return None, 'The starting checkpoint retained no registration'
    (scene, _), _ = run_scene_from_directory(directory)
    best = record['hypotheses'][0]
    return dict(mask=np.asarray(scene['mask'], bool), projection=best['projection'],
                origin=best['origin'], rotation_index=best.get('rotation_index'),
                page=meta['page'], xref=meta['xref'], source=str(directory)), None
