"""Joint multi-shape page placement at a contained PDF registration.

Development runner. Bounded candidate closure and registration are uncertified.
No reference poses, set inventory or runtime VLM. Every saved result retains
its limitations; a selected candidate is a hypothesis, not a certified model.

Pipeline per retained camera view:
  occupancy screen (necessary silhouette condition)
    -> per (part, colour) placement bank on the GPU depth/material rasterizer
    -> joint placement search with exact per-key cardinality, pairwise collision
       exclusion and witnessed support connectivity, by support-frontier beam
       (default) or by the exhaustive depth-first traversal
    -> native fixed-registration rerank of the retained complete assemblies

The depth-first traversal does not scale past roughly three additions on a bank
of this size; the beam is the default for that reason and reports its own
incompleteness.

A page can also draw one of its new pieces detached above the assembly. The
image then shows the assembly *without* it, so that piece is withheld from the
image-judged search (`image_pieces`) and attached afterwards from the page's own
arrows (`withheld` plus `arrows`, see `placement_exploded_attach`). Candidates
that cannot receive every withheld piece rank below those that can, because an
assembly with no arrow-supported contact for the incoming piece contradicts the
page's arrows.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from placement_arrow_contacts import read_items
from placement_attach_group import make_assembly
from placement_cardinality_bank import build_bank
from placement_cardinality_search import search_layers
from placement_colored_cad import colored_triangles
from placement_exploded_attach import attach_detached
from placement_layer_beam import search_beam
from placement_local_delta import added_region, local_evidence, render_layers
from placement_mixed_batch_search import fixed_native_score
from placement_part_library import PartLibrary
from placement_multi_shape_batch import shape_bank
from placement_occupancy_screen import screen
from placement_material_scene_score import MaterialFeatureSceneScorer


def world_boxes(poses):
    """Axis-aligned world bounds per pose, from universal CAD vertices.

    Used only to skip provably separated pairs before the expensive voxel
    collision test. A box overlap never asserts a collision.
    """
    library = PartLibrary()
    local = {}
    boxes = []
    for part, T in poses:
        if part not in local:
            vertices = colored_triangles(part, 15, resolver=library.resolve)['triangles'].reshape(-1, 3)
            low, high = vertices.min(0), vertices.max(0)
            corners = np.array([[x, y, z] for x in (low[0], high[0])
                                for y in (low[1], high[1]) for z in (low[2], high[2])])
            local[part] = corners
        world = local[part] @ np.asarray(T)[:3, :3].T + np.asarray(T)[:3, 3]
        boxes.append((world.min(0), world.max(0)))
    return boxes


def native_exchange(scorer, base, placements, keys, indices, M, origin, coarse,
                    conflict, connected, rounds=3, width=16):
    """Quota-preserving exchange judged by the scorer that actually selects.

    The layer search optimises the coarse per-class depth-composite IoU, but the
    emitted assembly is chosen by the native colour-plus-visible-edge scorer.
    Those objectives disagree: on 40377 page index 12 the reference-equivalent
    assembly scored 0.8250 natively against the selected 0.8139, while never
    ranking best on the coarse metric. This pass optimises the selection
    objective directly, over the `width` best coarse alternatives per slot so
    the number of GPU renders stays bounded.
    """
    chosen = list(indices)
    best = fixed_native_score(scorer, base + [item for i in chosen
                                              for item in placements[i]['items']], M, origin)
    renders, swaps, trail = 1, 0, []
    for _ in range(rounds):
        improvement = None
        for position, outgoing in enumerate(chosen):
            rest = chosen[:position] + chosen[position + 1:]
            depth, label = coarse.composite(rest)
            correct, false = coarse.counts(label)
            dc, df = coarse.deltas(depth, label)
            order = np.mean((correct + dc) / np.maximum(1, coarse.areas + false + df), axis=1)
            order = np.where([keys[i] == keys[outgoing] for i in range(len(keys))], order, -np.inf)
            order[chosen] = -np.inf
            for incoming in np.argsort(-order, kind='stable')[:width]:
                incoming = int(incoming)
                if not np.isfinite(order[incoming]):
                    break
                if conflict is not None and any(conflict(incoming, other) for other in rest):
                    continue
                if not connected(tuple(rest) + (incoming,)):
                    continue
                items = base + [item for i in rest + [incoming]
                                for item in placements[i]['items']]
                evidence = fixed_native_score(scorer, items, M, origin)
                renders += 1
                if evidence['score'] > best['score'] + 1e-12 and (
                        improvement is None or evidence['score'] > improvement[0]['score']):
                    improvement = (evidence, position, incoming)
        if improvement is None:
            break
        best, position, incoming = improvement
        trail.append(dict(position=position, incoming=incoming, score=best['score']))
        chosen[position] = incoming
        swaps += 1
    return tuple(sorted(chosen)), best, dict(native_renders=renders, native_swaps=swaps,
                                             trail=trail, width=width, rounds=rounds)


def run(record, registration, scene, base, out, views=3, scale=1., max_nodes=200000,
        top_k=32, host_bytes=512 * 1024 ** 2, method='beam', beam=64,
        max_expansions=2_000_000, improve_rounds=8, improve_from=4,
        restarts=0, perturb=2, seed=0, native_rounds=0, native_width=16, native_starts=1,
        image_pieces=None, withheld=(), arrows=(), outside_fraction=0., local_rerank=0.):
    if method not in ('beam', 'exact'):
        raise ValueError('Unknown search method')
    withheld = [(str(part), int(color)) for part, color in withheld]
    image_pieces = list(record['allocated_pieces'] if image_pieces is None else image_pieces)
    if len(image_pieces) + len(withheld) != len(record['allocated_pieces']):
        raise ValueError('Image-judged and withheld pieces must partition the page allocation')
    if withheld and not arrows:
        raise ValueError('Withheld pieces need the page arrows that place them')
    if not 0. <= local_rerank <= 1.:
        raise ValueError('Local rerank weight must lie between zero and one')
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    poses = [(str(entry['part']), np.asarray(entry['T'], float)) for entry in record['poses']]
    boxes = world_boxes(poses)
    shapes = [dict(items=[(part, 15, T)]) for part, T in poses]
    results, native = [], []
    for view_index, view in enumerate(registration['hypotheses'][:views]):
        M = np.asarray(view['projection'], float)
        origin = np.asarray(view['origin'], float)
        # A view retained by containment refinement carries its own measured
        # body overflow. The occupancy screen must allow exactly that much, or
        # an explicitly uncontained fallback view is rejected here instead of
        # being evaluated, and the page is silently lost. That absolute number
        # is the body's residual, though, not a budget for a candidate: on
        # 40377 page index 17 it is 2 pixels, and the reference-equivalent
        # plate's own antialiasing against the arrow notches in the mask is 19
        # of its 9,551, so it was discarded before it could be scored.
        # `outside_fraction` adds the proportional allowance in the candidate's
        # own units.
        allowance = int(view.get('outside_pixels') or 0)
        gate = screen(base, shapes, M, origin, scorer, outside_tolerance_px=allowance,
                      outside_fraction=outside_fraction)
        gate['registration_overflow_allowance'] = allowance
        gate['contained'] = bool(view.get('contained', True))
        (out / f'view-{view_index:02}-occupancy.json').write_text(json.dumps(gate, indent=2))
        if not gate['registration_consistent']:
            results.append(dict(view=view_index, status='base_registration_rejected',
                                base_occupancy=gate['base'],
                                registration_overflow_allowance=allowance))
            continue
        ids = gate['retained_indices']
        subset = dict(record, poses=[record['poses'][i] for i in ids])
        try:
            placements, quotas = shape_bank(subset, image_pieces)
        except ValueError:
            results.append(dict(view=view_index, status='no_occupancy_compatible_candidates'))
            continue
        try:
            bank = build_bank(base, placements, M, origin, scorer, scale=scale,
                              max_host_bytes=host_bytes)
        except ValueError as exc:
            if 'Bank requires' not in str(exc):
                raise
            results.append(dict(view=view_index, status='host_bank_budget_exceeded',
                                reason=str(exc), occupancy_retained_shapes=len(ids)))
            continue
        original = [ids[p['pose_index']] for p in placements]
        keys = [p['key'] for p in placements]
        anchored = [i for i, p in enumerate(original) if p in set(record['base_supported'])]
        witnesses = {tuple(edge) for edge in record['support_edges']}
        support = [(j, i) for i in range(len(placements)) for j in range(i)
                   if tuple(sorted((original[i], original[j]))) in witnesses]
        physical, collision_cache = {}, {}

        def conflict(i, j):
            a, b = sorted((original[i], original[j]))
            key = (a, b)
            if key not in collision_cache:
                if a == b:
                    collision_cache[key] = True
                elif (boxes[a][1] < boxes[b][0]).any() or (boxes[b][1] < boxes[a][0]).any():
                    collision_cache[key] = False  # provably separated in world space
                else:
                    if a not in physical:
                        physical[a] = make_assembly([(poses[a][0], 15, poses[a][1])])
                    collision_cache[key] = bool(physical[a].collides(poses[b][0], poses[b][1]))
            return collision_cache[key]

        if method == 'beam':
            result = search_beam(bank['base_depth'], bank['base_labels'], bank['depths'],
                                 bank['labels'], keys, quotas, bank['target'],
                                 base_supported=anchored, support_edges=support,
                                 conflict_test=conflict, beam=beam, top_k=top_k,
                                 max_expansions=max_expansions,
                                 improve_rounds=improve_rounds, improve_from=improve_from,
                                 restarts=restarts, perturb=perturb, seed=seed)
        else:
            # Single-layer target agreement changes traversal order only; it
            # removes no candidate from the exact-cardinality search.
            priorities = [float(np.sum((bank['labels'][i] == bank['target']) & (bank['target'] > 0)))
                          for i in range(len(placements))]
            result = search_layers(bank['base_depth'], bank['base_labels'], bank['depths'],
                                   bank['labels'], keys, quotas, bank['target'],
                                   base_supported=anchored, support_edges=support,
                                   max_nodes=max_nodes, conflict_test=conflict,
                                   priorities=priorities, top_k=top_k)
        result.update(view=view_index, status='bounded_search', search_method=method,
                      bank_metadata=bank['metadata'],
                      occupancy_retained_shapes=len(ids), placements=len(placements),
                      quotas={f'{p}:{c}': q for (p, c), q in quotas.items()},
                      collision_pairs_tested=len(collision_cache))
        candidates = list(result['candidates'])
        if native_rounds and candidates and method == 'beam':
            from placement_layer_beam import LayerComposite
            coarse = LayerComposite(bank['base_depth'], bank['base_labels'], bank['depths'],
                                    bank['labels'], bank['target'])
            adjacency = [set() for _ in range(len(placements))]
            for a, b in support:
                adjacency[a].add(b)
                adjacency[b].add(a)
            anchor_set = set(anchored)

            def connected(group):
                wanted = set(group)
                seen = wanted & anchor_set
                todo = list(seen)
                while todo:
                    fresh = (adjacency[todo.pop()] & wanted) - seen
                    seen.update(fresh)
                    todo.extend(fresh)
                return seen == wanted

            # Different coarse optima lead to different native optima, so the
            # exchange is restarted from several of them rather than only the
            # coarse best. Every distinct result is kept for the rerank.
            reports, produced = [], []
            for start in candidates[:max(1, native_starts)]:
                refined, evidence, report = native_exchange(
                    scorer, base, placements, keys, start['indices'], M, origin, coarse,
                    conflict, connected, rounds=native_rounds, width=native_width)
                report['start'] = list(start['indices'])
                report['native_score'] = evidence['score']
                reports.append(report)
                if refined != tuple(start['indices']):
                    produced.append((evidence['score'], refined))
            result['native_exchange'] = reports
            seen_sets = {tuple(row['indices']) for row in candidates}
            for _, refined in sorted(produced, key=lambda row: -row[0]):
                if refined in seen_sets:
                    continue
                seen_sets.add(refined)
                candidates.insert(0, dict(indices=list(refined), score=coarse.score(refined),
                                          native_exchange=True))
        base_layer = None
        if local_rerank:
            # One render of the body per view: everything a candidate's own
            # additions cannot change.
            fixed_native_score(scorer, base, M, origin)
            base_layer = render_layers(scorer, base, M)
        for candidate in candidates:
            drawn = base + [item for i in candidate['indices'] for item in placements[i]['items']]
            # The drawing shows the assembly without the withheld pieces, so the
            # image score is taken on exactly that assembly.
            evidence = fixed_native_score(scorer, drawn, M, origin)
            local = None
            if local_rerank:
                layer = render_layers(scorer, drawn, M)
                local = local_evidence(scorer, base_layer, layer,
                                       added_region(base_layer, layer, scorer.mask))
                evidence = dict(evidence, local=local,
                                combined_score=(1 - local_rerank) * evidence['score']
                                + local_rerank * local['local_score'])
            attached, attachment = [], None
            if withheld:
                attached, attachment = attach_detached(drawn, withheld, record['poses'],
                                                       M, origin, arrows)
            items = drawn + attached
            lines = ['0 Quarantined PDF multi-shape batch; uncertified bounded search']
            for part, color, T in items:
                lines.append('1 ' + str(color) + ' ' + ' '.join(
                    f'{v:.8g}' for v in np.r_[T[:3, 3], T[:3, :3].flatten()]) + ' ' + part + '.dat')
            native.append(dict(view=view_index, projection=M.tolist(), origin=origin.tolist(),
                               coarse=dict(indices=list(candidate['indices']),
                                           score=candidate['score']),
                               evidence=evidence, arrow_attachment=attachment,
                               attached_pieces=len(attached),
                               model='\n'.join(lines) + '\n', _items=items, _drawn=drawn))
        results.append(result)
    # An assembly that offers no arrow-supported contact for an incoming piece
    # contradicts the page's own arrows, so it ranks below one that does. Within
    # each group the drawn-assembly image score decides, unchanged.
    native.sort(key=lambda r: (-r['attached_pieces'],
                               -r['evidence'].get('combined_score', r['evidence']['score'])))
    for index, row in enumerate(native):
        model = row.pop('model')
        row.pop('_items')
        drawn = row.pop('_drawn')
        row['file'] = f'beam_{index:02}.ldr'
        (out / row['file']).write_text(model)
        if index == 0:
            (out / 'model.ldr').write_text(model)
            # The saved render is the assembly the drawing shows, which is what
            # the recorded evidence scored; a withheld piece is not drawn on it.
            check = fixed_native_score(scorer, drawn, row['projection'], row['origin'],
                                       out / 'selected.png')
            if check != row['evidence']:
                raise AssertionError('Selected native PNG render evidence changed')
    dependencies = {}
    for parsed in scorer.geometry.values():
        dependencies.update(parsed.get('files', {}))
    return dict(status='candidates' if native else 'no_models', views=results, results=native,
                pdf_only=True, base_source=record['base_source'], base_sha256=record['base_sha256'],
                geometry_dependencies=dependencies, page=record['page'],
                xref=registration['xref'], shapes=record['parts'],
                selected_parts=(len(base) + len(image_pieces) + native[0]['attached_pieces'])
                if native else None,
                image_pieces=[list(p) for p in image_pieces], local_rerank=local_rerank,
                withheld_pieces=[list(p) for p in withheld],
                truth_used=False, runtime_vlm_calls=0, certified=False,
                uncontained_views=[i for i, v in enumerate(registration['hypotheses'][:views])
                                   if not v.get('contained', True)],
                limitations='Finite registered candidate bank; occupancy conditional on image '
                            'tolerance; bounded closure support graph may omit legal edges; finite '
                            'node budget and optional coarse raster lose optimality guarantees '
                            'outside the searched representation. Only retained complete '
                            'assemblies receive native reranking.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--views', type=int, default=3)
    parser.add_argument('--scale', type=float, default=1.)
    parser.add_argument('--max-nodes', type=int, default=200000)
    parser.add_argument('--top-k', type=int, default=32)
    parser.add_argument('--host-bytes', type=int, default=512 * 1024 ** 2)
    parser.add_argument('--method', choices=('beam', 'exact'), default='beam')
    parser.add_argument('--beam', type=int, default=64)
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
    record = json.loads(args.registry.read_text())
    registration = json.loads(args.registration.read_text())
    base_path = Path(record['base_source'])
    for value in (record, registration):
        if value.get('truth_used') is not False or value.get('runtime_vlm_calls') != 0:
            raise ValueError('Runtime provenance missing')
    if (registration['base_sha256'] != record['base_sha256']
            or hashlib.sha256(base_path.read_bytes()).hexdigest() != record['base_sha256']):
        raise ValueError('Registration/body mismatch')
    if registration['pdf_sha256'] != record['pdf_sha256'] or registration['page'] != record['page']:
        raise ValueError('PDF page mismatch')
    if hashlib.sha256(Path(record['pdf']).read_bytes()).hexdigest() != record['pdf_sha256']:
        raise ValueError('Actual PDF file hash mismatch')
    import pymupdf
    from vector_scene import scene_images
    with pymupdf.open(record['pdf']) as doc:
        scene = next(s for s in scene_images(doc, doc[record['page']])
                     if s['xref'] == registration['xref'])
    args.out.mkdir(parents=True, exist_ok=False)
    snapshot = args.out / 'source'
    snapshot.mkdir()
    hashes = {}
    for path in Path(__file__).parent.glob('*.py'):
        payload = path.read_bytes()
        (snapshot / path.name).write_bytes(payload)
        hashes[path.name] = hashlib.sha256(payload).hexdigest()
    result = run(record, registration, scene, read_items(base_path), args.out, args.views,
                 args.scale, args.max_nodes, args.top_k, args.host_bytes, args.method,
                 args.beam, args.max_expansions, args.improve_rounds, args.improve_from,
                 args.restarts, args.perturb, args.seed,
                 args.native_rounds, args.native_width, args.native_starts)
    result.update(pdf=record['pdf'], pdf_sha256=record['pdf_sha256'],
                  registry_sha256=hashlib.sha256(args.registry.read_bytes()).hexdigest(),
                  registration_sha256=hashlib.sha256(args.registration.read_bytes()).hexdigest(),
                  code_sha256_start=hashes)
    (args.out / 'results.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ('results', 'views', 'geometry_dependencies', 'code_sha256_start')}))
