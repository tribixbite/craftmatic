"""PDF/CAD-only correspondence replay of a quarantined runtime candidate bank.

This measures discrimination, not proposal recall or autonomous reconstruction.
All candidates get the same union of bank camera matrices and bbox-centred
translation initialization. No accepted camera origin is inherited. Cameras
are still legacy-generated proposals: this is not joint camera inference.
Evaluation is a separate process with a sealed runtime report as input.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import shutil
import time

import cv2
import numpy as np

from placement_arrow_contacts import read_items
from placement_feature_edges import FeatureEdgeScorer
from placement_run_scene import run_scene
from placement_v2_correspondence import score_correspondence
from placement_v2_observations import instance_owner, observed_tokens, predicted_tokens
from placement_v2_curves import curve_observations, score_curves
from placement_v2_registration import align_tokens
from placement_v2_display import partition_display


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_hashes():
    here = Path(__file__).resolve().parent
    names = ['placement_v2_replay.py', 'placement_v2_observations.py',
             'placement_v2_correspondence.py', 'placement_feature_edges.py',
             'placement_gpu_colored_scene_score.py', 'placement_cuda_layers.py',
             'placement_cuda_planes.py', 'placement_run_scene.py', 'placement_v2_curves.py',
             'placement_studs.py', 'placement_v2_registration.py', 'placement_v2_display.py',
             'placement_arrow_contacts.py', 'placement_arrow_mask.py', 'placement_colored_cad.py',
             'placement_colored_scene_score.py', 'placement_part_library.py', 'vector_scene.py']
    return {name: digest(here / name) for name in names}


def run(directory, out, spacing=3, limit=None, curves=False, refine_translation=False, arrows=False):
    directory, out = Path(directory), Path(out)
    if out.exists():
        raise ValueError('Use a fresh output directory; experiment artifacts are immutable')
    meta = json.loads((directory / 'results.json').read_text())
    if meta.get('truth_used') is not False or meta.get('runtime_vlm_calls') != 0:
        raise ValueError('Candidate bank must declare reference-free zero-VLM provenance')
    pdf_hash = digest(meta['pdf'])
    if pdf_hash != meta['pdf_sha256']:
        raise ValueError('PDF differs from the candidate bank source')
    for path, expected in meta.get('geometry_dependencies', {}).items():
        if digest(path) != expected:
            raise ValueError(f'Universal CAD differs from the candidate bank: {path}')
    rows = meta['results'][:limit] if limit else meta['results']
    if not rows:
        raise ValueError('No retained runtime candidates')
    # Only bare local filenames are accepted; avoid accidental reference access.
    for row in rows:
        if Path(row['file']).name != row['file']:
            raise ValueError('Candidate filenames must be local to the runtime bank')
    items0 = read_items(directory / rows[0]['file'])
    scene, mask_source = run_scene(meta, items0)
    arrow_observations = []
    if arrows and any(row.get('attached_pieces', 0) for row in rows):
        from placement_arrow_mask import conservative_components
        from placement_page_mask import part_palette
        whole_scene, _ = run_scene(meta, items0, mask_source='whole_scene')
        palette = part_palette([(p,c) for p,c,_ in items0])
        arrow_observations = conservative_components(whole_scene, protected_colors=palette['rgb'])['arrows']
    observations = observed_tokens(scene['rgb'], scene['mask'], spacing=spacing)
    target_curves = curve_observations(scene['rgb'], scene['mask']) if curves else []
    matrices = []
    for row in meta['results']:
        matrix = np.asarray(row['projection'], float)
        if not any(np.allclose(matrix, old, atol=1e-8, rtol=0) for old in matrices):
            matrices.append(matrix)
    out.mkdir(parents=True)
    hashes = source_hashes()
    (out / 'sources').mkdir()
    for name in hashes:
        shutil.copyfile(Path(__file__).resolve().parent / name, out / 'sources' / name)
    manifest = dict(protocol='v2-exclusive-raster-correspondence-replay-v1',
                    candidate_bank=str(directory), bank_sha256=digest(directory / 'results.json'),
                    pdf_sha256=pdf_hash, page=meta['page'], xref=meta['xref'], mask_source=mask_source,
                    spacing=spacing, curves=curves, target_curves=target_curves,
                    refine_translation=refine_translation,
                    arrows=arrows, arrow_observations=arrow_observations,
                    display_policy='Exclude provenance-verified appended arrow attachments from seated drawing',
                    curve_weight=.5 if curves and target_curves else 0.,
                    camera_count=len(matrices), candidate_count=len(rows),
                    camera_policy='same matrix union for every candidate; independent bbox centering',
                    prediction='Adding explicit visible instance seams may break same-color ties; '
                               'no claimed pose improvement until separate evaluation.',
                    source_hashes_start=hashes, truth_used=False, runtime_vlm_calls=0,
                    certified=False, limitations='Retained old candidate bank, inherited scene selection '
                    'and camera proposals; no new proposal generation or complete-set reconstruction.')
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    cv2.imwrite(str(out / 'target-native.png'), cv2.cvtColor(scene['rgb'], cv2.COLOR_RGB2BGR))
    target_rgb = scene['rgb'].copy()
    target_rgb[~scene['mask']] = 245
    cv2.imwrite(str(out / 'target.png'), cv2.cvtColor(target_rgb, cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(out / 'target-mask.png'), scene['mask'].astype(np.uint8) * 255)
    scorer = FeatureEdgeScorer(scene, span_tolerance=float('inf'), plane_depth=True)
    started = time.perf_counter()
    records = []
    for index, row in enumerate(rows):
        source = directory / row['file']
        items = read_items(source)
        drawn, detached, display_record = partition_display(items, row)
        per_view = []
        for camera_index, matrix in enumerate(matrices):
            evidence = scorer.score(drawn, matrix)
            layer = scorer.last_layer
            owner = instance_owner(layer['owner'][0],
                                   [len(scorer.geometry[(p, str(c))]['triangles']) for p, c, _ in drawn])
            for seams in (False, True):
                predicted, buffers = predicted_tokens(scorer.last_outline, layer['mask'][0], owner,
                                                       spacing=spacing, include_seams=seams)
                result = score_correspondence(predicted, observations)
                summary = asdict(result)
                offset = (0., 0.)
                if curves:
                    detected = curve_observations(buffers['outline'], layer['mask'][0])
                    curve_result = score_curves(detected, target_curves)
                    summary['edge_normalized_cost'] = summary['normalized_cost']
                    summary['curve_result'] = curve_result
                    if target_curves:
                        summary['normalized_cost'] = .5 * (summary['normalized_cost'] +
                                                           curve_result['normalized_cost'])
                if refine_translation:
                    aligned = align_tokens(predicted, observations, steps=(4., 2., 1.))
                    adjusted = asdict(aligned.correspondence)
                    if curves:
                        shifted_curves = [dict(c, center=(np.asarray(c['center']) + aligned.offset).tolist())
                                          for c in detected]
                        curve_result = score_curves(shifted_curves, target_curves)
                        adjusted['edge_normalized_cost'] = adjusted['normalized_cost']
                        adjusted['curve_result'] = curve_result
                        if target_curves:
                            adjusted['normalized_cost'] = .5 * (adjusted['normalized_cost'] +
                                                                 curve_result['normalized_cost'])
                    if adjusted['normalized_cost'] < summary['normalized_cost']:
                        summary, offset = adjusted, aligned.offset
                summary['translation_offset'] = list(offset)
                if arrows and detached:
                    if len(detached) == 1 and arrow_observations:
                        from placement_arrow_contacts import batch_score_insertion_targets
                        part, color, transform = detached[0]
                        contact = batch_score_insertion_targets(drawn, part, [transform], matrix,
                                     np.asarray(evidence['image_origin']) + offset, arrow_observations)[0]
                        summary['arrow_evidence'] = contact
                        arrow_cost = min(2., contact['tolerance_adjusted_error_px'] / 4.) if contact.get('supported') else 2.
                        summary['visual_normalized_cost'] = summary['normalized_cost']
                        summary['normalized_cost'] = .5 * (summary['normalized_cost'] + arrow_cost)
                    else:
                        summary['arrow_evidence'] = dict(supported=False, reason='Only one detached group supported')
                summary['match_count'] = len(summary.pop('matches'))
                for name in list(summary):
                    if name.startswith('unmatched') and isinstance(summary[name], (list, tuple)):
                        summary[name + '_count'] = len(summary.pop(name))
                summary.update(camera_index=camera_index, seams=seams,
                               origin=(np.asarray(evidence['image_origin']) + offset).tolist(),
                               predicted_tokens=len(predicted), observed_tokens=len(observations),
                               invisible_instances=[f'part:{i}' for i in range(len(drawn))
                                                    if i + 1 not in set(np.unique(owner))])
                per_view.append(summary)
                display = cv2.warpAffine(buffers['outline'], np.array([[1., 0., offset[0]], [0., 1., offset[1]]]),
                                         (scene['mask'].shape[1], scene['mask'].shape[0]), borderValue=(245,245,245))
                cv2.imwrite(str(out / f'{index:03d}-v{camera_index}-s{int(seams)}.png'),
                            cv2.cvtColor(display, cv2.COLOR_RGB2BGR))
        selected = {str(seams): min((v for v in per_view if v['seams'] == seams),
                                   key=lambda v: (v['normalized_cost'], v['camera_index']))
                    for seams in (False, True)}
        records.append(dict(file=row['file'], sha256=digest(source),
                            original_score=row['evidence'].get('combined_score', row['evidence']['score']),
                            original_rank=index, part_count=len(items), display=display_record,
                            selected=selected, views=per_view))
        print(f"{index+1}/{len(rows)} {row['file']} no-seam={selected['False']['normalized_cost']:.6f} "
              f"seam={selected['True']['normalized_cost']:.6f}", flush=True)
    winners = {}
    for seams in (False, True):
        key = str(seams)
        ordered = sorted(records, key=lambda r: (r['selected'][key]['normalized_cost'], r['sha256']))
        value = ordered[0]['selected'][key]['normalized_cost']
        winners[key] = dict(file=ordered[0]['file'], normalized_cost=value,
                            tie_count=sum(abs(r['selected'][key]['normalized_cost'] - value) < 1e-12
                                          for r in ordered), ranking=[r['file'] for r in ordered])
    manifest.update(records=records, winners=winners, seconds=time.perf_counter()-started,
                    source_hashes_end=source_hashes())
    dependencies = {}
    for geometry in scorer.geometry.values():
        dependencies.update(geometry.get('files', {}))
    manifest['geometry_dependencies'] = dependencies
    if any(digest(path) != expected for path, expected in dependencies.items()):
        raise RuntimeError('Universal CAD changed during experiment')
    if digest(directory / 'results.json') != manifest['bank_sha256'] or any(
            digest(directory / row['file']) != row['sha256'] for row in records):
        raise RuntimeError('Candidate bank changed during experiment')
    manifest['sources_unchanged'] = manifest['source_hashes_start'] == manifest['source_hashes_end']
    if not manifest['sources_unchanged']:
        raise RuntimeError('Source changed during experiment; refusing to publish result')
    (out / 'report.json').write_text(json.dumps(manifest, indent=2))
    (out / 'report.json.sha256').write_text(digest(out / 'report.json') + '\n')
    shutil.copyfile(directory / winners['True']['file'], out / 'model.ldr')
    print(json.dumps(winners, indent=2), flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bank', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--spacing', type=int, default=3)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--curves', action='store_true')
    parser.add_argument('--refine-translation', action='store_true')
    parser.add_argument('--arrows', action='store_true')
    args = parser.parse_args()
    run(args.bank, args.out, args.spacing, args.limit, args.curves, args.refine_translation, args.arrows)
