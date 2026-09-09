"""Autonomous multi-page PDF-only placement driver.

Chains, for each instruction page in an explicit scope:

    main-scene camera proposals  (placement_page_camera)
      -> body template registration over several camera matrices
      -> silhouette-containment refinement/rejection (placement_origin_refine)
      -> multi-shape pose registry and bounded closure
      -> joint exact-cardinality placement search, natively reranked
      -> the selected assembly becomes the next page's body

The driver holds a table of bodies, not one body. A page whose largest drawing
is far smaller than the current assembly's own silhouette is not adding to it -
it is building a separate subassembly - and a page that allocates no piece while
drawing the assembly is attaching one that is already pending. Both are recorded
as such (`placement_page_kind`), and a pending subassembly whose construction is
supplied is attached by `placement_attach_group` on the page the booklet points
at, without a hand-issued command.

Every stage is PDF pixels, PDF text allocations and universal CAD only. No
reference model, set inventory, manual pose or VLM participates at runtime, and
nothing here is certified or published. Pages whose structure is not supported
(no allocation, no unique main scene, no contained camera, empty search, or a
subassembly whose construction is not supplied) stop the run with saved evidence
instead of guessing.

A page's camera is not only its own. Its stud rows can be missing, and they can
also be wrong: 41624 page index 3 exposes none at all, and 40377 page index 17
exposes rows that put the body 13% small and at the wrong orientation. So the
previous page's whole matrix is offered alongside the page's own, its measured
scale is offered as a rescaled variant, and `--camera-prescan` lets a page with
no rows of its own borrow the nearest page that has some, in either direction.
`--retry-passes` retries a page that failed for want of a camera once a later
page has supplied one. Every page is in the same PDF, so none of this is new
information; each is a proposal that registration and containment still have to
accept, and where a matrix came from is recorded.

Every one of those proposals is still *chosen* by rendering the emitted body and
template-matching it, so a body carrying a wrong part registers worse and the
error compounds forwards - measured on page index 18, which rejected the carried
camera because the body overflowed the drawing by 4,007 pixels. With
`--drawing-registration` the camera and origin are instead propagated from the
previous page's accepted registration through the similarity that aligns the two
*drawings* (`placement_drawing_registration`), which the body takes no part in.
The body still supplies containment, collision and scoring.

The journal is written atomically and `--resume` re-verifies the PDF, the
allocation, the starting body and every completed checkpoint before skipping a
contiguous completed prefix.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_arrow_contacts import read_items
from placement_camera_gate import (UNEXPLAINED_MAX as CAMERA_UNEXPLAINED_MAX,
                                   SCALE_TOLERANCE as CAMERA_SCALE_TOLERANCE)


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_atomic(path, payload):
    temporary = Path(str(path) + '.tmp')
    temporary.write_text(payload)
    os.replace(temporary, path)


def base_colors(items):
    """Materials of the existing body, most frequent first, for templating."""
    counts = {}
    for _, color, _ in items:
        counts[int(color)] = counts.get(int(color), 0) + 1
    return [color for color, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def resume_checkpoints(record, config):
    # Compare the SERIALISED forms. The guard is meant to catch a changed input
    # or option, and comparing a live config against a parsed journal instead
    # compares Python types: `scales` is built as a tuple and JSON reads it back
    # as a list, so every run that ever wrote one was unresumable regardless of
    # whether anything had actually changed. Round-tripping both sides asks the
    # question the guard intends without weakening it.
    if record.get('resume_config') != json.loads(json.dumps(config)):
        raise ValueError('Resume inputs/configuration changed or legacy journal lacks input hashes')
    completed = {}
    for step in record['steps']:
        if step.get('status') != 'placed':
            continue
        placement = Path(step['placement'])
        hashes = step.get('checkpoint_hashes', {})
        if set(hashes) != {'model.ldr', 'results.json'}:
            raise ValueError('Completed checkpoint lacks required hashes')
        for name, digest in hashes.items():
            if not (placement / name).is_file() or file_hash(placement / name) != digest:
                raise ValueError(f'Completed checkpoint changed: {placement / name}')
        if step['page'] in completed:
            raise ValueError('Duplicate completed page in journal')
        completed[step['page']] = placement
    return completed


def projection_scale(matrix):
    """Pixels per LDU implied by a 2x3 native projection.

    Both singular values of these projections are equal by construction, so the
    mean is the uniform scale and is directly comparable between pages.
    """
    return float(np.linalg.svd(np.asarray(matrix, float), compute_uv=False).mean())


def scale_prior_matrices(matrices, prior_scale, tolerance=0.02):
    """The page's own orientations, rescaled to the previous page's px per stud.

    A page's stud-row camera fixes orientation well but scale only as well as
    the rows it happened to find. On 40377 page index 17 those rows give 29.1
    to 30.1 pixels per stud where pages 15 and 16 both measure 33.8 to 34.1, a
    13% error: the body then renders a 175x276 silhouette against the drawing's
    199x318, containment fails at every offset, and the search fills the
    leftover band with a misplaced plate. Consecutive instruction pages draw the
    same assembly at the same size, so the previous page's measured scale is a
    legitimate PDF-derived proposal - exactly as the previous page's whole
    matrix already is when a drawing exposes no stud row. It is offered as an
    extra hypothesis, never a substitute: registration and containment choose.
    """
    if not prior_scale:
        return []
    extra = []
    for matrix in matrices:
        scale = projection_scale(matrix)
        if scale <= 0 or abs(prior_scale / scale - 1.0) <= tolerance:
            continue
        extra.append((np.asarray(matrix, float) * (prior_scale / scale)).tolist())
    return extra


def attach_pending(pdf, page, base_model, step_dir, options, pending, kind_evidence):
    """Attach a pending subassembly to the main body on this page.

    The subassembly's own construction is a separate stage and is supplied as a
    directory of PDF-derived group hypotheses; this schedules the attachment the
    booklet asks for on the page that draws the incoming arrow, which previously
    required a hand-issued command. Page index 14 of 40377 is the case: it
    allocates nothing and attaches the four-piece stack page index 13 builds,
    and doing so repaired the body every later page registers against.
    """
    from placement_attach_group import run as attach_run
    groups = Path(pending['groups'])
    placement = step_dir / 'attachment'
    if placement.exists():
        raise ValueError('Attachment output already exists')
    base_run = Path(base_model).parent
    started = time.perf_counter()
    attach_run(pdf, base_run, groups, page, placement,
               limit=options.get('attach_limit', 4), gpu_render=True,
               camera_mode='multirow', any_anchor=True, plane_depth=True,
               coarse_pairs=options.get('attach_coarse_pairs', 256),
               coarse_method='layers', feature_edges=True, material_colors=True)
    report = json.loads((placement / 'results.json').read_text())
    detail = dict(kind='attachment', kind_evidence=kind_evidence,
                  groups=str(groups), source_page=pending.get('page'),
                  selected_parts=report.get('selected_parts'),
                  legal_groups=report.get('legal_groups'),
                  tested_views=report.get('tested_views'),
                  seconds=time.perf_counter() - started)
    if not (placement / 'model.ldr').is_file():
        return 'attachment_failed', detail, None, (), None, None
    return 'placed', detail, placement, (), None, None


def prescan_cameras(pdf, allocation_run, pages, base, out):
    """Every page's own stud-row camera proposals, measured before the drive.

    Returned as {page: [matrix, ...]} for pages that expose a camera at all, so
    a page with none can borrow the nearest neighbour's. This reads only PDF
    pixels and the existing allocation; it places nothing.
    """
    from placement_page_camera import page_camera
    out.mkdir(parents=True, exist_ok=True)
    prior_parts = [(part, color) for part, color, _ in base]
    found = {}
    for page in pages:
        try:
            camera = page_camera(pdf, page, allocation_run, out / f'page-{page:03d}',
                                 prior_parts=prior_parts)
        except Exception:  # a page the camera stage cannot read simply has none
            continue
        matrices = [h['matrix'] for record in camera.get('native_scenes', ())
                    for h in record['multirow']['hypotheses']]
        if matrices:
            found[page] = matrices
    write_atomic(out / 'prescan.json',
                 json.dumps(dict(pages={str(k): len(v) for k, v in found.items()},
                                 scope=list(pages), truth_used=False, runtime_vlm_calls=0,
                                 certified=False,
                                 protocol='Per-page stud-row camera proposals measured before the '
                                          'drive so a page with none can borrow the nearest '
                                          "neighbour's",
                                 limitations='A neighbouring page can legitimately draw the '
                                             'assembly at another scale or viewpoint; a borrowed '
                                             'matrix is a proposal that registration and '
                                             'containment still have to accept.'), indent=2))
    return found


def page_allocation(pdf, page, allocation_run):
    """A page's PDF allocation, or nothing when the page is out of its scope.

    Used to carry the pieces of a page the drive could not place, so a later
    page's unexplained ink can be attributed to them instead of to the two
    pieces that page happens to add.
    """
    from placement_pdf_group_evidence import load_allocations
    try:
        pieces, _ = load_allocations(pdf, page, allocation_run)
    except Exception:                                                       # noqa: BLE001
        return []
    return [(str(part), int(color)) for part, color in pieces]


def update_outstanding(outstanding, page, placed, allocation=(), attached_pages=()):
    """Record whether a page still owes its pieces, and return the flat list.

    A page that placed owes nothing; a page that did not is drawn on every later
    page regardless, so its allocation stays outstanding until something places
    it. An attachment discharges the pages whose subassembly it consumed. The
    returned order is by page so the record is stable and readable.
    """
    if placed:
        outstanding.pop(page, None)
        for source in attached_pages:
            outstanding.pop(source, None)
    elif allocation:
        outstanding[page] = [(str(part), int(color)) for part, color in allocation]
    return [piece for key in sorted(outstanding) for piece in outstanding[key]]


def nearest_prescan(prescan, page):
    """Matrices of the page nearest `page` that has any, ties preferring earlier."""
    if not prescan:
        return (), None
    source = min(prescan, key=lambda other: (abs(other - page), other))
    return list(prescan[source]), source


def largest_drawing(pdf, page, palette):
    """The page's main drawing foreground, arrows removed, body component only."""
    import pymupdf
    from placement_arrow_mask import conservative_components
    from vector_scene import scene_images
    with pymupdf.open(pdf) as doc:
        scenes = scene_images(doc, doc[page])
        if not scenes:
            return None
        scene = max(scenes, key=lambda s: int(np.asarray(s['mask'], bool).sum()))
        graph = conservative_components(scene, protected_colors=palette['rgb'])
    components = sorted((c for c in graph['components'] if c.get('mask') is not None),
                        key=lambda c: -int(c['area']))
    return components[0]['mask'] if components else np.asarray(scene['mask'], bool)


def place_page(pdf, page, allocation_run, base_model, step_dir, options, prior_matrices=(),
               prior_scale=None, pending=None, prior_body_area=0, prescan=None,
               pieces_override=None, prior_page=None, prior_registration=None,
               unplaced_pieces=()):
    """Return (status, detail, placement_dir, matrices, scale, registration) for one page.

    Several drawings on a page can be non-panel scenes: a subassembly beside
    the body, or a second view of it. Layout cannot rank them, so each is tried
    in drawn-area order and the first that yields a usable registration and a
    complete search result is taken; every attempt is saved.

    `pieces_override` replaces the page's allocation with a subset of it. Body
    construction uses this: one allocated piece becomes the body the page is
    registered against, and the rest are the pieces to place. The provenance the
    real allocation carries is preserved and the override is recorded.

    `prior_registration` is the previous page's accepted registration together
    with the target mask it was accepted against. With `--drawing-registration`
    the page's camera and origin are propagated through the measured similarity
    between the two drawings instead of being template-matched against the
    emitted body, so a body carrying a wrong part can no longer take the camera
    down with it. The returned sixth value is this page's own such record.

    `unplaced_pieces` are allocations of earlier pages in the scope that the
    drive did not place. Their ink is drawn on every page after them and has to
    be attributable to something, or the camera gate refuses each of those pages
    for a reason that has nothing to do with its camera.
    """
    from placement_arrow_contacts import read_items
    from placement_arrow_mask import conservative_components
    from placement_body_registration import register
    from placement_camera_gate import (UNEXPLAINED_MAX, SCALE_TOLERANCE, addable_area,
                                       gate as camera_gate)
    from placement_drawing_registration import propagate
    from placement_drawing_scale import align, scaled_matrices
    from placement_evidence_closure import rank_parents
    from placement_exploded_page import detached_pieces, withhold
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_multi_shape_batch import ShapeRegistry
    from placement_multi_shape_search import run as search_run
    from placement_occupancy_screen import screen
    from placement_origin_refine import refine
    from placement_page_camera import page_camera
    from placement_page_kind import body_area, classify
    from placement_page_mask import part_palette, restrict_to_body_component
    from placement_pdf_group_evidence import load_allocations
    import pymupdf
    from vector_scene import scene_images

    step_dir.mkdir(parents=True, exist_ok=True)
    base = read_items(base_model)
    pieces, provenance = load_allocations(pdf, page, allocation_run)
    if pieces_override is not None:
        allocated = list(pieces)
        pieces = [(str(part), int(color)) for part, color in pieces_override]
        for piece in pieces:
            if piece in allocated:
                allocated.remove(piece)
            else:
                raise ValueError(f'Override piece {piece} is not in the page allocation')
        provenance = dict(provenance, allocation_override=[list(p) for p in pieces],
                          allocation_override_remainder=[list(p) for p in allocated])
    camera = page_camera(pdf, page, allocation_run, step_dir / 'camera',
                         prior_parts=[(part, color) for part, color, _ in base])
    write_atomic(step_dir / 'camera.json', json.dumps(camera, indent=2, default=str))
    if not camera['native_scenes']:
        if not pieces:
            return ('no_allocation', dict(reason='Page adds no allocated piece and exposes no '
                                                 'drawing to attach a pending body against'),
                    None, (), None, None)
        return ('camera_unsupported', dict(reason=camera['status'],
                                           scene_kinds=camera.get('scene_kinds')), None, (), None, None)

    # What kind of step is this? A drawing that shows the current assembly
    # cannot be much smaller than that assembly's own silhouette, so the page
    # itself says whether it adds to the body, builds a separate one, or
    # attaches one that is already pending.
    with pymupdf.open(pdf) as doc:
        page_scenes = {s['xref']: s for s in scene_images(doc, doc[page])}
    areas = [int(np.asarray(page_scenes[record['xref']]['mask'], bool).sum())
             for record in camera['native_scenes'] if record['xref'] in page_scenes]
    # The body-area probe needs *some* matrix to render the body at. A page that
    # exposes no stud row of its own and has no predecessor in this scope has
    # neither, and then the kind test abstains to the ordinary addition path -
    # which is exactly wrong on a subassembly page, and a subassembly page is
    # the most likely first page of a scope to expose no rows. The prescan
    # already measured a neighbour's camera for precisely this case, so the
    # probe borrows it too rather than only the registration doing so.
    borrowed_matrices, borrowed_probe_page = (), None
    own_matrices = [h['matrix'] for record in camera['native_scenes']
                    for h in record['multirow']['hypotheses']]
    if not prior_matrices and not own_matrices and prescan:
        borrowed_matrices, borrowed_probe_page = nearest_prescan(prescan, page)
    reference_matrix = (list(prior_matrices) or own_matrices or list(borrowed_matrices))[:1]
    measured = 0
    if reference_matrix and base:
        probe = MaterialFeatureSceneScorer(page_scenes[camera['native_scenes'][0]['xref']],
                                           plane_depth=True)
        measured = body_area(base, reference_matrix[0], probe)
    # A page with no camera at all cannot render the body, and that is exactly
    # when the page is most likely to be drawing something other than it. The
    # last page that did draw the body is then the reference: an assembly only
    # grows, so its drawn area is a valid lower bound and is PDF-only.
    reference_area = measured or prior_body_area
    kind, kind_evidence = classify(areas, reference_area, len(pieces), pending is not None,
                                   options.get('body_area_ratio', 0.6))
    kind_evidence.update(page=page, xrefs=[r['xref'] for r in camera['native_scenes']],
                         kind=kind, pending_body=str(pending) if pending else None,
                         body_area_source='rendered_body' if measured else
                         ('previous_body_drawing' if prior_body_area else 'unavailable'),
                         body_probe_camera=('previous_page' if prior_matrices else
                                            ('own' if own_matrices else
                                             ('borrowed' if borrowed_matrices else 'none'))),
                         body_probe_borrowed_from=borrowed_probe_page,
                         previous_body_drawing_area=int(prior_body_area))
    write_atomic(step_dir / 'page-kind.json', json.dumps(kind_evidence, indent=2))
    if kind == 'attachment':
        return attach_pending(pdf, page, base_model, step_dir, options, pending, kind_evidence)
    if kind == 'no_allocation':
        return ('no_allocation', dict(reason='Page adds no allocated piece and no subassembly is '
                                             'pending', kind_evidence=kind_evidence),
                None, (), None, None)
    if kind == 'subassembly':
        # A construction can be deliberately left out rather than merely absent,
        # and the two are different events. Attaching a construction that is
        # wrong poisons the body every later page registers against - round one
        # measured the same mechanism forwards, when a *correct* four-piece
        # attachment was worth six extra downstream poses - so a construction
        # that cannot be made right is excluded on stated evidence, its pieces
        # stay outstanding, and the journal says which and why.
        excluded = (options.get('excluded_constructions') or {}).get(str(page))
        if excluded:
            return ('construction_excluded',
                    dict(reason='A construction for this page was deliberately excluded rather '
                                'than attached, so its error does not propagate into the pages '
                                'that register against the body',
                         exclusion_evidence=excluded, allocated_pieces=pieces,
                         kind_evidence=kind_evidence), None, (), None, None)
        return ('subassembly_page',
                dict(reason='The page draws no view of the current assembly, so it builds a '
                            'separate body; no construction is supplied for it',
                     kind_evidence=kind_evidence), None, (), None, None)

    # Base-attached enumeration depends only on the body and the allocation, so
    # it is done once; closure is per drawing because in evidence mode the
    # parent order comes from that drawing's own refined registration.
    # A female anti-stud whose reference point sits at the inner end of its own
    # tube rather than on the part's bottom face makes every mate of that part
    # collide, so the part can never be attached at all. Opt-in, recorded, and
    # scoped to the parts this page needs.
    if options.get('repair_anti_studs'):
        from placement_connector_repair import install as install_repairs
        repair = install_repairs([part for part, _ in pieces]
                                 + [part for part, _, _ in base])
        write_atomic(step_dir / 'connector-repair.json', json.dumps(repair, indent=2))
    seed = ShapeRegistry(base, pieces)
    provenance_fields = dict(provenance, pdf=str(pdf), page=page, base_source=str(base_model),
                             base_sha256=file_hash(base_model), allocated_pieces=pieces,
                             runtime_vlm_calls=0)
    if not seed.poses:
        return ('no_candidate_poses', dict(reason='No collision-free connector mate for any '
                                                  'allocated shape on the existing body'),
                None, (), None, None)
    evidence_mode = options.get('closure_mode', 'bank') == 'evidence'
    bank = None
    if not evidence_mode:
        bank = seed.branch().close(options['closure_rounds'], options['max_closure_parents'],
                                   options['max_poses'],
                                   per_round_parents=options.get('per_round_parents', False),
                                   max_seconds=options.get('closure_max_seconds')
                                   ).record()
        bank.update(provenance_fields)
        write_atomic(step_dir / 'registry.json', json.dumps(bank, indent=2))

    palette = part_palette(list(pieces) + [(part, int(color)) for part, color, _ in base])
    stable = options['stable_colors'] or base_colors(base)
    attempts = []
    for order, scene_record in enumerate(camera['native_scenes']):
        xref = scene_record['xref']
        proposed = [h['matrix'] for h in scene_record['multirow']['hypotheses']]
        reused = not proposed
        # A drawing with no detectable stud row still has to be registered. The
        # camera changes slowly between instruction pages, so an earlier page's
        # matrices are a legitimate PDF-derived proposal - recorded as reused.
        borrowed_from = None
        fallback_matrices = list(prior_matrices)
        if not proposed and not fallback_matrices and prescan:
            fallback_matrices, borrowed_from = nearest_prescan(prescan, page)
        own = (proposed or fallback_matrices)[:options['camera_matrices']]
        # The previous page's matrix is offered even when this page has stud rows
        # of its own, because those rows can be wrong in orientation as well as
        # scale. Measured on 40377 page index 17, whose drawing frames the body
        # at 198x317 against page 16's 200x320: the page's own camera scores
        # 0.337 body-only natively and page 16's whole matrix scores 0.595 on the
        # same drawing. Rescaling page 17's own orientation to page 16's scale
        # does not recover that - it reaches 0.281 - so the carried matrix, not
        # the carried scale, is what the page needs. Both are proposals that
        # registration and containment still have to choose between.
        carried = [matrix for matrix in list(prior_matrices)[:options['camera_prior_matrices']]
                   if proposed and not any(np.allclose(matrix, other, atol=1e-9)
                                           for other in own)]
        rescaled = (scale_prior_matrices(own, prior_scale) if options.get('scale_prior', True)
                    else [])
        # The drawing has to be read before it can be measured against the
        # previous page's, so the target mask is settled first: which pixels the
        # page asks to explain is the same decision every later stage uses.
        with pymupdf.open(pdf) as doc:
            scene = next(s for s in scene_images(doc, doc[page]) if s['xref'] == xref)
        drawing = scene
        arrows = conservative_components(scene, protected_colors=palette['rgb'])['arrows']
        if scene_record.get('mask_source') == 'largest_component':
            # A piece drawn detached above the assembly is not in the body yet.
            # Leaving it in the target makes its pixels permanently unexplained,
            # which both drags the registration off the body and collapses the
            # score. Restricting the target to the body's own image component
            # scores the assembly against the assembly.
            scene = restrict_to_body_component(scene, [], palette)
        # The drawings settle the scale without the body. Consecutive pages draw
        # the same assembly plus a few pieces, so the similarity aligning the
        # previous drawing onto this one is measurable from PDF pixels alone -
        # and on 40377 it says page 18's drawing is 1.03 times page 17's, where
        # its own stud rows imply 0.87.
        measured, drawing_fit = [], None
        if prior_page is not None and options.get('drawing_scale', True):
            previous = largest_drawing(pdf, prior_page, palette)
            if previous is not None:
                drawing_fit = align(previous, restrict_to_body_component(
                    drawing, [], palette)['mask'])
                measured = scaled_matrices(list(prior_matrices)[:options['camera_prior_matrices']],
                                           drawing_fit['scale'])
                write_atomic(step_dir / f'drawing-scale-{order:02d}.json',
                             json.dumps(dict({k: v for k, v in drawing_fit.items()
                                              if k != 'ladder'},
                                             previous_page=prior_page, page=page, xref=xref,
                                             ladder=drawing_fit['ladder']), indent=2))
        matrices = own + carried + rescaled + measured
        # Registration through the drawings rather than through the body. The
        # previous page's accepted registration, composed with the similarity
        # that aligns its drawing onto this one, is a camera *and* an origin that
        # the emitted assembly took no part in choosing - so a body carrying a
        # wrong part cannot destroy this page's camera the way it destroyed page
        # index 18's in round three.
        drawing_mode = options.get('drawing_registration', 'off')
        propagated, propagation = [], None
        if drawing_mode != 'off' and prior_registration is not None:
            propagation = propagate(prior_registration['mask'], scene['mask'],
                                    prior_registration['projection'], prior_registration['origin'],
                                    keep=options.get('drawing_registration_keep', 2),
                                    min_iou=options.get('drawing_registration_min_iou', 0.6),
                                    rotation_index=prior_registration.get('rotation_index'))
            propagated = propagation['hypotheses']
            write_atomic(step_dir / f'drawing-registration-{order:02d}.json',
                         json.dumps(dict({k: v for k, v in propagation.items() if k != 'ladder'},
                                         page=page, xref=xref,
                                         previous_page=prior_registration.get('page'),
                                         previous_source=prior_registration.get('source'),
                                         ladder=propagation.get('ladder')), indent=2))
        if drawing_mode == 'only' and not propagated:
            attempts.append(dict(xref=xref, status='no_drawing_registration',
                                 reason=(propagation or {}).get(
                                     'reason', 'No previous accepted registration to propagate')))
            continue
        if not matrices and not propagated:
            attempts.append(dict(xref=xref, status='no_camera_hypothesis'))
            continue
        hypotheses = []
        if drawing_mode != 'only':
            for index, matrix in enumerate(matrices):
                registered = register(scene, base, matrix, stable_colors=tuple(stable))
                for row in registered['hypotheses'][:options['per_matrix']]:
                    hypotheses.append(dict(row, matrix_index=index))
            hypotheses.sort(key=lambda r: -r['score'])
        # Propagated registrations come first so containment refines them first
        # and a body-template alternative is only reached when every propagated
        # one fails. Their scores are silhouette agreements, not the template
        # precisions the body hypotheses carry, so the two are never compared as
        # numbers - the ordering is the policy and it is recorded.
        hypotheses = propagated + hypotheses
        write_atomic(step_dir / f'registration-{order:02d}.json',
                     json.dumps(dict(hypotheses=hypotheses, stable_colors=stable, page=page,
                                     xref=xref, reused_prior_camera=reused, pdf=str(pdf),
                                     scale_prior_px_per_ldu=prior_scale,
                                     drawing_scale=drawing_fit and drawing_fit['scale'],
                                     drawing_scale_iou=drawing_fit and drawing_fit['iou'],
                                     measured_scale_matrices=len(measured),
                                     scale_prior_matrices=len(rescaled),
                                     carried_prior_matrices=len(carried),
                                     borrowed_camera_page=borrowed_from,
                                     matrix_scales=[projection_scale(m) for m in matrices],
                                     drawing_registration=drawing_mode,
                                     drawing_registration_hypotheses=len(propagated),
                                     pdf_sha256=provenance['pdf_sha256'], base=str(base_model),
                                     base_sha256=file_hash(base_model),
                                     camera_matrices=len(matrices), truth_used=False,
                                     runtime_vlm_calls=0, certified=False), indent=2))
        scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
        # Containment still passes through the emitted body even though camera
        # *choice* no longer does, and one absolute allowance calibrated on a
        # nearly-correct body cost page index 22 three pages: its propagated
        # registration covers 90.3% of the drawing and was rejected for 116
        # pixels of 55,333. The within-page relative rule compares this page's
        # hypotheses against each other instead.
        contained = refine(base, hypotheses[:options['refine_limit']], scorer,
                           window=options['window'], tolerance=options['tolerance'],
                           fraction=options['fraction'], fallback=options['fallback'],
                           screen_fn=screen, scales=tuple(options.get('scales') or (1.0,)),
                           relative_multiple=options.get('containment_multiple', 0.0),
                           relative_cap=options.get('containment_cap', 0.03),
                           coverage_order=options.get('containment_coverage_order', False))
        # Within one page and against one body, coverage is directly comparable
        # between registrations and a propagated one carries no template score.
        # Across pages it is not, which is why it orders and never gates.
        def registration_rank(row):
            if options.get('containment_coverage_order'):
                return -(row.get('covered_pixels') or 0)
            return -(row['template_score'] if row['template_score'] is not None else 0.0)

        if propagated:
            # `refine` orders what it retains by template score, which a
            # propagated registration does not have and must not be judged by.
            # Keep every propagated survivor ahead of every body-template one,
            # each group in its own order.
            contained['hypotheses'].sort(
                key=lambda row: (row['source_index'] >= len(propagated), registration_rank(row)))
            for row in contained['hypotheses']:
                row['registration_source'] = ('drawing_to_drawing'
                                              if row['source_index'] < len(propagated)
                                              else 'body_template')
        contained.update(page=page, xref=xref, pdf=str(pdf),
                         pdf_sha256=provenance['pdf_sha256'], base=str(base_model),
                         base_sha256=file_hash(base_model), reused_prior_camera=reused,
                         drawing_registration=drawing_mode,
                         drawing_registration_hypotheses=len(propagated))
        write_atomic(step_dir / f'registration-refined-{order:02d}.json',
                     json.dumps(contained, indent=2))
        if not contained['hypotheses']:
            attempts.append(dict(xref=xref, status='no_contained_registration',
                                 reused_prior_camera=reused, borrowed_camera_page=borrowed_from,
                                 best_overflow=min((r['best_containment']['outside_pixels']
                                                    for r in contained['evaluated']), default=None)))
            continue
        # A registration that satisfies containment is not thereby believable.
        # Measure it: consecutive pages draw the same assembly at the same size,
        # and a registration must explain most of the drawing it claims to be.
        # The expected camera scale for this page is the previous accepted one
        # times what the drawings themselves measure, not the previous one
        # unchanged.
        # The drawing ratio is a BOUND on the camera ratio, not a target: it
        # over-states, and the over-statement grows with the fraction of the
        # assembly the step adds. Expecting `prior x ratio` as a point refused
        # 41624 pages 5 to 8 for being 19% off an expectation 23% wrong.
        expected_scale = prior_scale
        expected_ratio = drawing_fit['scale'] if (prior_scale and drawing_fit) else None
        # Unexplained ink is attributed to what the drawing can legitimately show
        # that the body does not hold: this page's own allocation, plus anything
        # an earlier page of this scope allocated and the drive did not place. A
        # skipped subassembly page is drawn on every page after it, so charging
        # its ink to the current page's two pieces refuses every later page for a
        # reason that is nothing to do with the camera. The list is PDF-derived
        # (it is the allocation) and is recorded with the verdict.
        attributable = list(pieces) + list(unplaced_pieces or ())
        accepted, gate_record = camera_gate(
            contained['hypotheses'], expected_scale,
            addable_area(attributable, contained['hypotheses'][0]['projection'])
            if attributable else None,
            mode=options.get('camera_gate', 'enforce'),
            unexplained_max=options.get('camera_unexplained_max', UNEXPLAINED_MAX),
            scale_tolerance=options.get('camera_scale_tolerance', SCALE_TOLERANCE),
            drawing_ratio=expected_ratio)
        write_atomic(step_dir / f'camera-gate-{order:02d}.json',
                     json.dumps(dict(gate_record, page=page, xref=xref,
                                     attributable_pieces=[list(p) for p in attributable],
                                     unplaced_pieces=[list(p) for p in (unplaced_pieces or ())]),
                                indent=2))
        if not accepted:
            attempts.append(dict(xref=xref, status='camera_refused',
                                 reused_prior_camera=reused, borrowed_camera_page=borrowed_from,
                                 reason=gate_record.get('refusal'),
                                 best=gate_record['verdicts'][0] if gate_record['verdicts'] else None))
            continue
        if propagated:
            # The gate re-orders by template score, which would undo the
            # registration-source preference above. Restore it among the
            # registrations the gate accepted.
            accepted = sorted(accepted,
                              key=lambda row: (row['source_index'] >= len(propagated),
                                               registration_rank(row)))
        contained['hypotheses'] = accepted
        contained['camera_gate'] = {key: value for key, value in gate_record.items()
                                    if key != 'verdicts'}
        accepted_registration = dict(
            accepted[0], registration_source=accepted[0].get('registration_source',
                                                             'body_template'),
            drawing_iou=(propagated[accepted[0]['source_index']]['drawing_iou']
                         if propagated and accepted[0]['source_index'] < len(propagated) else None))
        write_atomic(step_dir / f'registration-refined-{order:02d}.json',
                     json.dumps(contained, indent=2))
        # Does this drawing show one of the page's own new pieces detached?
        # If it does, the image cannot place that piece and must not be asked
        # to: scoring a complete assembly against a drawing that omits a piece
        # rewards hiding it. The arrows place it instead, after the search.
        exploded = dict(count=0, withheld_keys=[], reason='disabled')
        if options.get('exploded_target', True):
            exploded = detached_pieces(drawing, pieces,
                                       contained['hypotheses'][0]['projection'], palette)
        write_atomic(step_dir / f'exploded-{order:02d}.json', json.dumps(exploded, indent=2))
        image_pieces, withheld = withhold(pieces, exploded.get('withheld_keys') or [])
        attempt_bank = bank
        if evidence_mode:
            # Bank order carries no information about the page, and the closure
            # expands only a bounded prefix of it, so a parent outside that
            # prefix makes its children unreachable at any pose cap. Rank the
            # parents by this drawing's own arrow and silhouette evidence first.
            parent_order, ranking = rank_parents(
                base, seed, pieces, contained['hypotheses'], scorer,
                allowance=int(contained['hypotheses'][0].get('outside_pixels') or 0),
                views=options['views'], arrows=arrows)
            attempt_bank = seed.branch().close(
                options['closure_rounds'], options['max_closure_parents'],
                options['max_poses'], parent_order, 'pdf_evidence',
                per_round_parents=options.get('per_round_parents', False),
                max_seconds=options.get('closure_max_seconds')).record()
            attempt_bank.update(provenance_fields)
            attempt_bank['closure_parent_ranking'] = {
                key: value for key, value in ranking.items() if key != 'merged'}
            write_atomic(step_dir / f'registry-{order:02d}.json',
                         json.dumps(attempt_bank, indent=2))
            write_atomic(step_dir / f'closure-ranking-{order:02d}.json',
                         json.dumps(dict(ranking, order=parent_order, page=page, xref=xref),
                                    indent=2))
            if not attempt_bank['poses']:
                attempts.append(dict(xref=xref, status='no_candidate_poses'))
                continue
        placement = step_dir / (f'placement-{order:02d}' if order else 'placement')
        placement.mkdir(exist_ok=True)
        snapshot = placement / 'source'
        snapshot.mkdir(exist_ok=True)
        code_hashes = {}
        for path in Path(__file__).parent.glob('*.py'):
            payload = path.read_bytes()
            (snapshot / path.name).write_bytes(payload)
            code_hashes[path.name] = hashlib.sha256(payload).hexdigest()
        started = time.perf_counter()
        result = search_run(attempt_bank, contained, scene, base, placement, views=options['views'],
                            scale=options['scale'], max_nodes=options['max_nodes'],
                            top_k=options['top_k'], host_bytes=options['host_bytes'],
                            method=options['method'], beam=options['beam'],
                            max_expansions=options['max_expansions'],
                            improve_rounds=options['improve_rounds'],
                            improve_from=options['improve_from'],
                            restarts=options['restarts'], perturb=options['perturb'],
                            seed=options['seed'], native_rounds=options['native_rounds'],
                            native_width=options['native_width'],
                            native_starts=options['native_starts'],
                            image_pieces=image_pieces, withheld=withheld, arrows=arrows,
                            outside_fraction=options.get('fraction', 0.),
                            local_rerank=options.get('local_rerank', 0.),
                            seated_tolerance=options.get('seated_tolerance', 0.),
                            max_bank_candidates=options.get('max_bank_candidates'),
                            exchange_window_order=options.get('exchange_window_order',
                                                              'incremental'),
                            tie_break=options.get('tie_break', 'index'))
        result.update(pdf=str(pdf), pdf_sha256=provenance['pdf_sha256'],
                      seconds=time.perf_counter() - started, code_sha256_start=code_hashes,
                      camera_source=str(step_dir / 'camera.json'), scene_order=order,
                      reused_prior_camera=reused, stable_colors=stable,
                      # The target mask belongs in the run's own record. Without
                      # it a post-hoc diagnostic rebuilds the drawing from the
                      # PDF and silently scores a different question: on page
                      # index 17 the whole drawing is 65,869 pixels against the
                      # 52,177 the run actually used, and the same selected
                      # assembly scores 0.2865 instead of 0.5442.
                      mask_source=scene_record.get('mask_source', 'whole_scene'),
                      exploded_withheld=exploded.get('withheld', []),
                      exploded_reason=exploded.get('reason'),
                      closure_mode=options.get('closure_mode', 'bank'),
                      applied_scales=contained.get('applied_scales'),
                      closure_parent_order=attempt_bank['closure_parent_order'],
                      registry_source=str(step_dir / (f'registry-{order:02d}.json' if evidence_mode
                                                      else 'registry.json')),
                      registration_source=str(step_dir / f'registration-refined-{order:02d}.json'))
        write_atomic(placement / 'results.json', json.dumps(result, indent=2))
        if result['status'] != 'candidates':
            attempts.append(dict(xref=xref, status='search_produced_no_model',
                                 reason=result['status']))
            continue
        # The search scores each of the top `views` registrations independently
        # and selects the best, so the registration the run actually used is the
        # selected view's - not necessarily the first accepted one. That is the
        # one to report and the one the next page must propagate from.
        selected_view = int(result['results'][0].get('view') or 0)
        if 0 <= selected_view < len(contained['hypotheses']):
            accepted_registration = dict(
                contained['hypotheses'][selected_view],
                registration_source=contained['hypotheses'][selected_view].get(
                    'registration_source', 'body_template'),
                drawing_iou=(propagated[contained['hypotheses'][selected_view]['source_index']]
                             ['drawing_iou']
                             if propagated and contained['hypotheses'][selected_view]['source_index']
                             < len(propagated) else None))
        detail = dict(selected_parts=result['selected_parts'], shapes=result['shapes'],
                      seconds=result['seconds'], xref=xref, scene_order=order,
                      reused_prior_camera=reused, borrowed_camera_page=borrowed_from,
                      mask_source=scene_record.get('mask_source'),
                      exploded_withheld=exploded.get('withheld', []),
                      exploded_reason=exploded.get('reason'),
                      drawing_scale=drawing_fit and drawing_fit['scale'],
                      drawing_scale_iou=drawing_fit and drawing_fit['iou'],
                      registration_source=accepted_registration['registration_source'],
                      drawing_registration_iou=accepted_registration.get('drawing_iou'),
                      selected_view=selected_view,
                      selected_view_px_per_ldu=projection_scale(
                          accepted_registration['projection']),
                      arrow_attachment=result['results'][0].get('arrow_attachment'),
                      containment_fallback=contained['containment_fallback_used'],
                      attempts=attempts, scale_prior_px_per_ldu=prior_scale,
                      camera_scale_px_per_ldu=projection_scale(
                          contained['hypotheses'][0]['projection']),
                      score=result['results'][0]['evidence']['score'])
        # What the next page propagates from: the registration this page's
        # search actually used, and the exact target mask it was accepted
        # against.
        carry = dict(mask=np.asarray(scene['mask'], bool),
                     projection=accepted_registration['projection'],
                     origin=accepted_registration['origin'],
                     rotation_index=accepted_registration.get('rotation_index'),
                     page=page, xref=xref, source=str(placement))
        return ('placed', detail, placement, matrices,
                projection_scale(contained['hypotheses'][0]['projection']), carry)
    # Say which of the three the page actually failed. A camera the acceptance
    # test refused is not the same event as a camera that could not be
    # registered at all, and a journal that calls both 'no_contained
    # registration' hides the measurement that produced the refusal.
    statuses = {a['status'] for a in attempts}
    if attempts and statuses == {'no_camera_hypothesis'}:
        status = 'camera_unsupported'
    elif attempts and statuses <= {'camera_refused', 'no_camera_hypothesis'}:
        status = 'camera_refused'
    else:
        status = 'no_contained_registration'
    return (status,
            dict(reason='No page drawing produced a usable registration', attempts=attempts),
            None, (), None, None)


def run(pdf, allocation_run, base_run, pages, out, options, resume=False, stop_on_unsupported=True):
    base_model = base_run / 'model.ldr'
    base_manifest = base_run / 'manifest.json'
    if not base_manifest.exists():
        base_manifest = base_run / 'results.json'
    metadata = json.loads(base_manifest.read_text())
    if metadata.get('truth_used') is not False or metadata.get('runtime_vlm_calls') != 0:
        raise ValueError('Starting body lacks truth-free zero-VLM provenance')
    config = dict(pdf_sha256=file_hash(pdf),
                  allocation_sha256=file_hash(allocation_run / 'global-assignment.json'),
                  base_model_sha256=file_hash(base_model),
                  base_manifest_sha256=file_hash(base_manifest),
                  pages=list(pages), options=options, version=2)
    journal = out / 'autodrive.json'
    record = dict(pdf=str(pdf.resolve()), pdf_sha256=config['pdf_sha256'],
                  allocation_run=str(allocation_run), base_source=str(base_run),
                  runtime_vlm_calls=0, truth_used=False, certified=False,
                  status='running', resume_config=config, steps=[],
                  limitations=['Starts from an existing PDF-derived checkpoint',
                               'Subassembly construction from nothing is not implemented: such a '
                               'page is classified and recorded, and its attachment is scheduled '
                               'only when a PDF-derived construction is supplied for it',
                               'Selected checkpoints freeze earlier poses; no global backtracking',
                               'Bounded connector closure and finite node budget lose optimality',
                               'No complete-model or population certification; no publication'])
    completed = {}
    if resume:
        if not journal.exists():
            raise ValueError('Resume requires an existing journal')
        previous = json.loads(journal.read_text())
        completed = resume_checkpoints(previous, config)
        record['steps'] = [s for s in previous['steps'] if s.get('status') == 'placed']
        record['resumed_from'] = len(completed)
    elif out.exists() and any(out.iterdir()):
        raise ValueError('Choose a new output directory or explicitly resume')
    out.mkdir(parents=True, exist_ok=True)
    write_atomic(journal, json.dumps(record, indent=2))
    # Failures a later page's camera could repair, retried after the main pass.
    RETRYABLE = ('camera_unsupported', 'no_contained_registration', 'camera_refused')
    deferred = []
    # Allocations of pages this drive did not place. A later page draws them
    # whether or not we placed them, so the camera gate must be allowed to
    # attribute their ink to them.
    unplaced, outstanding, attached_from = [], {}, []
    current = base_model
    prior_matrices, prior_scale, prior_page = (), None, None
    # Subassembly constructions supplied for specific pages; the driver decides
    # when to attach them, which page the booklet points at, and records both.
    supplied = dict(options.get('group_runs') or {})
    # A subassembly may have been built before this run's page scope begins -
    # 40377 builds one on page index 13, which the allocation scopes out because
    # of a mould ambiguity resolved in separate branches. Declaring it pending
    # lets the driver schedule its attachment on the page that asks for it
    # instead of the attachment being issued by hand.
    pending, prior_body_area = options.get('pending_body'), 0
    # The scope's first page has no page before it in this run, but the
    # checkpoint it starts from recorded its own accepted registration and the
    # drawing it was accepted against, so drawing-to-drawing propagation works
    # from the very first driven page rather than needing one body-registered
    # page to prime it.
    prior_registration = None
    if options.get('drawing_registration', 'off') != 'off':
        from placement_drawing_registration import registration_of_run
        prior_registration, why = registration_of_run(base_run)
        record['drawing_registration_seed'] = (
            dict(page=prior_registration['page'], source=prior_registration['source'])
            if prior_registration else dict(unavailable=why))
    prescan = (prescan_cameras(pdf, allocation_run, pages, read_items(base_model),
                               out / 'camera-prescan')
               if options.get('camera_prescan') else None)
    if prescan is not None:
        record['camera_prescan_pages'] = sorted(prescan)
        write_atomic(journal, json.dumps(record, indent=2))
    for page in pages:
        if page in completed:
            current = completed[page] / 'model.ldr'
            continue
        attempt = 0
        step_dir = out / f'page-{page:03d}'
        while step_dir.exists():
            attempt += 1
            step_dir = out / f'page-{page:03d}-attempt-{attempt}'
        try:
            status, detail, placement, matrices, scale, registration = place_page(
                pdf, page, allocation_run, current, step_dir, options, prior_matrices, prior_scale,
                pending, prior_body_area, prescan, prior_page=prior_page,
                prior_registration=prior_registration, unplaced_pieces=unplaced)
            if status == 'placed':
                # The page whose drawing this one is measured against next.
                prior_page = page
            if registration is not None:
                prior_registration = registration
            if status == 'placed' and (detail or {}).get('kind') != 'attachment':
                kind_file = step_dir / 'page-kind.json'
                if kind_file.is_file():
                    prior_body_area = max(prior_body_area,
                                          json.loads(kind_file.read_text())['largest_scene_area'])
            if matrices:
                prior_matrices = matrices
            if scale:
                prior_scale = scale
            if status == 'subassembly_page' and str(page) in supplied:
                # Construction was supplied for this page: register it as
                # pending so a later page's attachment step can schedule it.
                pending = dict(page=page, groups=supplied[str(page)])
                detail = dict(detail, pending_registered=pending)
                status = 'subassembly_pending'
            elif status == 'placed' and (detail or {}).get('kind') == 'attachment':
                # The attached subassembly's pieces are in the body now, so the
                # page that built them stops being unexplained ink.
                attached_from.append((detail or {}).get('source_page'))
                pending = None
        except Exception as exc:  # keep the failed page's evidence, never a silent skip
            status, detail, placement = 'error', dict(error=str(exc),
                                                      traceback=traceback.format_exc()), None
        unplaced = update_outstanding(
            outstanding, page, status == 'placed',
            () if status == 'placed' else page_allocation(pdf, page, allocation_run),
            [source for source in attached_from if source is not None])
        attached_from.clear()
        step = dict(page=page, status=status, detail=detail, directory=str(step_dir))
        step['unplaced_pieces_carried'] = [list(p) for p in unplaced]
        step['pending_body'] = dict(pending) if pending else None
        if placement is not None:
            step['placement'] = str(placement)
            step['checkpoint_hashes'] = {name: file_hash(placement / name)
                                         for name in ('model.ldr', 'results.json')}
            current = placement / 'model.ldr'
        record['steps'].append(step)
        record['last_checkpoint'] = str(current)
        write_atomic(journal, json.dumps(record, indent=2))
        print(json.dumps(dict(page=page, status=status, detail=detail)), flush=True)
        if status in RETRYABLE:
            # Only a camera was missing; a later page may supply one.
            deferred.append(page)
        if status == 'subassembly_pending':
            continue
        if placement is None and stop_on_unsupported:
            record['status'] = 'stopped_unsupported_page'
            write_atomic(journal, json.dumps(record, indent=2))
            return record
    for attempt_pass in range(1, int(options.get('retry_passes') or 0) + 1):
        if not deferred:
            break
        placed_any, still = False, []
        for page in deferred:
            step_dir = out / f'page-{page:03d}-retry-{attempt_pass}'
            try:
                status, detail, placement, matrices, scale, registration = place_page(
                    pdf, page, allocation_run, current, step_dir, options, prior_matrices,
                    prior_scale, pending, prior_body_area, prescan, prior_page=prior_page,
                    prior_registration=prior_registration, unplaced_pieces=unplaced)
                if status == 'placed':
                    prior_page = page
                if registration is not None:
                    prior_registration = registration
                if matrices:
                    prior_matrices = matrices
                if scale:
                    prior_scale = scale
            except Exception as exc:
                status, detail, placement = 'error', dict(error=str(exc),
                                                          traceback=traceback.format_exc()), None
            if status == 'placed':
                unplaced = update_outstanding(outstanding, page, True)
            step = dict(page=page, status=status, detail=detail, directory=str(step_dir),
                        retry_pass=attempt_pass, pending_body=dict(pending) if pending else None,
                        unplaced_pieces_carried=[list(p) for p in unplaced])
            if placement is not None:
                step['placement'] = str(placement)
                step['checkpoint_hashes'] = {name: file_hash(placement / name)
                                             for name in ('model.ldr', 'results.json')}
                current = placement / 'model.ldr'
                placed_any = True
            elif status in RETRYABLE:
                still.append(page)
            record['steps'].append(step)
            record['last_checkpoint'] = str(current)
            write_atomic(journal, json.dumps(record, indent=2))
            print(json.dumps(dict(page=page, status=status, retry_pass=attempt_pass,
                                  detail=detail)), flush=True)
        deferred = still
        if not placed_any:
            break
    record['deferred_pages_unplaced'] = deferred
    record['status'] = 'completed_requested_pages_uncertified'
    write_atomic(journal, json.dumps(record, indent=2))
    return record


def add_page_options(parser):
    """Per-page pipeline options, shared by the driver and the constructor."""
    parser.add_argument('--camera-matrices', type=int, default=2)
    parser.add_argument('--camera-prior-matrices', type=int, default=2,
                        help="How many of the previous page's matrices to offer alongside this "
                             "page's own; a page's stud rows can be wrong in orientation, not "
                             'only in scale')
    parser.add_argument('--per-matrix', type=int, default=6)
    parser.add_argument('--refine-limit', type=int, default=16)
    parser.add_argument('--window', type=int, default=3)
    parser.add_argument('--tolerance', type=int, default=0)
    parser.add_argument('--fraction', type=float, default=0.0,
                        help='Overflow allowed as a fraction of the rendered body area')
    parser.add_argument('--fallback', type=int, default=0,
                        help='Proceed on this many least-overflowing views when none is contained')
    parser.add_argument('--containment-multiple', type=float, default=0.0,
                        help='Also admit a registration whose overflow, as a fraction of its own '
                             "rendered area, is within this multiple of the page's own smallest "
                             'such fraction. An absolute allowance cannot express how wrong the '
                             'body already is; this compares the page against itself. 0 disables it')
    parser.add_argument('--containment-cap', type=float, default=0.03,
                        help='Ceiling on that relative allowance, and the overflow floor above '
                             'which a page has no registration worth comparing against')
    parser.add_argument('--containment-coverage-order', action='store_true',
                        help='Order retained registrations by how much of the drawing the body '
                             'covers instead of by template score')
    parser.add_argument('--camera-prescan', action='store_true',
                        help="Measure every page's own camera before the drive so a page with "
                             "none can borrow the nearest neighbour's")
    parser.add_argument('--retry-passes', type=int, default=0,
                        help='After the main pass, retry pages that failed for want of a camera, '
                             'now that later pages have supplied one')
    parser.add_argument('--pending-body', metavar='PAGE=DIRECTORY', default=None,
                        help='A PDF-derived subassembly built before this page scope, awaiting '
                             'attachment; the driver picks the page to attach it on')
    parser.add_argument('--group-run', action='append', default=[], metavar='PAGE=DIRECTORY',
                        help='PDF-derived subassembly construction for a page that builds a '
                             'separate body; the driver schedules its attachment itself')
    parser.add_argument('--exclude-construction', action='append', default=[],
                        metavar='PAGE=REASON',
                        help='Record that this page\'s construction is deliberately left out, with '
                             'the measured reason. Its pieces stay outstanding and its ink stays '
                             'attributable, and the journal says it was excluded rather than '
                             'merely unsupplied')
    parser.add_argument('--body-area-ratio', type=float, default=0.6,
                        help='A drawing below this fraction of the body silhouette is not a view '
                             'of the body')
    parser.add_argument('--attach-limit', type=int, default=4)
    parser.add_argument('--attach-coarse-pairs', type=int, default=256)
    parser.add_argument('--camera-gate', choices=('off', 'report', 'enforce'), default='enforce',
                        help="Accept a page's camera only when its refined registration is "
                             'contained, covers the drawing and keeps the previous accepted '
                             "page's scale; 'report' measures without filtering")
    parser.add_argument('--camera-unexplained-max', type=float, default=None,
                        help='Drawn ink the body does not explain, as a multiple of the largest '
                             'area this page own allocated pieces could cover')
    parser.add_argument('--camera-scale-tolerance', type=float, default=None,
                        help="Allowed relative difference from the previous page's camera scale")
    parser.add_argument('--seated-tolerance', type=float, default=0.,
                        help='Within this fraction below the best image score, prefer the candidate whose additions have more face contact with the body - a tie-break for a depth difference the image cannot resolve, never an objective')
    parser.add_argument('--local-rerank', type=float, default=0.,
                        help='Weight on evidence restricted to the region an addition changes, '
                             'blended with the whole-drawing score when ranking candidates')
    parser.add_argument('--no-drawing-scale', action='store_true',
                        help="Do not measure the scale between the previous page's drawing and "
                             "this one, nor use it to rescale carried cameras")
    parser.add_argument('--drawing-registration', choices=('off', 'prefer', 'only'), default='off',
                        help="Register this page by propagating the previous page's accepted "
                             'registration through the measured similarity between the two '
                             'drawings, so the emitted body cannot destroy the camera. '
                             "'prefer' keeps body-template registration as a fallback; 'only' "
                             'refuses the drawing rather than falling back')
    parser.add_argument('--drawing-registration-keep', type=int, default=2,
                        help='How many of the alignment ladder’s best scales to propagate')
    parser.add_argument('--repair-anti-studs', action='store_true',
                        help="Move a female anti-stud whose reference point sits inside its own "
                             "tube onto the part's bottom face, where LDCad's own convention puts "
                             'it; without this such a part has no collision-legal mate at all')
    parser.add_argument('--drawing-registration-min-iou', type=float, default=0.6,
                        help='Silhouette agreement below which the two drawings are not treated '
                             'as the same assembly at the same viewpoint')
    parser.add_argument('--no-exploded-target', action='store_true',
                        help='Score every allocated piece against the drawing even when the page '
                             'draws one of them detached; reproduces the round-two objective')
    parser.add_argument('--no-scale-prior', action='store_true',
                        help="Do not offer the previous page's measured camera scale as an extra "
                             'hypothesis on this page')
    parser.add_argument('--scales', type=float, nargs='+', default=[1.0],
                        help='Camera-scale ladder for containment refinement; the stud-row camera '
                             'fixes the projection only up to overall scale')
    parser.add_argument('--views', type=int, default=2)
    parser.add_argument('--scale', type=float, default=1.)
    parser.add_argument('--max-nodes', type=int, default=200000)
    parser.add_argument('--top-k', type=int, default=16)
    parser.add_argument('--host-bytes', type=int, default=4 * 1024 ** 3)
    parser.add_argument('--max-bank-candidates', type=int, default=None,
                        help='Cap the screened candidates the bank rasterises, round robin over '
                             'quota keys by coverage rate. Needed once closures finish: page 28 '
                             "keeps 69% of a 140,430-pose bank, and without a cap build_bank "
                             'refuses and the page produces nothing at all')
    parser.add_argument('--closure-rounds', type=int, default=1)
    parser.add_argument('--max-closure-parents', type=int, default=64,
                        help='Closure parents to expand; 0 removes the budget so the round '
                             'finishes. Round seven measured the cost of finishing: with the '
                             'vectorised collision predicate every 40377 page completes its own '
                             'first round in seconds to 2.4 minutes, against the 26 minutes the '
                             'scalar predicate projected for one page')
    parser.add_argument('--max-poses', type=int, default=8192)
    parser.add_argument('--closure-max-seconds', type=float, default=None,
                        help='Wall-clock bound on one page closure, checked between parents. A '
                             'page that turns out expensive degrades into a partial bank instead '
                             'of hanging the chain, and the registry records that time, not the '
                             'parent or pose cap, is what stopped it')
    parser.add_argument('--per-round-parents', action='store_true',
                        help='Count the closure parent budget per round instead of globally, so '
                             'a second connector hop is reachable on a page whose base-attached '
                             'set already exceeds the budget')
    parser.add_argument('--closure-mode', choices=('bank', 'evidence'), default='evidence',
                        help="'evidence' ranks closure parents by the page's own arrowhead and "
                             "silhouette evidence before spending the parent budget; 'bank' keeps "
                             'the original enumeration order for reproducing earlier runs')
    parser.add_argument('--stable-colors', type=int, nargs='*', default=None)
    parser.add_argument('--method', choices=('beam', 'exact'), default='beam')
    parser.add_argument('--beam', type=int, default=96)
    parser.add_argument('--max-expansions', type=int, default=2_000_000)
    parser.add_argument('--improve-rounds', type=int, default=8)
    parser.add_argument('--improve-from', type=int, default=4)
    parser.add_argument('--restarts', type=int, default=0)
    parser.add_argument('--perturb', type=int, default=2)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--native-rounds', type=int, default=0)
    parser.add_argument('--native-width', type=int, default=16)
    parser.add_argument('--native-starts', type=int, default=1)
    parser.add_argument('--palette-saturation-tiebreak', type=float, default=0.,
                        help='Break ties between palette colours that share a hue by saturation. '
                             'LDraw 19 (Tan) and 191 (Bright Light Orange) both convert to hue '
                             "20, so argmin decides between them by the palette's own order: on "
                             '40377 page 26 that hands all 12,353 orange pixels to tan and leaves '
                             'the page allocating a colour its own classified target does not '
                             'contain. 0 keeps the shipped behaviour. Turning it on changes '
                             'classifications, so scores are comparable only with other runs that '
                             'also set it')
    parser.add_argument('--chromatic-metric', choices=('hue', 'lab'), default='hue',
                        help='Order chromatic palette entries by CIE Lab distance instead of hue. '
                             'Subsumes the saturation tie-break: the hue collision is a cluster, '
                             'not a pair - 41624 has four colours inside nine hue degrees over 25 '
                             'of its 109 parts, and 14 and 191 are not separable in HSV at all. '
                             'Ordering only; acceptance stays the hue test, so the same pixels '
                             'are classified and only which class they get can change. Scores are '
                             'comparable only with other runs that also set it')
    parser.add_argument('--exchange-window-order', choices=('incremental', 'own_agreement'),
                        default='incremental',
                        help="Order the native exchange's rendered window by each candidate's own "
                             'painted agreement instead of by its incremental effect on the '
                             'composite. The incremental rule plateaus - 47-59% of a key\'s '
                             'candidates tie exactly on 40377 page 19, so the window fills in bank '
                             'order and the reference poses sit at window ranks 86-299. Measured '
                             'on that page: native 0.524586 to 0.532940, reference targets 1 of 6 '
                             'to 2 of 6, at 217 renders against 84')
    parser.add_argument('--tie-break', choices=('index', 'pose'), default='index',
                        help='Break exact score ties by the rounded pose instead of by bank '
                             'index. Index order is closure enumeration order, so two '
                             'configurations holding the same tied pair can resolve it '
                             "differently for no reason connected to the drawing: round six's "
                             'parent-budget chain diverged from round five at page 22 because '
                             "page 19's two image-indistinguishable quarter turns of one 25269 "
                             'fell the other way. A chain A/B is only as trustworthy as its tie '
                             'exposure, which every page now journals')
    return parser


def build_options(args):
    """The per-page options dictionary `place_page` consumes."""
    return dict(camera_matrices=args.camera_matrices,
                camera_prior_matrices=args.camera_prior_matrices, per_matrix=args.per_matrix,
                refine_limit=args.refine_limit, window=args.window, tolerance=args.tolerance,
                fraction=args.fraction, fallback=args.fallback, scales=tuple(args.scales),
                containment_multiple=args.containment_multiple,
                containment_cap=args.containment_cap,
                containment_coverage_order=args.containment_coverage_order,
                scale_prior=not args.no_scale_prior, retry_passes=args.retry_passes,
                exploded_target=not args.no_exploded_target,
                drawing_scale=not args.no_drawing_scale,
                repair_anti_studs=args.repair_anti_studs,
                drawing_registration=args.drawing_registration,
                drawing_registration_keep=args.drawing_registration_keep,
                drawing_registration_min_iou=args.drawing_registration_min_iou,
                local_rerank=args.local_rerank, seated_tolerance=args.seated_tolerance,
                camera_gate=args.camera_gate,
                camera_unexplained_max=(args.camera_unexplained_max
                                        if args.camera_unexplained_max is not None
                                        else CAMERA_UNEXPLAINED_MAX),
                camera_scale_tolerance=(args.camera_scale_tolerance
                                        if args.camera_scale_tolerance is not None
                                        else CAMERA_SCALE_TOLERANCE),
                camera_prescan=args.camera_prescan,
                body_area_ratio=args.body_area_ratio, attach_limit=args.attach_limit,
                attach_coarse_pairs=args.attach_coarse_pairs,
                group_runs={entry.split('=', 1)[0]: entry.split('=', 1)[1]
                            for entry in args.group_run},
                excluded_constructions={entry.split('=', 1)[0]: entry.split('=', 1)[1]
                                        for entry in args.exclude_construction},
                pending_body=(dict(page=int(args.pending_body.split('=', 1)[0]),
                                   groups=args.pending_body.split('=', 1)[1])
                              if args.pending_body else None),
                views=args.views, scale=args.scale, max_nodes=args.max_nodes,
                top_k=args.top_k, host_bytes=args.host_bytes,
                max_bank_candidates=args.max_bank_candidates,
                closure_rounds=args.closure_rounds,
                # 0 means "no parent budget": the closure runs to exhaustion.
                # Stored as None so the journal records the intent rather than a
                # sentinel a later reader would have to know about.
                max_closure_parents=(args.max_closure_parents or None),
                max_poses=args.max_poses,
                closure_max_seconds=args.closure_max_seconds,
                closure_mode=args.closure_mode, per_round_parents=args.per_round_parents,
                stable_colors=args.stable_colors, method=args.method, beam=args.beam,
                max_expansions=args.max_expansions, improve_rounds=args.improve_rounds,
                improve_from=args.improve_from, restarts=args.restarts,
                perturb=args.perturb, seed=args.seed,
                native_rounds=args.native_rounds,
                native_width=args.native_width,
                native_starts=args.native_starts,
                palette_saturation_tiebreak=args.palette_saturation_tiebreak,
                chromatic_metric=args.chromatic_metric,
                exchange_window_order=args.exchange_window_order,
                tie_break=args.tie_break)


def apply_palette_options(options):
    """Settle the pixel classifier for the whole process, once, before driving.

    The coarse target, the undrawn-colour rule and the camera gate all classify
    with the same function, so this cannot be a per-call argument: a run whose
    target says a pixel is orange while its undrawn rule says tan contradicts
    itself. Both settings are recorded in the journal options, so a run always
    says which classifier produced its numbers.
    """
    import placement_palette_classes
    weight = float(options.get('palette_saturation_tiebreak') or 0.)
    metric = options.get('chromatic_metric') or 'hue'
    placement_palette_classes.SATURATION_TIEBREAK = weight
    placement_palette_classes.CHROMATIC_METRIC = metric
    return dict(saturation_tiebreak=weight, chromatic_metric=metric)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--allocation-run', type=Path, required=True)
    parser.add_argument('--base-run', type=Path, required=True)
    parser.add_argument('--pages', type=int, nargs='+', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--continue-on-unsupported', action='store_true')
    add_page_options(parser)
    args = parser.parse_args()
    options = build_options(args)
    apply_palette_options(options)
    summary = run(args.pdf, args.allocation_run, args.base_run, args.pages, args.out, options,
                  resume=args.resume, stop_on_unsupported=not args.continue_on_unsupported)
    print(json.dumps(dict(status=summary['status'],
                          placed=[s['page'] for s in summary['steps'] if s['status'] == 'placed'],
                          last=summary.get('last_checkpoint'))))
