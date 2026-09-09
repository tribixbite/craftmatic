"""Scale between two instruction drawings, measured from the drawings alone.

The driver's camera proposals all pass through the emitted body: a page's own
stud rows are checked by rendering the body and testing containment, and the
previous page's matrix is offered on the assumption that the assembly is drawn
at the same size. Both fail together when the body is wrong - 40377 page index
18 rejected the carried camera because the body it renders overflows the drawing
by 4,007 pixels, and the body overflows because it carries page 17's wrong
parts. The page then keeps its own stud-row camera, which is 12.6% small, and
every later page inherits that scale.

The drawings themselves settle it without the body. Consecutive instruction
pages draw the same assembly plus a few pieces, so the similarity that aligns
one drawing's foreground to the next is directly measurable. Measured on 40377
by maximising silhouette intersection-over-union over a scale ladder:

| drawings | best scale | IoU   |
| -------- | ---------: | ----: |
| 15 -> 16 |       1.03 | 0.972 |
| 16 -> 17 |       0.99 | 0.976 |
| 17 -> 18 |       1.03 | 0.959 |
| 18 -> 19 |       1.00 | 0.987 |
| 19 -> 22 |       1.02 | 0.894 |
| 22 -> 23 |       1.00 | 0.925 |

The booklet is drawn at one scale throughout, within a few per cent, and pages
that are not adjacent still align. Page 18's drawing is 1.03 times page 17's,
not the 0.87 its own stud rows imply, so the stud-row camera is refuted by PDF
pixels alone.

The measured ratio slightly over-states the camera ratio, because the assembly
also grows by the pieces the step adds and the fit absorbs part of that growth.
It is used as a proposal and as a bound, never as a calibration.

No reference model, set inventory or VLM participates.
"""
import cv2
import numpy as np

DEFAULT_LADDER = tuple(round(0.80 + 0.01 * step, 3) for step in range(46))


def align(previous, current, scales=DEFAULT_LADDER):
    """Best scale and offset aligning `previous` foreground onto `current`.

    Both are boolean masks of one drawing each. Returns the scale maximising
    intersection-over-union at its best integer translation, with the whole
    ladder retained so a caller can see how sharp the optimum is.
    """
    previous = np.asarray(previous, bool)
    current = np.asarray(current, bool)
    if not previous.any() or not current.any():
        raise ValueError('Both drawings need foreground pixels')
    target = current.astype(np.float32)
    total = float(current.sum())
    rows = []
    for scale in scales:
        if scale <= 0:
            raise ValueError('Scale ladder must be positive')
        resized = cv2.resize(previous.astype(np.uint8), None, fx=scale, fy=scale,
                             interpolation=cv2.INTER_NEAREST) > 0
        area = float(resized.sum())
        if not area:
            continue
        pad = max(resized.shape)
        padded = np.pad(target, pad)
        response = cv2.matchTemplate(padded, resized.astype(np.float32), cv2.TM_CCORR)
        index = int(np.argmax(response))
        y, x = divmod(index, response.shape[1])
        intersection = float(response[y, x])
        rows.append(dict(scale=float(scale), iou=intersection / max(1., area + total - intersection),
                         intersection=intersection, previous_area=area,
                         offset=[int(x - pad), int(y - pad)]))
    if not rows:
        raise ValueError('No usable scale in the ladder')
    best = max(rows, key=lambda row: row['iou'])
    return dict(scale=best['scale'], iou=best['iou'], offset=best['offset'], ladder=rows,
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='Silhouette intersection-over-union of one drawing against the next over '
                         'an explicit uniform-scale ladder at integer translations',
                limitations='The later drawing also contains the pieces the step adds, so the fit '
                            'absorbs part of that growth and the ratio slightly over-states the '
                            'camera ratio. Rotation and viewpoint changes are not modelled; a page '
                            'drawn from another viewpoint will simply fit badly, which the IoU '
                            'reports.')


def scaled_matrices(matrices, ratio, tolerance=0.01):
    """The given matrices rescaled by a measured drawing ratio.

    Returns nothing when the ratio is already within `tolerance` of one, so a
    booklet drawn at a constant scale adds no duplicate hypotheses.
    """
    if not matrices or abs(ratio - 1.0) <= tolerance:
        return []
    return [(np.asarray(matrix, float) * float(ratio)).tolist() for matrix in matrices]
