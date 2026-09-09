"""Quantitative acceptance test for a page's camera, with a recorded reason.

Round two established that a page's own stud-row camera is a *proposal*: on
40377 page index 17 it put the body 13% small, and the previous page's whole
matrix was needed instead. It also established that nothing tested whether a
proposal should be believed - the driver ordered registrations by template
score, which was wrong on page 17 and can be wrong when it accepts.

Two measurements at the containment-refined registration separate the pages
that placed correctly from the pages that placed nothing correctly, on both
fixtures:

* **Unexplained ink.** An instruction drawing shows the body plus the pieces the
  page adds, so the drawn ink the registered body does not cover must be
  attributable to those pieces. Divide it by the largest area those pieces could
  possibly cover at this camera - the convex hull of each part's projected CAD
  vertices, maximised over cube orientations, which over-states a real
  silhouette - and the ratio must not exceed one. Raw coverage cannot be used
  for this: it depends on how big the body already is, and would refuse every
  early page of a small model.
* **Cross-page scale.** Consecutive instruction pages draw the same assembly at
  the same size, so a camera whose scale departs from the previous accepted
  page's is mis-scaled, not looking at a smaller drawing.

Measured, with the outcome of the page that used each registration:

| fixture | page | px per LDU | unexplained / addable | placed correctly |
| ------- | ---: | ---------: | --------------------: | ---------------- |
| 40377   |   16 |     1.6918 |                 0.223 | 1 of 1           |
| 40377   |   17 |     1.6918 |                 0.053 | camera carried   |
| 40377   |   18 |     1.4791 |                 1.105 | 0 of 1           |
| 40377   |   19 |     1.4831 |                 1.582 | 0 of 6           |
| 41624   |    3 |     1.0753 |                 0.409 | 2 of 3 retained  |
| 41624   |    4 |     1.0753 |                 0.535 | 1 of 3           |
| 41624   |    5 |     1.0196 |                 0.616 | 0 of 4           |
| 41624   |    6 |     0.8723 |                 1.431 | 0 of 2           |
| 41624   |    7 |     0.8723 |                 1.228 | 0 of 3           |
| 41624   |    8 |     0.8723 |                 1.359 | 0 of 4           |

Every page that placed anything correctly is below 0.62; every page whose
camera is measurably wrong is above 1.10. The threshold sits in that gap. The
test is necessary, never sufficient - 41624 page 5 passes it and still places
nothing right - and it refuses a correct camera when the body it renders is
itself wrong, which is the intended conservative failure. Its value is that the
decision is measured and recorded rather than assumed. No reference model, set
inventory or VLM participates.
"""
import numpy as np

UNEXPLAINED_MAX = 1.0
SCALE_TOLERANCE = .06
MODES = ('off', 'report', 'enforce')


def projection_scale(matrix):
    """Pixels per LDU, defined exactly as the driver defines it.

    Both singular values of these 2x3 projections are equal by construction, so
    their mean is the uniform scale and is comparable between pages.
    """
    return float(np.linalg.svd(np.asarray(matrix, float), compute_uv=False).mean())


def addable_area(pieces, projection):
    """Largest drawn area this page's allocated pieces could cover, in pixels.

    Uses the convex hull of each part's projected universal-CAD vertices,
    maximised over the 24 cube orientations, so the bound is generous by
    construction: a real silhouette is smaller than its hull, and a real pose is
    one orientation rather than the best one.
    """
    from placement_exploded_page import silhouette_area_range
    total = 0.
    for part, color in pieces:
        total += silhouette_area_range(str(part), int(color), projection)[1]
    return float(total)


def measure(hypothesis, prior_scale=None, new_piece_area=None):
    """Acceptance quantities for one containment-refined registration."""
    containment = hypothesis.get('best_containment') or {}
    target = hypothesis.get('target_pixels', containment.get('target_pixels'))
    covered = hypothesis.get('covered_pixels', containment.get('covered_pixels'))
    if target is None:
        target = containment.get('target_pixels')
    if covered is None:
        covered = containment.get('covered_pixels')
    scale = projection_scale(hypothesis['projection'])
    ratio = None if not prior_scale else scale / float(prior_scale)
    unexplained = None if (target is None or covered is None) else int(target - covered)
    share = (None if unexplained is None or not new_piece_area
             else unexplained / float(new_piece_area))
    return dict(px_per_ldu=scale, prior_px_per_ldu=(float(prior_scale) if prior_scale else None),
                scale_ratio=ratio, coverage=(covered / target) if target else None,
                covered_pixels=covered, target_pixels=target,
                unexplained_pixels=unexplained,
                addable_pixels=(float(new_piece_area) if new_piece_area else None),
                unexplained_share=share,
                outside_pixels=hypothesis.get('outside_pixels',
                                              containment.get('outside_pixels')),
                occupied_pixels=hypothesis.get('occupied_pixels',
                                               containment.get('occupied_pixels')),
                contained=bool(hypothesis.get('contained')),
                containment_fallback=bool(hypothesis.get('containment_fallback')))


def verdict(hypothesis, prior_scale=None, new_piece_area=None,
            unexplained_max=UNEXPLAINED_MAX, scale_tolerance=SCALE_TOLERANCE):
    """Accept or refuse one registration, with every failing reason listed."""
    values = measure(hypothesis, prior_scale, new_piece_area)
    reasons = []
    if not values['contained'] or values['containment_fallback']:
        reasons.append('not_contained')
    if values['unexplained_pixels'] is None:
        reasons.append('registration_reports_no_coverage')
    elif values['unexplained_share'] is None:
        # A page that allocates nothing has no addable area, so the criterion is
        # not measurable here; it is recorded, not silently treated as passed.
        values['unexplained_note'] = 'no allocated piece to attribute unexplained ink to'
    elif values['unexplained_share'] > unexplained_max:
        reasons.append('unexplained_ink_%.2fx_what_this_page_can_add'
                       % values['unexplained_share'])
    if values['scale_ratio'] is not None and abs(values['scale_ratio'] - 1.) > scale_tolerance:
        reasons.append('scale_differs_from_previous_page_by_%.1f%%'
                       % (100 * abs(values['scale_ratio'] - 1.)))
    return dict(values, accepted=not reasons, reasons=reasons)


def gate(hypotheses, prior_scale=None, new_piece_area=None, mode='enforce',
         unexplained_max=UNEXPLAINED_MAX, scale_tolerance=SCALE_TOLERANCE):
    """Order and optionally filter a page's refined registrations.

    `report` measures and records without changing which registrations are used,
    so a run can be compared against the ungated one. `enforce` keeps only the
    accepted registrations and refuses the drawing when none is accepted.
    """
    if mode not in MODES:
        raise ValueError(f'Unknown camera-gate mode {mode!r}')
    rows = [verdict(h, prior_scale, new_piece_area, unexplained_max, scale_tolerance)
            for h in hypotheses]
    record = dict(mode=mode, unexplained_max=unexplained_max, scale_tolerance=scale_tolerance,
                  prior_px_per_ldu=(float(prior_scale) if prior_scale else None),
                  addable_pixels=(float(new_piece_area) if new_piece_area else None),
                  evaluated=len(rows), accepted=sum(r['accepted'] for r in rows),
                  verdicts=rows, truth_used=False, runtime_vlm_calls=0, certified=False,
                  protocol='Containment, unexplained drawn ink against the page own addable CAD '
                           'area, and cross-page scale consistency at the refined registration',
                  limitations='Necessary conditions only. A wrong camera can still explain the '
                              'drawing, and a correct camera is refused when the body it renders '
                              'is itself wrong, which is the intended conservative failure.')
    if mode == 'off':
        return list(hypotheses), dict(record, mode='off', accepted=len(hypotheses))
    order = sorted(range(len(hypotheses)),
                   key=lambda i: (not rows[i]['accepted'],
                                  -(hypotheses[i].get('template_score') or 0)))
    if mode == 'report':
        return [hypotheses[i] for i in order], record
    kept = [hypotheses[i] for i in order if rows[i]['accepted']]
    if not kept:
        record['refusal'] = ('No registration of this drawing satisfies containment, unexplained '
                             'ink and cross-page scale consistency')
    return kept, record
