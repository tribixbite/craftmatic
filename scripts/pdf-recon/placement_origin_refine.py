"""Refine and filter PDF camera registrations by exact silhouette containment.

The already-reconstructed body is opaque: at the true registration none of its
rendered pixels may fall outside the target artwork's dilated foreground. That
is a necessary physical condition, evaluated on PDF pixels and universal CAD
only. It is used here for two separate purposes, reported separately:

1. Integer-translation template registration is quantized. A small explicit
   offset window recovers the sub-template origin that satisfies containment.
2. Whole camera orientations that cannot satisfy containment at any offset in
   the window are rejected with their measured overflow.

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


def refine(base, hypotheses, scorer, window=3, tolerance=0, screen_fn=None):
    """Return containment-refined registrations sorted by template score.

    `window` is the half-width, in native raster pixels, of the exhaustive
    integer offset search around each supplied origin. `tolerance` is the
    number of overflowing body pixels accepted as raster/antialias noise.
    """
    if window < 0 or int(window) != window:
        raise ValueError('Offset window must be a nonnegative integer')
    if tolerance < 0 or int(tolerance) != tolerance:
        raise ValueError('Overflow tolerance must be a nonnegative integer')
    if screen_fn is None:
        from placement_occupancy_screen import screen as screen_fn
    offsets = [(dx, dy) for dy in range(-window, window + 1)
               for dx in range(-window, window + 1)]
    # Prefer the smallest correction that satisfies containment, so a valid
    # registration is never silently translated further than necessary.
    offsets.sort(key=lambda d: (abs(d[0]) + abs(d[1]), abs(d[0]), d))
    rows, seen = [], set()
    for index, hypothesis in enumerate(hypotheses):
        M = np.asarray(hypothesis['projection'], float)
        origin = np.asarray(hypothesis['origin'], float)
        best, accepted = None, None
        for dx, dy in offsets:
            evidence = screen_fn(base, [], M, origin + [dx, dy], scorer)['base']
            record = dict(offset=[dx, dy], outside_pixels=evidence['outside_pixels'],
                          occupied_pixels=evidence['occupied_pixels'])
            if best is None or record['outside_pixels'] < best['outside_pixels']:
                best = record
            if record['outside_pixels'] <= tolerance:
                accepted = record
                break
        row = dict(source_index=index, rotation_index=hypothesis.get('rotation_index'),
                   template_score=hypothesis.get('score'),
                   projection=M.tolist(), source_origin=origin.tolist(),
                   best_containment=best, contained=accepted is not None)
        if accepted is None:
            row['rejection'] = 'No offset in the window satisfies silhouette containment'
            rows.append(row)
            continue
        refined = (origin + accepted['offset']).tolist()
        row.update(origin=refined, applied_offset=accepted['offset'],
                   outside_pixels=accepted['outside_pixels'],
                   occupied_pixels=accepted['occupied_pixels'])
        key = (row['rotation_index'], tuple(np.round(M, 9).flat), tuple(refined))
        row['duplicate_of'] = next((r['source_index'] for r in rows if r.get('key') == key), None)
        row['key'] = key
        rows.append(row)
        seen.add(key)
    for row in rows:
        row.pop('key', None)
    retained = [r for r in rows if r['contained'] and r['duplicate_of'] is None]
    retained.sort(key=lambda r: -(r['template_score'] if r['template_score'] is not None else 0))
    return dict(hypotheses=retained, evaluated=rows, offset_window=window,
                overflow_tolerance=tolerance, retained=len(retained),
                rejected=sum(1 for r in rows if not r['contained']),
                duplicates=sum(1 for r in rows if r.get('duplicate_of') is not None),
                truth_used=False, runtime_vlm_calls=0, certified=False,
                protocol='Exhaustive integer offsets around each template origin; '
                         'smallest correction satisfying exact rendered-silhouette containment '
                         'in the dilated target foreground',
                limitations='Containment is a necessary condition only. Occlusion of the existing '
                            'body by later parts, cropped artwork and coincidental silhouettes are '
                            'not excluded. Offsets are integer native-raster pixels; no scale, '
                            'shear or rotation is refit. Not a certified camera.')


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).parent))
    parser = argparse.ArgumentParser()
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--window', type=int, default=3)
    parser.add_argument('--tolerance', type=int, default=0)
    parser.add_argument('--limit', type=int, default=12)
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
                    args.window, args.tolerance)
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
