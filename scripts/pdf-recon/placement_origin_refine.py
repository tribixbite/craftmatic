"""Refine and filter PDF camera registrations by exact silhouette containment.

The already-reconstructed body is opaque: at the true registration none of its
rendered pixels may fall outside the target artwork's dilated foreground. That
is a necessary physical condition, evaluated on PDF pixels and universal CAD
only. It is used here for two separate purposes, reported separately:

1. Integer-translation template registration is quantized. A small explicit
   offset window recovers the sub-template origin that satisfies containment.
2. Whole camera orientations that cannot satisfy containment at any offset in
   the window are rejected with their measured overflow.
3. Optionally, the camera's overall scale is refit over an explicit ladder. A
   stud-row camera fixes the projection only up to that scale, and containment
   alone cannot choose one, so the accepted scale is the contained registration
   that covers the most target foreground.

## The absolute allowance was calibrated on a nearly-correct body

Round four removed the emitted body from *choosing* a page's camera - the
drawing-to-drawing propagation composes the previous page's accepted
registration with the similarity between the two drawings - but the containment
filter still passes through it, and page index 22 of 40377 measured what that
costs. Its propagated registrations cover 90.3% and 92.4% of the drawing where
every body-template alternative covers 76-80%; the body carries page 19's five
wrong parts, so those propagated renders protrude, and the unit-scale one was
rejected for overflowing by **669 pixels against a 553-pixel allowance - 116
pixels of 55,333**. Containment then kept only the small body-template
registrations and the camera gate correctly refused those for being below the
scale window, so the page was refused twice and pages 26 and 27 with it.

A fixed fraction of the body's own area cannot express that, because the number
it should scale with is how wrong the body already is, and that is not known in
advance. What *is* measurable, within one page and against one body, is the
overflow the page's own hypotheses achieve. `relative_multiple` therefore also
admits a registration whose overflow, **as a fraction of its own rendered
area**, is within a multiple of the smallest such fraction any hypothesis on
this page achieves. Normalising by the render's own area is load-bearing: a
camera that is simply too small overflows less in absolute pixels and would
otherwise set an unbeatable floor.

The rule is self-limiting by construction. On a page where some registration is
cleanly contained the floor is zero, the relative allowance collapses to the
absolute one, and nothing changes - measured on 40377 pages 16-19, 23, 25 and
28-30, whose admitted sets are identical with and without it. It only loosens
where *no* hypothesis is contained, which is exactly the evidence that the body,
not the camera, is what protrudes. `relative_cap` bounds it further: when even
the best hypothesis overflows by more than that fraction of its own area the
page has no registration worth comparing against, and the relative rule is not
applied at all (40377 page 26's second drawing, floor 7.3%, is refused as
before rather than admitting eleven hypotheses at 7-27%).

This is not a certified camera. Containment is necessary, never sufficient:
an occluded body, a cropped scene or a coincidental silhouette can satisfy it.
No reference model, set inventory or VLM participates.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import numpy as np


def _centered_origin(base, M, origin, scale, scorer, screen_fn):
    """Origin that keeps the rendered body's centre fixed while `M` is scaled.

    pixel = scale * (M @ world) + origin_s, so holding the projected centroid c
    fixed gives origin_s = origin + (1 - scale) * (c - origin). At scale 1 this
    is the supplied origin exactly, so a single-scale ladder reproduces the
    previous behaviour byte for byte.
    """
    if scale == 1.0:
        return origin
    centre = np.asarray(screen_fn(base, [], M, origin, scorer)['base']['centroid'], float)
    return origin + (1.0 - scale) * (centre - origin)


def overflow_ratio(record):
    """Overflow as a fraction of the render's own area, which is comparable.

    Absolute overflow is not comparable between hypotheses of one page: a camera
    that renders the body too small overflows less simply by being small, and
    would set a floor no correct registration could meet.
    """
    return record['outside_pixels'] / max(1, record['occupied_pixels'])


def relative_allowances(rows, multiple, cap):
    """Per-hypothesis overflow allowance measured within this page, in pixels.

    Returns `(allowances, floor, ratio)` where `floor` is the smallest overflow
    ratio any hypothesis on the page achieves and `ratio` is the admitted
    ceiling. When nothing on the page registers better than `cap`, the page has
    no usable reference and the relative rule is withheld entirely.
    """
    if not rows:
        return {}, None, None
    # The floor is worth recording whether or not the rule is applied: it is the
    # page's own measurement of how far from contained its best hypothesis is.
    floor = min(overflow_ratio(row['best_containment']) for row in rows)
    if multiple <= 0 or floor > cap:
        return {}, floor, None
    ratio = min(multiple * floor, cap)
    return ({row['source_index']: int(ratio * row['best_containment']['occupied_pixels'])
             for row in rows}, floor, ratio)


def refine(base, hypotheses, scorer, window=3, tolerance=0, fraction=0.0, fallback=0,
           screen_fn=None, scales=(1.0,), relative_multiple=0.0, relative_cap=0.03,
           coverage_order=False):
    """Return containment-refined registrations sorted by template score.

    `window` is the half-width, in native raster pixels, of the exhaustive
    integer offset search around each supplied origin. A hypothesis is accepted
    when its overflow is at most `tolerance` pixels or `fraction` of the body's
    own rendered area, whichever is larger; the proportional allowance exists
    because a body that already contains a misplaced part protrudes through the
    artwork through no fault of the camera.

    `scales` optionally refits the camera's overall scale. The stud-row camera
    fixes the projection up to that scale, and on 40377 page index 17 it is
    about 14% small: the body renders a 175x276 silhouette against a 199x318
    drawing, so no translation can register it, the containment test fails at
    every offset, and the search fills the leftover band with a misplaced part.
    Containment alone cannot choose a scale - a render that is too small is
    trivially contained - so the accepted scale is the one whose contained
    registration *covers* the most target foreground. Each scale keeps its own
    smallest containing offset, which makes `scales=(1.0,)` identical to the
    previous single-scale behaviour.

    `relative_multiple` adds the within-page rule described in the module
    docstring: a hypothesis whose overflow ratio is within that multiple of the
    smallest ratio the page achieves is admitted too, capped at `relative_cap`
    and withheld entirely when the page's own floor exceeds it. Such a
    hypothesis is admitted at its *least-overflowing* offset rather than at the
    smallest offset satisfying an allowance it never satisfies, and is recorded
    with `admission: 'relative'`. At `relative_multiple=0` the function is
    identical to its previous behaviour.

    `coverage_order` ranks what is retained by how much of the target the
    registered body covers instead of by template score. Coverage cannot be a
    threshold *across* pages - it depends on how large the assembly already is -
    but within one page and one body it is directly comparable, and a
    propagated registration carries no template score to be ranked by.

    If nothing is accepted, the `fallback` least-overflowing hypotheses are
    returned anyway, each flagged `contained: False` with its measured
    overflow, so the caller can proceed on explicitly weaker evidence instead
    of silently dropping the page. A caller that requires containment can pass
    `fallback=0` and get the strict behaviour.
    """
    if window < 0 or int(window) != window:
        raise ValueError('Offset window must be a nonnegative integer')
    if tolerance < 0 or int(tolerance) != tolerance:
        raise ValueError('Overflow tolerance must be a nonnegative integer')
    if not 0.0 <= fraction < 1.0:
        raise ValueError('Proportional allowance must be a fraction below one')
    if fallback < 0 or int(fallback) != fallback:
        raise ValueError('Fallback count must be a nonnegative integer')
    if relative_multiple < 0:
        raise ValueError('Relative overflow multiple must be nonnegative')
    if not 0.0 <= relative_cap < 1.0:
        raise ValueError('Relative overflow cap must be a fraction below one')
    scales = tuple(float(s) for s in scales)
    if not scales or any(s <= 0 for s in scales):
        raise ValueError('Scale ladder must be non-empty and positive')
    if screen_fn is None:
        from placement_occupancy_screen import screen as screen_fn
    offsets = [(dx, dy) for dy in range(-window, window + 1)
               for dx in range(-window, window + 1)]
    # Prefer the smallest correction that satisfies containment, so a valid
    # registration is never silently translated further than necessary.
    offsets.sort(key=lambda d: (abs(d[0]) + abs(d[1]), abs(d[0]), d))
    measured = []
    for index, hypothesis in enumerate(hypotheses):
        M0 = np.asarray(hypothesis['projection'], float)
        origin0 = np.asarray(hypothesis['origin'], float)
        best, accepted, ladder = None, None, []
        for scale in scales:
            M = M0 * scale
            anchor = _centered_origin(base, M0, origin0, scale, scorer, screen_fn)
            for dx, dy in offsets:
                evidence = screen_fn(base, [], M, anchor + [dx, dy], scorer)['base']
                record = dict(offset=[dx, dy], scale=scale,
                              outside_pixels=evidence['outside_pixels'],
                              occupied_pixels=evidence['occupied_pixels'],
                              covered_pixels=evidence.get('covered_pixels'),
                              target_pixels=evidence.get('target_pixels'))
                if best is None or record['outside_pixels'] < best['outside_pixels']:
                    best = dict(record, anchor=anchor.tolist())
                allowance = max(tolerance, int(fraction * record['occupied_pixels']))
                if record['outside_pixels'] <= allowance:
                    ladder.append(dict(record, anchor=anchor.tolist()))
                    break
        if ladder:
            # Among contained registrations the scale that explains the most of
            # the drawing wins; coverage is the only one of these measures that
            # a shrinking camera cannot game.
            accepted = max(ladder, key=lambda r: (r['covered_pixels'] or 0, -abs(r['scale'] - 1.0)))
        measured.append((dict(source_index=index, rotation_index=hypothesis.get('rotation_index'),
                              template_score=hypothesis.get('score'),
                              projection=M0.tolist(), source_origin=origin0.tolist(),
                              best_containment=best,
                              scale_ladder=ladder if len(scales) > 1 else None),
                         M0, accepted))
    # The absolute allowance is a fraction of the body's own area and so cannot
    # express how wrong the body already is. Compare the page's hypotheses
    # against each other as well, in the only unit that is comparable between
    # them - overflow as a fraction of each render's own area.
    allowances, floor, ceiling = relative_allowances(
        [row for row, _, _ in measured if row['best_containment'] is not None],
        relative_multiple, relative_cap)
    rows = []
    for row, M0, accepted in measured:
        admission = 'absolute' if accepted is not None else None
        if accepted is None and row['best_containment'] is not None:
            allowance = allowances.get(row['source_index'])
            if allowance is not None and row['best_containment']['outside_pixels'] <= allowance:
                # Admitted at its least-overflowing offset: it never satisfies
                # the absolute allowance, so there is no "smallest containing
                # offset" for it to be admitted at.
                accepted, admission = row['best_containment'], 'relative'
                row['relative_allowance'] = allowance
        row['contained'] = accepted is not None
        row['admission'] = admission
        best = row['best_containment']
        if accepted is None:
            row['rejection'] = 'No offset in the window satisfies silhouette containment'
            if len(scales) > 1:
                row['projection'] = (M0 * best['scale']).tolist()
                row['source_origin'] = best['anchor']
            rows.append(row)
            continue
        M = M0 * accepted['scale']
        refined = (np.asarray(accepted['anchor'], float) + accepted['offset']).tolist()
        row.update(projection=M.tolist(), source_origin=accepted['anchor'],
                   origin=refined, applied_offset=accepted['offset'],
                   applied_scale=accepted['scale'],
                   outside_pixels=accepted['outside_pixels'],
                   occupied_pixels=accepted['occupied_pixels'],
                   covered_pixels=accepted['covered_pixels'],
                   target_pixels=accepted['target_pixels'])
        key = (row['rotation_index'], tuple(np.round(M, 9).flat), tuple(refined))
        row['duplicate_of'] = next((r['source_index'] for r in rows if r.get('key') == key), None)
        row['key'] = key
        rows.append(row)
    for row in rows:
        row.pop('key', None)
    retained = [r for r in rows if r['contained'] and r.get('duplicate_of') is None]
    if coverage_order:
        retained.sort(key=lambda r: -(r['covered_pixels'] or 0))
    else:
        retained.sort(key=lambda r: -(r['template_score'] if r['template_score'] is not None else 0))
    used_fallback = False
    if not retained and fallback:
        used_fallback = True
        # Nothing is contained. Proceed on the least-overflowing hypotheses, each
        # carrying its measured overflow, rather than dropping the page silently.
        ordered = sorted(rows, key=lambda r: (r['best_containment']['outside_pixels'],
                                              -(r['template_score'] or 0)))
        for row in ordered[:fallback]:
            row = dict(row)
            anchor = np.asarray(row['best_containment'].get('anchor', row['source_origin']), float)
            row.update(origin=(anchor + row['best_containment']['offset']).tolist(),
                       applied_offset=row['best_containment']['offset'],
                       applied_scale=row['best_containment'].get('scale', 1.0),
                       outside_pixels=row['best_containment']['outside_pixels'],
                       occupied_pixels=row['best_containment']['occupied_pixels'],
                       covered_pixels=row['best_containment'].get('covered_pixels'),
                       containment_fallback=True)
            retained.append(row)
    return dict(hypotheses=retained, evaluated=rows, offset_window=window,
                overflow_tolerance=tolerance, proportional_allowance=fraction,
                relative_multiple=relative_multiple, relative_cap=relative_cap,
                overflow_ratio_floor=floor, relative_ratio_ceiling=ceiling,
                relative_admissions=sum(1 for r in rows if r.get('admission') == 'relative'),
                coverage_order=bool(coverage_order),
                containment_fallback_used=used_fallback, fallback_limit=fallback,
                scales=list(scales), retained=len(retained),
                applied_scales=sorted({r.get('applied_scale', 1.0) for r in retained}),
                rejected=sum(1 for r in rows if not r['contained']),
                duplicates=sum(1 for r in rows if r.get('duplicate_of') is not None),
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='Exhaustive integer offsets around each template origin, optionally over '
                         'a camera-scale ladder; each scale keeps its smallest containing offset '
                         'and the accepted scale is the contained registration covering the most '
                         'target foreground. With a relative multiple, a hypothesis whose overflow '
                         "ratio is within that multiple of the page's own smallest ratio is also "
                         'admitted, at its least-overflowing offset',
                limitations='Containment is a necessary condition only, and a fallback result is '
                            'explicitly not contained. Occlusion of the existing '
                            'body by later parts, cropped artwork and coincidental silhouettes are '
                            'not excluded. Offsets are integer native-raster pixels and the scale '
                            'ladder is a finite set of uniform scales; no shear or rotation is '
                            'refit, and coverage rewards a body that is merely large as well as '
                            "one that is correct. A relative admission is a comparison among one "
                            "page's own hypotheses against one body: it says a registration is no "
                            'worse than the best this page can do, never that it is right, and it '
                            'loosens exactly when nothing on the page is cleanly contained. '
                            'Not a certified camera.')


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).parent))
    parser = argparse.ArgumentParser()
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--window', type=int, default=3)
    parser.add_argument('--tolerance', type=int, default=0)
    parser.add_argument('--fraction', type=float, default=0.0)
    parser.add_argument('--fallback', type=int, default=0)
    parser.add_argument('--limit', type=int, default=12)
    parser.add_argument('--scales', type=float, nargs='+', default=[1.0],
                        help='Camera-scale ladder; the contained scale covering the most target '
                             'foreground is accepted')
    parser.add_argument('--relative-multiple', type=float, default=0.0,
                        help="Also admit a registration whose overflow, as a fraction of its own "
                             "rendered area, is within this multiple of the smallest such fraction "
                             'the page achieves; 0 disables the within-page rule')
    parser.add_argument('--relative-cap', type=float, default=0.03,
                        help='Ceiling on that relative allowance, and the floor above which the '
                             'page has no registration worth comparing against')
    parser.add_argument('--coverage-order', action='store_true',
                        help='Rank retained registrations by target coverage instead of template '
                             'score')
    args = parser.parse_args()
    import pymupdf
    from placement_arrow_contacts import read_items
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from vector_scene import scene_images
    source = json.loads(args.registration.read_text())
    if source.get('truth_used') is not False or source.get('runtime_vlm_calls') != 0:
        raise ValueError('Registration provenance lacks truth-free zero-VLM attestation')
    pdf = Path(source['pdf'])
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != source['pdf_sha256']:
        raise ValueError('Registration PDF hash mismatch')
    base_path = Path(source['base'])
    if hashlib.sha256(base_path.read_bytes()).hexdigest() != source['base_sha256']:
        raise ValueError('Registration body hash mismatch')
    with pymupdf.open(pdf) as doc:
        scene = next(s for s in scene_images(doc, doc[source['page']]) if s['xref'] == source['xref'])
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    result = refine(read_items(base_path), source['hypotheses'][:args.limit], scorer,
                    args.window, args.tolerance, args.fraction, args.fallback,
                    scales=tuple(args.scales), relative_multiple=args.relative_multiple,
                    relative_cap=args.relative_cap, coverage_order=args.coverage_order)
    result.update(pdf=str(pdf), pdf_sha256=source['pdf_sha256'], page=source['page'],
                  xref=source['xref'], base=source['base'], base_sha256=source['base_sha256'],
                  source_registration=str(args.registration),
                  source_registration_sha256=hashlib.sha256(args.registration.read_bytes()).hexdigest(),
                  considered=min(args.limit, len(source['hypotheses'])))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(json.dumps(dict(retained=result['retained'], rejected=result['rejected'],
                          duplicates=result['duplicates'],
                          best=result['hypotheses'][0] if result['hypotheses'] else None)))
