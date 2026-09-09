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

A page's camera can come from a neighbour, not only from its predecessor. The
prior is the previous page's measured matrix, so the first page of a scope has
none and a drawing there exposing no stud row dies with `no_camera_hypothesis`
- 41624 page index 3 does exactly that and loses three pieces. `--camera-prescan`
measures every page's own camera up front and lets a page borrow the nearest
page that has one, in either direction. Every page is in the same PDF, so this
is not new information, and a borrowed matrix is recorded as such.

A page that fails only for want of a camera can also be retried after later pages
have supplied one. The driver's camera prior is the previous page's measured
matrix, so the first page of a scope has none, and a drawing that exposes no
stud row there dies with `no_camera_hypothesis` - 41624 page index 3 does
exactly that. Every page is in the same PDF, so retrying it once a neighbour has
been registered uses no new information; the pieces simply join a body that has
grown, which the final assembly does not distinguish. Retries are recorded with
their pass number and the order they were taken in.

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
    if record.get('resume_config') != config:
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
        return 'attachment_failed', detail, None, (), None
    return 'placed', detail, placement, (), None


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


def nearest_prescan(prescan, page):
    """Matrices of the page nearest `page` that has any, ties preferring earlier."""
    if not prescan:
        return (), None
    source = min(prescan, key=lambda other: (abs(other - page), other))
    return list(prescan[source]), source


def place_page(pdf, page, allocation_run, base_model, step_dir, options, prior_matrices=(),
               prior_scale=None, pending=None, prior_body_area=0, prescan=None):
    """Return (status, detail, placement_dir_or_None, matrices, scale) for one page.

    Several drawings on a page can be non-panel scenes: a subassembly beside
    the body, or a second view of it. Layout cannot rank them, so each is tried
    in drawn-area order and the first that yields a usable registration and a
    complete search result is taken; every attempt is saved.
    """
    from placement_arrow_contacts import read_items
    from placement_arrow_mask import conservative_components
    from placement_body_registration import register
    from placement_evidence_closure import rank_parents
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
    camera = page_camera(pdf, page, allocation_run, step_dir / 'camera',
                         prior_parts=[(part, color) for part, color, _ in base])
    write_atomic(step_dir / 'camera.json', json.dumps(camera, indent=2, default=str))
    if not camera['native_scenes']:
        if not pieces:
            return ('no_allocation', dict(reason='Page adds no allocated piece and exposes no '
                                                 'drawing to attach a pending body against'),
                    None, (), None)
        return ('camera_unsupported', dict(reason=camera['status'],
                                           scene_kinds=camera.get('scene_kinds')), None, (), None)

    # What kind of step is this? A drawing that shows the current assembly
    # cannot be much smaller than that assembly's own silhouette, so the page
    # itself says whether it adds to the body, builds a separate one, or
    # attaches one that is already pending.
    with pymupdf.open(pdf) as doc:
        page_scenes = {s['xref']: s for s in scene_images(doc, doc[page])}
    areas = [int(np.asarray(page_scenes[record['xref']]['mask'], bool).sum())
             for record in camera['native_scenes'] if record['xref'] in page_scenes]
    reference_matrix = (list(prior_matrices) or
                        [h['matrix'] for record in camera['native_scenes']
                         for h in record['multirow']['hypotheses']])[:1]
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
                         previous_body_drawing_area=int(prior_body_area))
    write_atomic(step_dir / 'page-kind.json', json.dumps(kind_evidence, indent=2))
    if kind == 'attachment':
        return attach_pending(pdf, page, base_model, step_dir, options, pending, kind_evidence)
    if kind == 'no_allocation':
        return ('no_allocation', dict(reason='Page adds no allocated piece and no subassembly is '
                                             'pending', kind_evidence=kind_evidence),
                None, (), None)
    if kind == 'subassembly':
        return ('subassembly_page',
                dict(reason='The page draws no view of the current assembly, so it builds a '
                            'separate body; construction of a body from nothing is not '
                            'implemented in the driver',
                     kind_evidence=kind_evidence), None, (), None)

    # Base-attached enumeration depends only on the body and the allocation, so
    # it is done once; closure is per drawing because in evidence mode the
    # parent order comes from that drawing's own refined registration.
    seed = ShapeRegistry(base, pieces)
    provenance_fields = dict(provenance, pdf=str(pdf), page=page, base_source=str(base_model),
                             base_sha256=file_hash(base_model), allocated_pieces=pieces,
                             runtime_vlm_calls=0)
    if not seed.poses:
        return ('no_candidate_poses', dict(reason='No collision-free connector mate for any '
                                                  'allocated shape on the existing body'),
                None, (), None)
    evidence_mode = options.get('closure_mode', 'bank') == 'evidence'
    bank = None
    if not evidence_mode:
        bank = seed.branch().close(options['closure_rounds'], options['max_closure_parents'],
                                   options['max_poses']).record()
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
        matrices = (proposed or fallback_matrices)[:options['camera_matrices']]
        rescaled = (scale_prior_matrices(matrices, prior_scale) if options.get('scale_prior', True)
                    else [])
        matrices = matrices + rescaled
        if not matrices:
            attempts.append(dict(xref=xref, status='no_camera_hypothesis'))
            continue
        with pymupdf.open(pdf) as doc:
            scene = next(s for s in scene_images(doc, doc[page]) if s['xref'] == xref)
        arrows = conservative_components(scene, protected_colors=palette['rgb'])['arrows']
        if scene_record.get('mask_source') == 'largest_component':
            # A piece drawn detached above the assembly is not in the body yet.
            # Leaving it in the target makes its pixels permanently unexplained,
            # which both drags the registration off the body and collapses the
            # score. Restricting the target to the body's own image component
            # scores the assembly against the assembly.
            scene = restrict_to_body_component(scene, [], palette)
        hypotheses = []
        for index, matrix in enumerate(matrices):
            registered = register(scene, base, matrix, stable_colors=tuple(stable))
            for row in registered['hypotheses'][:options['per_matrix']]:
                hypotheses.append(dict(row, matrix_index=index))
        hypotheses.sort(key=lambda r: -r['score'])
        write_atomic(step_dir / f'registration-{order:02d}.json',
                     json.dumps(dict(hypotheses=hypotheses, stable_colors=stable, page=page,
                                     xref=xref, reused_prior_camera=reused, pdf=str(pdf),
                                     scale_prior_px_per_ldu=prior_scale,
                                     scale_prior_matrices=len(rescaled),
                                     borrowed_camera_page=borrowed_from,
                                     matrix_scales=[projection_scale(m) for m in matrices],
                                     pdf_sha256=provenance['pdf_sha256'], base=str(base_model),
                                     base_sha256=file_hash(base_model),
                                     camera_matrices=len(matrices), truth_used=False,
                                     runtime_vlm_calls=0, certified=False), indent=2))
        scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
        contained = refine(base, hypotheses[:options['refine_limit']], scorer,
                           window=options['window'], tolerance=options['tolerance'],
                           fraction=options['fraction'], fallback=options['fallback'],
                           screen_fn=screen, scales=tuple(options.get('scales') or (1.0,)))
        contained.update(page=page, xref=xref, pdf=str(pdf),
                         pdf_sha256=provenance['pdf_sha256'], base=str(base_model),
                         base_sha256=file_hash(base_model), reused_prior_camera=reused)
        write_atomic(step_dir / f'registration-refined-{order:02d}.json',
                     json.dumps(contained, indent=2))
        if not contained['hypotheses']:
            attempts.append(dict(xref=xref, status='no_contained_registration',
                                 reused_prior_camera=reused, borrowed_camera_page=borrowed_from,
                                 best_overflow=min((r['best_containment']['outside_pixels']
                                                    for r in contained['evaluated']), default=None)))
            continue
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
                options['max_poses'], parent_order, 'pdf_evidence').record()
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
                            native_starts=options['native_starts'])
        result.update(pdf=str(pdf), pdf_sha256=provenance['pdf_sha256'],
                      seconds=time.perf_counter() - started, code_sha256_start=code_hashes,
                      camera_source=str(step_dir / 'camera.json'), scene_order=order,
                      reused_prior_camera=reused, stable_colors=stable,
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
        detail = dict(selected_parts=result['selected_parts'], shapes=result['shapes'],
                      seconds=result['seconds'], xref=xref, scene_order=order,
                      reused_prior_camera=reused, borrowed_camera_page=borrowed_from,
                      mask_source=scene_record.get('mask_source'),
                      containment_fallback=contained['containment_fallback_used'],
                      attempts=attempts, scale_prior_px_per_ldu=prior_scale,
                      camera_scale_px_per_ldu=projection_scale(
                          contained['hypotheses'][0]['projection']),
                      score=result['results'][0]['evidence']['score'])
        return ('placed', detail, placement, matrices,
                projection_scale(contained['hypotheses'][0]['projection']))
    return ('camera_unsupported' if attempts and all(a['status'] == 'no_camera_hypothesis'
                                                     for a in attempts)
            else 'no_contained_registration',
            dict(reason='No page drawing produced a usable registration', attempts=attempts),
            None, (), None)


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
    RETRYABLE = ('camera_unsupported', 'no_contained_registration')
    deferred = []
    current = base_model
    prior_matrices, prior_scale = (), None
    # Subassembly constructions supplied for specific pages; the driver decides
    # when to attach them, which page the booklet points at, and records both.
    supplied = dict(options.get('group_runs') or {})
    # A subassembly may have been built before this run's page scope begins -
    # 40377 builds one on page index 13, which the allocation scopes out because
    # of a mould ambiguity resolved in separate branches. Declaring it pending
    # lets the driver schedule its attachment on the page that asks for it
    # instead of the attachment being issued by hand.
    pending, prior_body_area = options.get('pending_body'), 0
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
            status, detail, placement, matrices, scale = place_page(
                pdf, page, allocation_run, current, step_dir, options, prior_matrices, prior_scale,
                pending, prior_body_area, prescan)
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
                pending = None
        except Exception as exc:  # keep the failed page's evidence, never a silent skip
            status, detail, placement = 'error', dict(error=str(exc),
                                                      traceback=traceback.format_exc()), None
        step = dict(page=page, status=status, detail=detail, directory=str(step_dir))
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
                status, detail, placement, matrices, scale = place_page(
                    pdf, page, allocation_run, current, step_dir, options, prior_matrices,
                    prior_scale, pending, prior_body_area, prescan)
                if matrices:
                    prior_matrices = matrices
                if scale:
                    prior_scale = scale
            except Exception as exc:
                status, detail, placement = 'error', dict(error=str(exc),
                                                          traceback=traceback.format_exc()), None
            step = dict(page=page, status=status, detail=detail, directory=str(step_dir),
                        retry_pass=attempt_pass, pending_body=dict(pending) if pending else None)
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--allocation-run', type=Path, required=True)
    parser.add_argument('--base-run', type=Path, required=True)
    parser.add_argument('--pages', type=int, nargs='+', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--continue-on-unsupported', action='store_true')
    parser.add_argument('--camera-matrices', type=int, default=2)
    parser.add_argument('--per-matrix', type=int, default=6)
    parser.add_argument('--refine-limit', type=int, default=16)
    parser.add_argument('--window', type=int, default=3)
    parser.add_argument('--tolerance', type=int, default=0)
    parser.add_argument('--fraction', type=float, default=0.0,
                        help='Overflow allowed as a fraction of the rendered body area')
    parser.add_argument('--fallback', type=int, default=0,
                        help='Proceed on this many least-overflowing views when none is contained')
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
    parser.add_argument('--body-area-ratio', type=float, default=0.6,
                        help='A drawing below this fraction of the body silhouette is not a view '
                             'of the body')
    parser.add_argument('--attach-limit', type=int, default=4)
    parser.add_argument('--attach-coarse-pairs', type=int, default=256)
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
    parser.add_argument('--closure-rounds', type=int, default=1)
    parser.add_argument('--max-closure-parents', type=int, default=64)
    parser.add_argument('--max-poses', type=int, default=8192)
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
    args = parser.parse_args()
    options = dict(camera_matrices=args.camera_matrices, per_matrix=args.per_matrix,
                   refine_limit=args.refine_limit, window=args.window, tolerance=args.tolerance,
                   fraction=args.fraction, fallback=args.fallback, scales=tuple(args.scales),
                   scale_prior=not args.no_scale_prior, retry_passes=args.retry_passes,
                   camera_prescan=args.camera_prescan,
                   body_area_ratio=args.body_area_ratio, attach_limit=args.attach_limit,
                   attach_coarse_pairs=args.attach_coarse_pairs,
                   group_runs={entry.split('=', 1)[0]: entry.split('=', 1)[1]
                               for entry in args.group_run},
                   pending_body=(dict(page=int(args.pending_body.split('=', 1)[0]),
                                      groups=args.pending_body.split('=', 1)[1])
                                 if args.pending_body else None),
                   views=args.views, scale=args.scale, max_nodes=args.max_nodes,
                   top_k=args.top_k, host_bytes=args.host_bytes,
                   closure_rounds=args.closure_rounds,
                   max_closure_parents=args.max_closure_parents, max_poses=args.max_poses,
                   closure_mode=args.closure_mode,
                   stable_colors=args.stable_colors, method=args.method, beam=args.beam,
                   max_expansions=args.max_expansions, improve_rounds=args.improve_rounds,
                   improve_from=args.improve_from, restarts=args.restarts,
                   perturb=args.perturb, seed=args.seed,
                   native_rounds=args.native_rounds,
                   native_width=args.native_width,
                   native_starts=args.native_starts)
    summary = run(args.pdf, args.allocation_run, args.base_run, args.pages, args.out, options,
                  resume=args.resume, stop_on_unsupported=not args.continue_on_unsupported)
    print(json.dumps(dict(status=summary['status'],
                          placed=[s['page'] for s in summary['steps'] if s['status'] == 'placed'],
                          last=summary.get('last_checkpoint'))))
