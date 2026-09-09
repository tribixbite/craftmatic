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


def refine(base, hypotheses, scorer, window=3, tolerance=0, fraction=0.0, fallback=0,
           screen_fn=None, scales=(1.0,)):
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
    rows, seen = [], set()
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
        row = dict(source_index=index, rotation_index=hypothesis.get('rotation_index'),
                   template_score=hypothesis.get('score'),
                   projection=M0.tolist(), source_origin=origin0.tolist(),
                   best_containment=best, contained=accepted is not None,
                   scale_ladder=ladder if len(scales) > 1 else None)
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
        seen.add(key)
    for row in rows:
        row.pop('key', None)
    retained = [r for r in rows if r['contained'] and r['duplicate_of'] is None]
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
                containment_fallback_used=used_fallback, fallback_limit=fallback,
                scales=list(scales), retained=len(retained),
                applied_scales=sorted({r.get('applied_scale', 1.0) for r in retained}),
                rejected=sum(1 for r in rows if not r['contained']),
                duplicates=sum(1 for r in rows if r.get('duplicate_of') is not None),
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='Exhaustive integer offsets around each template origin, optionally over '
                         'a camera-scale ladder; each scale keeps its smallest containing offset '
                         'and the accepted scale is the contained registration covering the most '
                         'target foreground',
                limitations='Containment is a necessary condition only, and a fallback result is '
                            'explicitly not contained. Occlusion of the existing '
                            'body by later parts, cropped artwork and coincidental silhouettes are '
                            'not excluded. Offsets are integer native-raster pixels and the scale '
                            'ladder is a finite set of uniform scales; no shear or rotation is '
                            'refit, and coverage rewards a body that is merely large as well as '
                            'one that is correct. Not a certified camera.')


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
                    scales=tuple(args.scales))
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
