"""Joint multi-shape page placement at a contained PDF registration.

Development runner. Bounded candidate closure and registration are uncertified.
No reference poses, set inventory or runtime VLM. Every saved result retains
its limitations; a selected candidate is a hypothesis, not a certified model.

Pipeline per retained camera view:
  occupancy screen (necessary silhouette condition)
    -> per (part, colour) placement bank on the GPU depth/material rasterizer
    -> exact-cardinality joint search with collision and support constraints
    -> native fixed-registration rerank of the retained complete assemblies
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
from placement_mixed_batch_search import fixed_native_score
from placement_multi_shape_batch import shape_bank
from placement_occupancy_screen import screen
from placement_material_scene_score import MaterialFeatureSceneScorer


def run(record, registration, scene, base, out, views=3, scale=1., max_nodes=200000,
        top_k=32, host_bytes=512 * 1024 ** 2):
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    poses = [(str(entry['part']), np.asarray(entry['T'], float)) for entry in record['poses']]
    shapes = [dict(items=[(part, 15, T)]) for part, T in poses]
    results, native = [], []
    for view_index, view in enumerate(registration['hypotheses'][:views]):
        M = np.asarray(view['projection'], float)
        origin = np.asarray(view['origin'], float)
        gate = screen(base, shapes, M, origin, scorer)
        (out / f'view-{view_index:02}-occupancy.json').write_text(json.dumps(gate, indent=2))
        if not gate['registration_consistent']:
            results.append(dict(view=view_index, status='base_registration_rejected',
                                base_occupancy=gate['base']))
            continue
        ids = gate['retained_indices']
        subset = dict(record, poses=[record['poses'][i] for i in ids])
        try:
            placements, quotas = shape_bank(subset, record['allocated_pieces'])
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
                else:
                    if a not in physical:
                        physical[a] = make_assembly([(poses[a][0], 15, poses[a][1])])
                    collision_cache[key] = bool(physical[a].collides(poses[b][0], poses[b][1]))
            return collision_cache[key]

        # Single-layer target agreement changes traversal order only; it removes
        # no candidate from the exact-cardinality search.
        priorities = [float(np.sum((bank['labels'][i] == bank['target']) & (bank['target'] > 0)))
                      for i in range(len(placements))]
        result = search_layers(bank['base_depth'], bank['base_labels'], bank['depths'],
                               bank['labels'], keys, quotas, bank['target'],
                               base_supported=anchored, support_edges=support,
                               max_nodes=max_nodes, conflict_test=conflict,
                               priorities=priorities, top_k=top_k)
        result.update(view=view_index, status='bounded_search', bank_metadata=bank['metadata'],
                      occupancy_retained_shapes=len(ids), placements=len(placements),
                      quotas={f'{p}:{c}': q for (p, c), q in quotas.items()},
                      collision_pairs_tested=len(collision_cache))
        for candidate in result['candidates']:
            items = base + [item for i in candidate['indices'] for item in placements[i]['items']]
            evidence = fixed_native_score(scorer, items, M, origin)
            lines = ['0 Quarantined PDF multi-shape batch; uncertified bounded search']
            for part, color, T in items:
                lines.append('1 ' + str(color) + ' ' + ' '.join(
                    f'{v:.8g}' for v in np.r_[T[:3, 3], T[:3, :3].flatten()]) + ' ' + part + '.dat')
            native.append(dict(view=view_index, projection=M.tolist(), origin=origin.tolist(),
                               coarse=dict(indices=list(candidate['indices']),
                                           score=candidate['score']),
                               evidence=evidence, model='\n'.join(lines) + '\n', _items=items))
        results.append(result)
    native.sort(key=lambda r: -r['evidence']['score'])
    for index, row in enumerate(native):
        model = row.pop('model')
        items = row.pop('_items')
        row['file'] = f'beam_{index:02}.ldr'
        (out / row['file']).write_text(model)
        if index == 0:
            (out / 'model.ldr').write_text(model)
            check = fixed_native_score(scorer, items, row['projection'], row['origin'],
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
                selected_parts=len(base) + len(record['allocated_pieces']) if native else None,
                truth_used=False, runtime_vlm_calls=0, certified=False,
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
                 args.scale, args.max_nodes, args.top_k, args.host_bytes)
    result.update(pdf=record['pdf'], pdf_sha256=record['pdf_sha256'],
                  registry_sha256=hashlib.sha256(args.registry.read_bytes()).hexdigest(),
                  registration_sha256=hashlib.sha256(args.registration.read_bytes()).hexdigest(),
                  code_sha256_start=hashes)
    (args.out / 'results.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ('results', 'views', 'geometry_dependencies', 'code_sha256_start')}))
