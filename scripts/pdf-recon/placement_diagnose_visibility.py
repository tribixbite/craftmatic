"""Evaluation-only: how many drawn pixels can a pose change, page by page?

An instruction drawing can only be evidence about a piece it shows. As an
assembly grows, a step's new piece is increasingly mounted on a face the drawing
does not face, and then no objective computed on that drawing - whole-drawing,
local, or coarse - can prefer it over a rival on a visible face, because the
rival paints an order of magnitude more pixels.

Measured on 40377 page index 23, which adds one 4x4 plate to a 58-part body: the
reference pose paints **899** drawn pixels where the four top-ranked rivals paint
10,939 to 11,003. It duly loses under all three image objectives and under the
physical seating tie-break as well.

That reframes the look-ahead window. A one-page decision window is only worth
building if a later page's drawing *does* show the face, and this tool answers
that directly: it takes one pose in reconstruction coordinates and reports, for
every page of a completed run, how many pixels it would paint against that
page's own body at that page's own accepted registration. If the count stays
near zero across the remaining pages, the booklet never shows the piece and no
window over those pages can decide it.

The pose is supplied from the reference model, which is why this is evaluation
only. Nothing here enters candidate generation, scoring or selection.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def reference_body(model, alignment, transform, part=None, color=None, tolerance=1.0):
    """The independent model in reconstruction coordinates, minus one pose.

    The control for "is this piece hidden because our body is wrong?" - if it is
    still hidden inside the *complete, correct* assembly, the viewpoint hides it
    and no amount of repairing the body will reveal it. `alignment` is the
    reconstruction-to-reference rigid map a recall diagnostic measured; it is
    inverted here. Evaluation only.
    """
    from placement_diagnose_alias_poses import canonicalize
    from placement_part_library import PartLibrary
    from pose_score import read_parts
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    truth, _ = canonicalize(read_parts(model), PartLibrary())
    body, removed = [], []
    # Matched on part, colour and translation rather than on the whole frame:
    # the pose supplied here is whichever bank representative a recall
    # diagnostic reported, and for a part with a proper local symmetry that is
    # not literally the reference frame. Orientation does not change what a
    # square plate occludes, and the position identifies the instance.
    wanted = np.asarray(transform, float)[:3, 3]
    for name, code, position, frame in truth:
        placed = np.eye(4)
        placed[:3, :3] = inverse @ frame
        placed[:3, 3] = inverse @ position + offset
        matches = (not removed and np.max(np.abs(placed[:3, 3] - wanted)) <= tolerance
                   and (part is None or str(name) == str(part))
                   and (color is None or int(code) == int(color)))
        if matches:
            removed.append((str(name), int(code), placed))
            continue
        body.append((str(name), int(code), placed))
    return body, removed


def visibility(run, pages, part, color, transform, view=0, control_body=None):
    """Pixels the pose paints, per page, against that page's own body and camera."""
    from placement_arrow_contacts import read_items
    from placement_local_delta import added_region, render_layers
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_mixed_batch_search import fixed_native_score
    from placement_run_scene import run_scene
    rows = []
    for page in pages:
        step = Path(run) / f'page-{page:03d}'
        placement = step / 'placement'
        registration_path = step / f'registration-refined-{view:02d}.json'
        if not placement.is_dir() or not registration_path.is_file():
            rows.append(dict(page=page, status='no_placement_or_registration'))
            continue
        result = json.loads((placement / 'results.json').read_text())
        if result.get('truth_used') is not False:
            raise ValueError('Runtime artifacts lack truth-free provenance')
        registration = json.loads(registration_path.read_text())
        if not registration['hypotheses']:
            rows.append(dict(page=page, status='no_accepted_registration'))
            continue
        selected = int(result['results'][0].get('view') or 0)
        selected = min(selected, len(registration['hypotheses']) - 1)
        accepted = registration['hypotheses'][selected]
        M = np.asarray(accepted['projection'], float)
        origin = np.asarray(accepted['origin'], float)
        # The body this page registered against, i.e. what it had before its own
        # additions - the same body a candidate would have been scored against.
        body_source = Path(json.loads((step / 'registry-00.json').read_text())['base_source']) \
            if (step / 'registry-00.json').is_file() else placement / 'model.ldr'
        body = read_items(body_source)
        scene, mask_source = run_scene(result, read_items(placement / 'model.ldr'))
        scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
        # `render_layers` returns the buffers of the assembly the scorer most
        # recently rendered, so each render has to be preceded by its own score
        # call. Skipping that silently returns the previous assembly's buffers,
        # which reads as "the addition paints nothing" for every pose.
        body_score = fixed_native_score(scorer, body, M, origin)['score']
        base_layer = render_layers(scorer, body, M)
        items = body + [(part, int(color), np.asarray(transform, float))]
        pose_score = fixed_native_score(scorer, items, M, origin)['score']
        with_pose = render_layers(scorer, items, M)
        changed = added_region(base_layer, with_pose, scorer.mask)
        painted = int(np.asarray(changed['changed'], bool).sum())
        control = None
        if control_body:
            fixed_native_score(scorer, control_body, M, origin)
            control_base = render_layers(scorer, control_body, M)
            whole = control_body + [(part, int(color), np.asarray(transform, float))]
            fixed_native_score(scorer, whole, M, origin)
            control = int(np.asarray(added_region(control_base, render_layers(scorer, whole, M),
                                                  scorer.mask)['changed'], bool).sum())
        rows.append(dict(page=page, status='measured', painted_pixels=painted,
                         painted_against_complete_reference=control,
                         body_only_native_score=float(body_score),
                         body_plus_pose_native_score=float(pose_score),
                         body_parts=len(body), body_source=str(body_source),
                         target_pixels=int(np.asarray(scorer.mask, bool).sum()),
                         mask_source=mask_source,
                         registration_source=accepted.get('registration_source'),
                         px_per_ldu=float(np.linalg.svd(M, compute_uv=False).mean())))
    return rows


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--pages', type=int, nargs='+', required=True)
    parser.add_argument('--part', required=True)
    parser.add_argument('--color', type=int, required=True)
    parser.add_argument('--transform', type=float, nargs=12, required=True,
                        help='x y z then the nine rotation entries, LDraw order')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--reference-model',
                        help='Independent model for the complete-assembly control: is the pose '
                             'still hidden inside the finished model, or only behind our errors?')
    parser.add_argument('--alignment', type=Path,
                        help='A recall diagnostic whose alignment maps reconstruction into '
                             'reference coordinates; inverted to place the reference model here')
    args = parser.parse_args()
    transform = np.eye(4)
    transform[:3, 3] = args.transform[:3]
    transform[:3, :3] = np.asarray(args.transform[3:], float).reshape(3, 3)
    control, removed = (None, [])
    if args.reference_model and args.alignment:
        alignment = json.loads(args.alignment.read_text())['alignment']['alignment']
        control, removed = reference_body(args.reference_model, alignment, transform,
                                          args.part, args.color)
        if not removed:
            raise ValueError('The requested pose is not in the reference model at this alignment')
    rows = visibility(args.run, args.pages, args.part, args.color, transform,
                      control_body=control)
    record = dict(run=str(args.run), part=args.part, color=args.color,
                  reference_model=args.reference_model,
                  reference_body_parts=(len(control) if control else None),
                  transform=[float(v) for v in args.transform], rows=rows,
                  scope='Evaluation-only. The pose comes from the reference model and is used to '
                        'ask what the booklet shows, never to select anything.',
                  limitations='Painted pixels are measured against each page\'s own emitted body, '
                              'which carries whatever error that page inherited, and at that '
                              "page's own accepted registration. A page the run did not place has "
                              'no registration to measure at.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f'{"page":>5} {"painted":>8} {"whole":>7} {"target":>8} {"body":>5} {"body only":>10} '
          f'{"with pose":>10}  registration')
    for row in rows:
        if row['status'] != 'measured':
            print(f'{row["page"]:>5} {row["status"]:>8}')
            continue
        whole = ('%7d' % row['painted_against_complete_reference']
                 if row.get('painted_against_complete_reference') is not None else '      -')
        print(f'{row["page"]:>5} {row["painted_pixels"]:>8} {whole} {row["target_pixels"]:>8} '
              f'{row["body_parts"]:>5} {row["body_only_native_score"]:>10.5f} '
              f'{row["body_plus_pose_native_score"]:>10.5f}  {row["registration_source"]}')
    print(args.out)
