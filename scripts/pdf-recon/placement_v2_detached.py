"""PDF/CAD-only identity ranking for detached instruction components.

The matcher reads a completed reference-free candidate bank, recovers its
original native PDF scene, and compares each meaningful arrow-separated
component with every allocated part identity at the bank's physical camera
scales.  Candidate silhouettes are translated only to the component centre.
Ambiguous scores are refused.  No reference model, learned model, or VLM is an
input, and this module does not modify the old placement pipeline.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import shutil

import cv2
import numpy as np

from placement_arrow_mask import conservative_components
from placement_beam import rotations
from placement_feature_edges import FeatureEdgeScorer
from placement_page_mask import part_palette
from placement_run_scene import run_scene
from placement_v2_correspondence import score_correspondence
from placement_v2_observations import instance_owner, observed_tokens, predicted_tokens
from placement_v2_proposals import FeatureMatch, lift_translation


MIN_BODY_FRACTION = .01
DEFAULT_MIN_MARGIN = .02


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def allocated_from_bank(directory, metadata):
    """Load the opening allocation whose provenance owns this placement bank."""
    directory = Path(directory)
    construction_path = directory.parent / 'construction.json'
    if not construction_path.is_file():
        raise ValueError('Candidate bank has no sibling construction.json allocation record')
    construction = json.loads(construction_path.read_text())
    if construction.get('truth_used') is not False or construction.get('runtime_vlm_calls') != 0:
        raise ValueError('Construction allocation lacks truth-free zero-VLM provenance')
    if (construction.get('pdf_sha256') != metadata.get('pdf_sha256')
            or construction.get('pdf') != metadata.get('pdf')
            or construction.get('page') != metadata.get('page')):
        raise ValueError('Construction allocation does not belong to this candidate bank')
    pieces = [(str(part), int(color)) for part, color in construction.get('allocated_pieces', [])]
    if not pieces:
        raise ValueError('Construction allocation is empty')
    return pieces, construction_path


def distinct_matrices(results):
    matrices = []
    for row in results:
        matrix = np.asarray(row['projection'], float)
        if matrix.shape != (2, 3) or not np.isfinite(matrix).all():
            raise ValueError('Invalid bank camera matrix')
        if not any(np.allclose(matrix, old, atol=1e-8, rtol=0) for old in matrices):
            matrices.append(matrix)
    if not matrices:
        raise ValueError('Candidate bank has no camera matrices')
    return matrices


def rank_component(rows, min_margin=DEFAULT_MIN_MARGIN):
    """Collapse pose rows by identity and make a conservative margin decision."""
    if not np.isfinite(min_margin) or min_margin < 0:
        raise ValueError('min_margin must be finite and nonnegative')
    best_by_key = {}
    for row in rows:
        cost = float(row['normalized_cost'])
        if not np.isfinite(cost):
            continue
        key = str(row['key'])
        old = best_by_key.get(key)
        tie = (cost, int(row['camera_index']), int(row['rotation_index']))
        if old is None or tie < (old['normalized_cost'], old['camera_index'], old['rotation_index']):
            best_by_key[key] = dict(row)
    ranked = sorted(best_by_key.values(),
                    key=lambda row: (row['normalized_cost'], row['key'],
                                     row['camera_index'], row['rotation_index']))
    if len(ranked) < 2:
        return dict(status='refused', reason='fewer_than_two_scored_identities',
                    selected=None, margin=None, ranking=ranked)
    margin = float(ranked[1]['normalized_cost'] - ranked[0]['normalized_cost'])
    if margin < min_margin:
        reason = 'exact_identity_tie' if abs(margin) < 1e-12 else 'identity_margin_below_threshold'
        return dict(status='refused', reason=reason, selected=None, margin=margin,
                    min_margin=float(min_margin), ranking=ranked)
    return dict(status='identified', reason='identity_margin_passed',
                selected=ranked[0]['key'], margin=margin,
                min_margin=float(min_margin), ranking=ranked)


def translation_domain(part_center, component_center, projection, rotation, match_id):
    """Lift the centre correspondence while retaining unbounded camera depth."""
    match = FeatureMatch(match_id=match_id,
                         part_point=tuple(np.asarray(part_center, float)),
                         image_point=tuple(np.asarray(component_center, float)),
                         uncertainty=1.5,
                         observation_id=match_id + ':component-centre',
                         predicted_feature_id=match_id + ':cad-centre')
    lifted = lift_translation([match], projection, rotation, image_offset=(0., 0.))
    return dict(domain=asdict(lifted.domain), final_pose_claim=False,
                interpretation='Minimum-norm translation plus an unbounded camera-nullspace depth; '
                               'no connector or second-view witness supplied')


def _score_component(scene, component, keys, matrices, spacing, min_margin):
    component_scene = dict(scene, mask=np.asarray(component['mask'], bool))
    observations = observed_tokens(component_scene['rgb'], component_scene['mask'], spacing=spacing)
    rows = []
    # A separate scorer prevents one component's target geometry/cache state
    # from becoming another component's registration.
    scorer = FeatureEdgeScorer(component_scene, span_tolerance=float('inf'), plane_depth=True)
    cube_rotations = rotations()
    centers = {}
    for part, color in keys:
        key = f'{part}:{color}'
        for camera_index, matrix in enumerate(matrices):
            for rotation_index, transform in enumerate(cube_rotations):
                evidence = scorer.score([(part, color, transform)], matrix)
                layer = scorer.last_layer
                counts = [len(scorer.geometry[(part, str(color))]['triangles'])]
                vertices = scorer.geometry[(part, str(color))]['triangles'].reshape(-1, 3)
                centers[key] = (vertices.min(0) + vertices.max(0)) / 2
                owner = instance_owner(layer['owner'][0], counts)
                predicted, _ = predicted_tokens(scorer.last_outline, layer['mask'][0], owner,
                                                 spacing=spacing, include_seams=False)
                scored = score_correspondence(predicted, observations)
                rows.append(dict(
                    key=key, camera_index=camera_index, rotation_index=rotation_index,
                    normalized_cost=float(scored.normalized_cost), total_cost=float(scored.total_cost),
                    match_count=len(scored.matches), predicted_tokens=len(predicted),
                    observed_tokens=len(observations), origin=evidence['image_origin'],
                    projection=np.asarray(matrix).tolist(),
                    rotation=np.asarray(transform)[:3, :3].tolist()))
    decision = rank_component(rows, min_margin)
    yy, xx = np.nonzero(component_scene['mask'])
    centre = [float(xx.mean()), float(yy.mean())]
    for candidate in decision['ranking']:
        candidate['translation_proposal'] = translation_domain(
            centers[candidate['key']], centre, candidate['projection'], candidate['rotation'],
            f"component:{component['bbox']}:{candidate['key']}")
    return dict(area=int(component['area']), bbox=list(component['bbox']),
                component_center=centre, observed_tokens=len(observations),
                decision=decision, pose_rows=rows)


def run(directory, out, spacing=3, min_margin=DEFAULT_MIN_MARGIN):
    directory, out = Path(directory), Path(out)
    if out.exists():
        raise ValueError('Use a fresh output directory; detached reports are immutable')
    metadata_path = directory / 'results.json'
    metadata = json.loads(metadata_path.read_text())
    if metadata.get('truth_used') is not False or metadata.get('runtime_vlm_calls') != 0:
        raise ValueError('Candidate bank lacks truth-free zero-VLM provenance')
    if digest(metadata['pdf']) != metadata.get('pdf_sha256'):
        raise ValueError('PDF differs from the candidate bank source')
    pieces, construction_path = allocated_from_bank(directory, metadata)
    keys = list(dict.fromkeys(pieces))
    matrices = distinct_matrices(metadata.get('results') or [])
    scene, _ = run_scene(metadata, mask_source='whole_scene')
    palette = part_palette(pieces)
    graph = conservative_components(scene, protected_colors=palette['rgb'])
    components = graph['components']
    out.mkdir(parents=True)
    source_names = ['placement_v2_detached.py', 'placement_v2_observations.py',
                    'placement_v2_correspondence.py', 'placement_feature_edges.py']
    source_names.append('placement_v2_proposals.py')
    source_dir = Path(__file__).resolve().parent
    source_hashes = {name: digest(source_dir / name) for name in source_names}
    (out / 'sources').mkdir()
    for name in source_names:
        shutil.copyfile(source_dir / name, out / 'sources' / name)
    meaningful = []
    if components:
        threshold = MIN_BODY_FRACTION * components[0]['area']
        meaningful = [component for component in components[1:] if component['area'] >= threshold]
    records = []
    if graph['arrows']:
        for index, component in enumerate(meaningful):
            records.append(_score_component(scene, component, keys, matrices,
                                            int(spacing), float(min_margin)))
            cv2.imwrite(str(out / f'component-{index:02d}.png'),
                        np.asarray(component['mask'], np.uint8) * 255)
    if not graph['arrows']:
        status, reason = 'refused', 'no_accepted_arrow'
    elif not meaningful:
        status, reason = 'refused', 'no_meaningful_detached_component'
    elif any(row['decision']['status'] == 'refused' for row in records):
        status, reason = 'refused', 'one_or_more_components_ambiguous'
    else:
        status, reason = 'identified', 'all_detached_components_identified'
    report = dict(
        protocol='pdf-cad-detached-component-identity-v1', status=status, reason=reason,
        bank=str(directory), bank_sha256=digest(metadata_path),
        construction=str(construction_path), construction_sha256=digest(construction_path),
        pdf=metadata['pdf'], pdf_sha256=metadata['pdf_sha256'], page=metadata['page'],
        xref=metadata['xref'], allocated_pieces=[list(piece) for piece in pieces],
        candidate_keys=[f'{part}:{color}' for part, color in keys],
        camera_count=len(matrices), spacing=int(spacing), min_margin=float(min_margin),
        component_count=len(components), meaningful_detached_count=len(meaningful),
        arrow_count=len(graph['arrows']), components=records,
        source_hashes=source_hashes, truth_used=False, runtime_vlm_calls=0,
        certified=False,
        limitations='Cube rotations and inherited PDF camera proposals only; single-view shape '
                    'ambiguity is refused; identity evidence does not establish attachment pose.')
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(status=status, reason=reason,
                          components=[row['decision'] for row in records]), indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bank', type=Path, required=True,
                        help='Opening construction placement directory containing results.json')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--spacing', type=int, default=3)
    parser.add_argument('--min-margin', type=float, default=DEFAULT_MIN_MARGIN)
    args = parser.parse_args()
    run(args.bank, args.out, args.spacing, args.min_margin)
