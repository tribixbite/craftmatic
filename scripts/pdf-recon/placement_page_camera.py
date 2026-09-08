"""Generic per-page main-scene camera proposals from PDF artwork alone.

Selects the page's unique main assembly image through the existing PDF scene
evidence (including the contained-fragment correction), removes conservatively
classified arrows using the protected CAD palette of every part known so far,
and emits row/robust/multirow camera hypotheses in the shape the body
registration step already consumes.

Camera proposals are hypotheses. Availability is not camera accuracy, and the
selection of a main scene is layout evidence, not certified chronology. No
reference model, set inventory or VLM participates.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np


def page_camera(pdf, page, allocation_run, out, prior_parts=()):
    import pymupdf
    from placement_arrow_mask import conservative_components, protected_cad_colors
    from placement_camera import infer_camera_robust, infer_camera_row
    from placement_multirow_camera import row_camera_hypotheses
    from placement_pdf_group_evidence import extract, load_allocations
    from placement_studs import detect_studs
    from vector_scene import scene_images
    out.mkdir(parents=True, exist_ok=True)
    pieces, provenance = load_allocations(pdf, page, allocation_run)
    prior = [(str(part), int(color)) for part, color in prior_parts]
    evidence = extract(pdf, page, allocation_run, out / 'evidence', prior_parts=prior)
    mains = [scene for scene in evidence['scenes'] if scene['kind'] == 'main_scene']
    if not mains:
        return dict(status='no_main_scene', page=page,
                    scene_kinds=[(s['xref'], s['kind']) for s in evidence['scenes']],
                    native_scenes=[], truth_used=False, runtime_vlm_calls=0, certified=False)
    # Several non-panel drawings can share a page: a subassembly beside the main
    # body, or two views of it. Layout alone cannot rank them, so every one is
    # returned as a candidate and the caller decides on geometric evidence.
    mains.sort(key=lambda s: -abs((s['bbox'][2] - s['bbox'][0]) * (s['bbox'][3] - s['bbox'][1])))
    targets = [s['xref'] for s in mains]
    # The main scene shows every already-placed part, so its protected palette
    # must include the existing body's colours, not only the new allocations.
    palette = protected_cad_colors(list(dict.fromkeys(list(pieces) + prior)))
    if not palette['complete']:
        raise ValueError('Cannot classify arrows without every known part CAD print colour')
    rows = []
    with pymupdf.open(pdf) as doc:
        for target in targets:
            scene = next(s for s in scene_images(doc, doc[page]) if s['xref'] == target)
            graph = conservative_components(scene, protected_colors=palette['rgb'])
            clean = dict(scene, mask=graph['clean_mask'])
            # An exploded piece drawn above the assembly is a separate image
            # component, and its studs are not the body's studs. A camera fitted
            # to the whole drawing is therefore fitted partly to geometry that is
            # not in the body yet. The body's own largest component is offered
            # first, with the whole drawing retained as an alternative.
            components = sorted((c for c in graph['components'] if c.get('mask') is not None),
                                key=lambda c: -int(c['area']))
            variants = [('whole_scene', clean['mask'])]
            if len(components) > 1:
                variants.insert(0, ('largest_component', components[0]['mask']))
            for source, mask in variants:
                view = dict(scene, mask=mask)
                detections = detect_studs(view['rgb'], view['mask'])
                rows.append(dict(page=page, xref=target, mask_source=source,
                                 component_count=len(components),
                                 native_size=list(scene['rgb'].shape[:2][::-1]),
                                 bbox=list(scene['bbox']),
                                 row_camera=infer_camera_row(detections),
                                 robust_camera=infer_camera_robust(detections),
                                 multirow=row_camera_hypotheses(view), detections=detections,
                                 arrow_count=len(graph['arrows']),
                                 warnings=['Ellipse proposals include side studs and holes; row matrices retain alternatives.',
                                           'Arrow removal is conservative; ambiguous blobs stay in the mask.',
                                           'Component choice is image evidence, not a certified separation of the assembly.']))
    return dict(status='ok' if any(r['multirow']['hypotheses'] for r in rows) else 'no_camera_hypothesis',
                page=page, native_scenes=rows, allocated_pieces=pieces,
                prior_parts=prior, scene_kinds=[(s['xref'], s['kind']) for s in evidence['scenes']],
                truth_used=False, runtime_vlm_calls=0, certified=False,
                limitations=['Main-scene candidates are layout evidence, not chronology, and are '
                             'ordered by drawn area only.',
                             'Camera hypotheses are proposals; availability is not accuracy.',
                             'Stud ellipse detection includes side studs and holes.'])


def parts_of(model_path):
    from placement_arrow_contacts import read_items
    return [(part, int(color)) for part, color, _ in read_items(Path(model_path))]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--page', type=int, required=True)
    parser.add_argument('--allocation-run', type=Path, required=True)
    parser.add_argument('--base', type=Path, help='Existing body whose colours must be protected')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    prior = parts_of(args.base) if args.base else ()
    result = page_camera(args.pdf, args.page, args.allocation_run, args.out, prior)
    result.update(pdf=str(args.pdf),
                  pdf_sha256=hashlib.sha256(args.pdf.read_bytes()).hexdigest(),
                  base=str(args.base) if args.base else None,
                  base_sha256=hashlib.sha256(args.base.read_bytes()).hexdigest() if args.base else None)
    (args.out / 'results.json').write_text(json.dumps(result, indent=2, default=lambda o: o.tolist() if isinstance(o, np.ndarray) else str(o)))
    print(json.dumps(dict(status=result['status'], page=args.page,
                          scenes=[dict(xref=r['xref'],
                                       hypotheses=len(r['multirow']['hypotheses']),
                                       detections=len(r['detections']))
                                  for r in result['native_scenes']])))
