"""Post-hoc evaluation for a sealed raw-registry v2 pose-search run.

Runtime artifacts and every recorded input hash are checked before the
reference model is opened.  Pose recall uses one structural alignment recovered
from the pre-existing base and never realigns individual registry poses.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_bipartite_matching

from placement_diagnose_alias_poses import (canonicalize, verified_local_symmetries,
                                             yaw_equivalent_score)
from placement_part_library import PartLibrary
from pose_score import read_parts, score


HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _path(value):
    path = Path(value)
    return path if path.is_absolute() else Path.cwd() / path


def validate_runtime(run):
    """Validate the complete runtime seal without accepting a truth path."""
    run = Path(run)
    report_path = run / 'report.json'
    report = json.loads(report_path.read_text())
    if report.get('truth_used') is not False or report.get('runtime_vlm_calls') != 0:
        raise ValueError('Pose-search report lacks truth-free zero-VLM provenance')
    if (report.get('sources_unchanged') is not True
            or report.get('source_hashes_start') != report.get('source_hashes_end')):
        raise ValueError('Pose-search source seal is absent or inconsistent')
    if 'runtime_input_hashes_start' in report and (
            report.get('runtime_inputs_unchanged') is not True
            or report.get('runtime_input_hashes_start') != report.get('runtime_input_hashes_end')):
        raise ValueError('Pose-search runtime input start/end seal is inconsistent')
    if ('geometry_dependencies_unchanged' in report
            and report.get('geometry_dependencies_unchanged') is not True):
        raise ValueError('Pose-search geometry dependencies changed during runtime')
    for name, expected in report['source_hashes_end'].items():
        if Path(name).name != name:
            raise ValueError('Pose-search source snapshot name must be local')
        path = run / 'sources' / name
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f'Pose-search source snapshot differs from runtime seal: {name}')
    inputs = (
        ('source placement', _path(report['source_placement']) / 'results.json',
         report['source_results_sha256']),
        ('PDF', _path(report['pdf']), report['pdf_sha256']),
        ('base', _path(report['base_source']), report['base_sha256']),
        ('registry', _path(report['registry_source']), report['registry_sha256']),
        ('registration', _path(report['registration_source']), report['registration_sha256']))
    for label, path, expected in inputs:
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f'{label} differs from the pose-search runtime seal')
    for value, expected in (report.get('geometry_dependencies') or {}).items():
        path = _path(value)
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f'Geometry dependency differs from runtime seal: {path}')
    registry = json.loads(inputs[3][1].read_text())
    registration = json.loads(inputs[4][1].read_text())
    for label, record in (('registry', registry), ('registration', registration)):
        if record.get('truth_used') is not False or record.get('runtime_vlm_calls') != 0:
            raise ValueError(f'{label} lacks truth-free zero-VLM provenance')
    if len(registry.get('poses') or []) != report.get('raw_pose_count'):
        raise ValueError('Runtime raw pose count differs from its registry')
    cameras = report.get('cameras') or []
    quota_keys = set((report.get('quotas') or {}).keys())
    for camera in cameras:
        camera_index = camera.get('camera_index')
        if 'max_padded_dimension' in report:
            padding = camera.get('padding') or {}
            native = padding.get('native_size'); pads = padding.get('padding')
            padded = padding.get('padded_size')
            if (not isinstance(native, list) or len(native) != 2
                    or not all(isinstance(value, int) and value > 0 for value in native)
                    or not isinstance(pads, list) or len(pads) != 4
                    or not all(isinstance(value, int) and value >= 0 for value in pads)
                    or padded != [native[0] + pads[0] + pads[2],
                                  native[1] + pads[1] + pads[3]]
                    or padding.get('max_dimension') != report['max_padded_dimension']
                    or max(padded) > report['max_padded_dimension']):
                raise ValueError('Padded-render coordinate metadata is inconsistent')
            bounds = padding.get('projected_union_bounds')
            if (not isinstance(bounds, list) or len(bounds) != 4
                    or not all(isinstance(value, (int, float))
                               and np.isfinite(value) for value in bounds)):
                raise ValueError('Padded projected union bounds are invalid')
        if camera.get('raw_pose_count') != report.get('raw_pose_count'):
            raise ValueError('Camera raw pose count differs from runtime summary')
        standalone = camera.get('standalone_candidates') or []
        if camera.get('rendered_pose_count') != len(standalone):
            raise ValueError('Rendered pose count differs from standalone records')
        seen = set()
        per_key = Counter()
        for row in standalone:
            expected = f"v{camera_index}:pose:{row['registry_index']}:{row['quota_key']}"
            if row.get('pose_id') != expected or expected in seen:
                raise ValueError('Standalone pose ID is malformed or duplicated')
            if not 0 <= int(row['registry_index']) < len(registry['poses']):
                raise ValueError('Standalone registry index is out of range')
            registry_part = str(registry['poses'][int(row['registry_index'])]['part'])
            if row['quota_key'].rsplit(':', 1)[0] != registry_part or row['quota_key'] not in quota_keys:
                raise ValueError('Standalone pose identity differs from registry/allocation')
            seen.add(expected); per_key[row['quota_key']] += 1
        cheap = camera.get('cheap_counts') or {}
        render = camera.get('render_counts') or {}
        if (set(cheap) != set(per_key) or any(int(value.get('retained', -1)) != per_key[key]
               for key, value in cheap.items())):
            raise ValueError('Cheap-retained counts differ from standalone records')
        if (set(render) != set(per_key) or any(int(value.get(
                'rendered_input', value.get('input', -1))) != per_key[key]
               or not 0 <= int(value.get('retained', -1)) <= per_key[key]
               for key, value in render.items())):
            raise ValueError('Rendered-retained counts are inconsistent')
        retained = _rendered_rows(camera)
        solver_record = camera.get('joint_solver') or camera.get('solver') or {}
        solver_ids = set(solver_record.get('selected_pose_ids') or [])
        if not solver_ids <= {row['pose_id'] for row in retained}:
            raise ValueError('Solver selected a pose outside the rendered-retained tier')
        if camera.get('joint_solver') is not None:
            base_features = camera.get('base_features') or {}
            visible = base_features.get('visible_feature_ids')
            suppressed = base_features.get('suppressed_feature_ids')
            if (not isinstance(visible, list) or len(set(visible)) != len(visible)
                    or not isinstance(suppressed, list) or len(set(suppressed)) != len(suppressed)
                    or set(visible) & set(suppressed)
                    or len(visible) != base_features.get('visible_count')
                    or len(suppressed) != base_features.get('suppressed_count')
                    or len(visible) + len(suppressed) != base_features.get('total')):
                raise ValueError('Base feature visibility census is inconsistent')
            feature_matches = base_features.get('feature_match_count')
            if (not isinstance(feature_matches, int)
                    or not 0 <= feature_matches <= len(visible)):
                raise ValueError('Base feature match count is inconsistent')
            base_ids = set(visible) | set(suppressed)
            for row in standalone:
                hidden = row.get('suppressed_base_feature_ids')
                if (not isinstance(hidden, list) or len(set(hidden)) != len(hidden)
                        or not set(hidden) <= base_ids
                        or not isinstance(row.get('full_prediction_tokens'), int)
                        or row['full_prediction_tokens'] < row['tokens']):
                    raise ValueError('Per-pose base suppression IDs are invalid')
            joint_visible = solver_record.get('visible_base_feature_ids')
            joint_suppressed = solver_record.get('suppressed_base_feature_ids')
            if (not isinstance(joint_visible, list) or len(set(joint_visible)) != len(joint_visible)
                    or not isinstance(joint_suppressed, list)
                    or len(set(joint_suppressed)) != len(joint_suppressed)
                    or set(joint_visible) & set(joint_suppressed)
                    or set(joint_visible) | set(joint_suppressed) != base_ids):
                raise ValueError('Joint solver base visibility partition is inconsistent')
            base_matches = solver_record.get('base_matches')
            if (not isinstance(base_matches, list)
                    or len(base_matches) != solver_record.get('base_match_count')):
                raise ValueError('Joint solver base match census is inconsistent')
            if (not isinstance(solver_record.get('real_match_count'), int)
                    or solver_record['real_match_count'] < 0):
                raise ValueError('Joint solver real match count is invalid')
            physical_ids = {row['pose_id'] for row in standalone}
            if any(match.get('pose_id') in physical_ids for match in base_matches):
                raise ValueError('Physical pose ID appears in base-only matches')
            auxiliary = set(solver_record.get('auxiliary_pose_ids') or [])
            if auxiliary & solver_ids:
                raise ValueError('Auxiliary solver IDs leaked into physical selected poses')
    selected = report.get('selected')
    if selected is not None:
        model = run / 'model.ldr'
        if not model.is_file() or digest(model) != selected.get('model_sha256'):
            raise ValueError('Selected model differs from the pose-search runtime seal')
        chosen = [camera for camera in cameras
                  if camera.get('camera_index') == selected.get('camera_index')]
        if len(chosen) != 1 or set(selected.get('selected_pose_ids') or []) != set(
                (chosen[0].get('joint_solver') or chosen[0].get('solver'))['selected_pose_ids']):
            raise ValueError('Selected summary differs from its camera solver record')
        auxiliary = set((chosen[0].get('joint_solver') or {}).get('auxiliary_pose_ids') or [])
        if auxiliary:
            model_text = model.read_text(errors='replace')
            if any(item in model_text for item in auxiliary):
                raise ValueError('Auxiliary solver ID leaked into exported model')
        if (not chosen[0].get('actual')
                or abs(float(selected['normalized_cost'])
                       - float(chosen[0]['actual']['normalized_cost'])) > 1e-12):
            raise ValueError('Selected cost differs from true-visibility camera score')
    return report, registry, inputs[2][1], report_path


def _rendered_rows(camera):
    retained_ids = camera.get('rendered_retained_pose_ids')
    if not isinstance(retained_ids, list) or len(set(retained_ids)) != len(retained_ids):
        raise ValueError('Camera lacks explicit unique rendered-retained pose IDs')
    lookup = {row['pose_id']: row for row in camera.get('standalone_candidates') or []}
    if not set(retained_ids) <= set(lookup):
        raise ValueError('Rendered-retained pose ID is absent from standalone records')
    pruned = camera.get('support_pruned_pose_ids')
    if not isinstance(pruned, list) or len(set(pruned)) != len(pruned):
        raise ValueError('Camera lacks explicit unique support-pruned pose IDs')
    if not set(pruned) <= set(lookup) or set(pruned) & set(retained_ids):
        raise ValueError('Support-pruned IDs are absent or overlap retained IDs')
    primary = camera.get('primary_render_retained_pose_ids')
    if primary is not None:
        if not isinstance(primary, list) or len(set(primary)) != len(primary):
            raise ValueError('Primary rendered-retained pose IDs are malformed')
        closure = camera.get('support_closure') or {}
        added = closure.get('added_pose_ids')
        if not isinstance(added, list) or len(set(added)) != len(added):
            raise ValueError('Support-closure added pose IDs are malformed')
        if not (set(primary) | set(added) | set(pruned)) <= set(lookup):
            raise ValueError('Primary/support pose IDs are absent from standalone records')
        if set(retained_ids) != (set(primary) | set(added)) - set(pruned):
            raise ValueError('Final rendered-retained IDs differ from primary/support closure')
        primary_counts = Counter(lookup[pose_id]['quota_key'] for pose_id in primary)
        for key, value in (camera.get('render_counts') or {}).items():
            rendered_input = int(value.get('rendered_input', -1))
            ineligible, eligible = (int(value.get('visually_ineligible', -1)),
                                    int(value.get('eligible', -1)))
            retained = int(value.get('retained', -1))
            if (rendered_input != sum(1 for row in lookup.values()
                                     if row['quota_key'] == key)
                    or ineligible + eligible != rendered_input
                    or not 0 <= retained <= eligible
                    or primary_counts[key] != retained):
                raise ValueError('V4 visual render census differs from explicit primary IDs')
    else:
        capped_count = sum(int(value['retained'])
                           for value in (camera.get('render_counts') or {}).values())
        if len(retained_ids) + len(pruned) != capped_count:
            raise ValueError('Explicit rendered-retained/support-pruned IDs differ from cap counts')
    return [lookup[pose_id] for pose_id in retained_ids]


def _legacy_reconstructed_rendered_rows(camera):
    """Historical diagnostic only; current runtime reports explicit retained IDs."""
    groups = defaultdict(list)
    for row in camera.get('standalone_candidates') or []:
        groups[row['quota_key']].append(row)
    retained = []
    for key, rows in groups.items():
        count = int(camera['render_counts'][key]['retained'])
        retained.extend(sorted(rows, key=lambda row: (row['normalized_cost'], row['pose_id']))[:count])
    return retained


def _tier_pose_keys(report, registry):
    raw_colors = defaultdict(set)
    for part, color in report['allocated_pieces']:
        raw_colors[str(part)].add(int(color))
    raw = {(index, f'{pose["part"]}:{color}')
           for index, pose in enumerate(registry['poses'])
           for color in raw_colors.get(str(pose['part']), ())}
    cheap, rendered = set(), set()
    for camera in report.get('cameras') or []:
        cheap.update((int(row['registry_index']), row['quota_key'])
                     for row in camera.get('standalone_candidates') or [])
        rendered.update((int(row['registry_index']), row['quota_key'])
                        for row in _rendered_rows(camera))
    return {'raw_registry': raw, 'cheap_retained': cheap, 'rendered_retained': rendered}


def _maximum_base_alignments(base, truth):
    """Enumerate global transforms attaining the structural base maximum."""
    groups = defaultdict(list)
    for index, item in enumerate(truth):
        groups[item[:2]].append(index)
    transforms = {}
    for part, color, position, frame in base:
        for index in groups[(part, color)]:
            _, _, target_position, target_frame = truth[index]
            for local in verified_local_symmetries(part):
                rotation = target_frame @ local @ frame.T
                if np.linalg.det(rotation) < .999:
                    continue
                translation = target_position - rotation @ position
                key = tuple(np.round(np.r_[rotation.ravel(), translation], 4))
                transforms.setdefault(key, (rotation, translation))
    scored = []
    for key, (rotation, translation) in transforms.items():
        edges = []
        for i, (part, color, position, frame) in enumerate(base):
            for j in groups[(part, color)]:
                _, _, target_position, target_frame = truth[j]
                if np.max(np.abs(rotation @ position + translation - target_position)) > 1.000001:
                    continue
                if any(np.allclose(rotation @ frame, target_frame @ local,
                                   atol=1e-4, rtol=0)
                       for local in verified_local_symmetries(part)):
                    edges.append((i, j))
        matched = 0
        if edges:
            a, b = zip(*edges)
            graph = csr_matrix((np.ones(len(edges)), (a, b)),
                               shape=(len(base), len(truth)))
            matched = int(np.sum(maximum_bipartite_matching(
                graph, perm_type='column') >= 0))
        scored.append((matched, key, rotation, translation))
    if not scored:
        raise ValueError('Base has no structural alignment to the reference')
    maximum = max(row[0] for row in scored)
    return [(rotation, translation) for matched, _, rotation, translation in sorted(scored,
            key=lambda row: row[1]) if matched == maximum]


def _pose_recall(stage, registry, allocation, truth, base, rotation, translation,
                 library, tolerance=1.0):
    aliases = {}
    canonical_truth, found = canonicalize(truth, library); aliases.update(found)
    canonical_base, found = canonicalize(base, library); aliases.update(found)
    canonical_alloc = []
    for part, color in allocation:
        row, found = canonicalize([(str(part), int(color), np.zeros(3), np.eye(3))], library)
        aliases.update(found); canonical_alloc.append(row[0][:2])
    quotas = Counter(canonical_alloc)
    placed_truth = set()
    for part, color, position, _ in canonical_base:
        mapped = rotation @ position + translation
        hits = [(np.max(np.abs(mapped - target_position)), index)
                for index, (target_part, target_color, target_position, _) in enumerate(canonical_truth)
                if index not in placed_truth
                and (target_part, target_color) == (part, color)]
        if hits and min(hits)[0] <= tolerance:
            placed_truth.add(min(hits)[1])
    pools = defaultdict(list)
    for index, (part, color, position, frame) in enumerate(canonical_truth):
        if index not in placed_truth and (part, color) in quotas:
            pools[(part, color)].append((index, position, frame))
    pose_nodes = defaultdict(list)
    for registry_index, key in stage:
        part, color = key.rsplit(':', 1)
        pose = registry['poses'][registry_index]
        canonical, found = canonicalize([(str(pose['part']), int(color),
                                           np.asarray(pose['T'], float)[:3, 3],
                                           np.asarray(pose['T'], float)[:3, :3])], library)
        aliases.update(found)
        cpart, ccolor, position, frame = canonical[0]
        pose_nodes[(cpart, ccolor)].append((registry_index, position, frame))
    per_key = {}; total = 0; denominator = sum(quotas.values())
    for key, quota in sorted(quotas.items()):
        poses, targets = pose_nodes[key], pools[key]
        edges = []
        for i, (_, position, frame) in enumerate(poses):
            mapped_position = rotation @ position + translation
            mapped_frame = rotation @ frame
            for j, (_, target_position, target_frame) in enumerate(targets):
                if np.max(np.abs(mapped_position - target_position)) > tolerance:
                    continue
                if any(np.allclose(mapped_frame, target_frame @ symmetry,
                                   atol=1e-4, rtol=0)
                       for symmetry in verified_local_symmetries(key[0])):
                    edges.append((i, j))
        matched = 0
        if edges:
            a, b = zip(*edges)
            graph = csr_matrix((np.ones(len(edges)), (a, b)), shape=(len(poses), len(targets)))
            matched = min(int(np.sum(maximum_bipartite_matching(
                graph, perm_type='column') >= 0)), int(quota))
        total += matched
        label = f'{key[0]}:{key[1]}'
        per_key[label] = dict(quota=int(quota), matched=matched,
                              candidate_pose_instances=len(poses),
                              reference_pool=len(targets))
    return dict(matched=total, target_quota=denominator,
                recall=(total / denominator if denominator else 1.0),
                candidate_pose_instances=len(stage), per_key=per_key, aliases=aliases)


def _correct_pose_diagnostics(report, registry, truth, base, alignments, library,
                              tolerance=1.0):
    """Describe reference-compatible runtime poses without affecting selection."""
    canonical_truth, _ = canonicalize(truth, library)
    canonical_base, _ = canonicalize(base, library)
    cameras = []
    for camera in report.get('cameras') or []:
        rows = camera.get('standalone_candidates') or []
        by_key = defaultdict(list)
        for row in rows:
            by_key[row['quota_key']].append(row)
        all_ranks, eligible_ranks, all_rank_ranges, eligible_rank_ranges = {}, {}, {}, {}
        for key, members in by_key.items():
            ranked = sorted(members, key=lambda row: (row['normalized_cost'], row['pose_id']))
            all_ranks.update({row['pose_id']: index + 1 for index, row in enumerate(ranked)})
            for row in ranked:
                cost = float(row['normalized_cost'])
                all_rank_ranges[row['pose_id']] = [
                    1 + sum(float(other['normalized_cost']) < cost - 1e-12 for other in ranked),
                    sum(float(other['normalized_cost']) <= cost + 1e-12 for other in ranked)]
            eligible = [row for row in ranked if int(row.get('exclusive_match_count', 0)) > 0]
            eligible_ranks.update({row['pose_id']: index + 1 for index, row in enumerate(eligible)})
            for row in eligible:
                cost = float(row['normalized_cost'])
                eligible_rank_ranges[row['pose_id']] = [
                    1 + sum(float(other['normalized_cost']) < cost - 1e-12 for other in eligible),
                    sum(float(other['normalized_cost']) <= cost + 1e-12 for other in eligible)]
        cameras.append((camera, rows, all_ranks, eligible_ranks,
                        all_rank_ranges, eligible_rank_ranges))
    quotas = Counter()
    for part, color in report['allocated_pieces']:
        row, _ = canonicalize([(str(part), int(color), np.zeros(3), np.eye(3))], library)
        quotas[row[0][:2]] += 1
    result = []
    for alignment_index, (rotation, translation) in enumerate(alignments):
        placed = set()
        for part, color, position, _ in canonical_base:
            mapped = rotation @ position + translation
            hits = [(np.max(np.abs(mapped - target_position)), index)
                    for index, (target_part, target_color, target_position, _) in enumerate(canonical_truth)
                    if index not in placed and (target_part, target_color) == (part, color)]
            if hits and min(hits)[0] <= tolerance:
                placed.add(min(hits)[1])
        targets = defaultdict(list)
        for index, (part, color, position, frame) in enumerate(canonical_truth):
            if index not in placed and (part, color) in quotas:
                targets[(part, color)].append((index, position, frame))
        records = []
        for (camera, rows, all_ranks, eligible_ranks,
             all_rank_ranges, eligible_rank_ranges) in cameras:
            primary = set(camera.get('primary_render_retained_pose_ids') or [])
            added = set((camera.get('support_closure') or {}).get('added_pose_ids') or [])
            pruned = set(camera.get('support_pruned_pose_ids') or [])
            final = set(camera.get('rendered_retained_pose_ids') or [])
            for row in rows:
                pose = registry['poses'][int(row['registry_index'])]
                color = int(row['quota_key'].rsplit(':', 1)[1])
                canonical, _ = canonicalize([(str(pose['part']), color,
                                               np.asarray(pose['T'], float)[:3, 3],
                                               np.asarray(pose['T'], float)[:3, :3])], library)
                part, color, position, frame = canonical[0]
                mapped_position, mapped_frame = rotation @ position + translation, rotation @ frame
                matched_targets = []
                for truth_index, target_position, target_frame in targets[(part, color)]:
                    if np.max(np.abs(mapped_position - target_position)) > tolerance:
                        continue
                    if any(np.allclose(mapped_frame, target_frame @ symmetry,
                                       atol=1e-4, rtol=0)
                           for symmetry in verified_local_symmetries(part)):
                        matched_targets.append(int(truth_index))
                if matched_targets:
                    records.append(dict(pose_id=row['pose_id'], quota_key=row['quota_key'],
                                        camera_index=int(camera['camera_index']),
                                        registry_index=int(row['registry_index']),
                                        truth_indices=matched_targets, tokens=int(row['tokens']),
                                        exclusive_match_count=int(row.get('exclusive_match_count', 0)),
                                        normalized_cost=float(row['normalized_cost']),
                                        all_rendered_rank_for_key=all_ranks[row['pose_id']],
                                        all_rendered_rank_range_for_key=all_rank_ranges[row['pose_id']],
                                        visually_eligible_rank_for_key=eligible_ranks.get(row['pose_id']),
                                        visually_eligible_rank_range_for_key=eligible_rank_ranges.get(row['pose_id']),
                                        primary_retained=row['pose_id'] in primary,
                                        support_added=row['pose_id'] in added,
                                        support_pruned=row['pose_id'] in pruned,
                                        final_retained=row['pose_id'] in final))
        records.sort(key=lambda row: (row['quota_key'], row['normalized_cost'], row['pose_id']))
        result.append(dict(alignment_index=alignment_index,
                           alignment=dict(rotation=rotation.tolist(), translation=translation.tolist()),
                           correct_runtime_pose_count=len(records), candidates=records))
    return result


def evaluate(run, truth, out):
    # This call deliberately precedes both digest(truth) and read_parts(truth).
    report, registry, base_path, report_path = validate_runtime(run)
    truth, out = Path(truth), Path(out)
    truth_rows = read_parts(truth)
    base_rows = read_parts(base_path)
    selected_rows = read_parts(Path(run) / 'model.ldr') if report.get('selected') else []
    library = PartLibrary()
    canonical_truth, aliases = canonicalize(truth_rows, library)
    canonical_base, found = canonicalize(base_rows, library); aliases.update(found)
    base_structural = yaw_equivalent_score(canonical_base, canonical_truth,
                                           verified_local_symmetries)
    if not base_structural.get('alignment'):
        raise ValueError('Base has no structural alignment to the reference')
    alignments = _maximum_base_alignments(canonical_base, canonical_truth)
    tiers = {}
    for name, stage in _tier_pose_keys(report, registry).items():
        candidates = []
        for alignment_index, (rotation, translation) in enumerate(alignments):
            tier = _pose_recall(stage, registry, report['allocated_pieces'], truth_rows,
                                base_rows, rotation, translation, library)
            tier.update(alignment_index=alignment_index,
                        alignment=dict(rotation=rotation.tolist(),
                                       translation=translation.tolist()))
            candidates.append(tier)
        tier = max(candidates, key=lambda row: (row['matched'], -row['alignment_index']))
        aliases.update(tier.pop('aliases')); tiers[name] = tier
    selected = None
    if selected_rows:
        canonical_selected, found = canonicalize(selected_rows, library); aliases.update(found)
        selected = dict(strict=score(selected_rows, truth_rows),
                        structural=yaw_equivalent_score(canonical_selected, canonical_truth,
                                                        verified_local_symmetries))
    correct_pose_diagnostics = _correct_pose_diagnostics(
        report, registry, truth_rows, base_rows, alignments, library)
    solver_census = []
    for camera in report.get('cameras') or []:
        solver = camera.get('joint_solver') or camera.get('solver')
        solver_census.append(dict(camera_index=camera['camera_index'],
                                  status=(solver or {}).get('status'),
                                  optimal=(solver or {}).get('optimal'),
                                  mip_gap=(solver or {}).get('mip_gap'),
                                  total_cost=(solver or {}).get('total_cost'),
                                  real_match_count=(solver or {}).get(
                                      'real_match_count', (solver or {}).get('match_count')),
                                  base_match_count=(solver or {}).get('base_match_count'),
                                  selected_pose_ids=(solver or {}).get('selected_pose_ids', []),
                                  actual_normalized_cost=(camera.get('actual') or {}).get(
                                      'normalized_cost')))
    result = dict(protocol='placement-v2-pose-search-sealed-posthoc-evaluation-v1',
                  scope='Independent post-hoc evaluation only; no reference data enters runtime.',
                  runtime_report=str(report_path), runtime_report_sha256=digest(report_path),
                  truth_path=str(truth), truth_sha256=digest(truth),
                  base_alignment=base_structural, selected_model=selected,
                  maximum_base_alignment_count=len(alignments),
                  pose_recall_alignment_policy='Each tier reports its best whole-tier result across equally maximum structural base alignments. One shared transform applies to every pose in that tier; individual poses are never realigned. Recall remains conditional on these base alignments.',
                  pose_recall=tiers, aliases=aliases,
                  correct_pose_diagnostics=correct_pose_diagnostics,
                  solver_census=solver_census,
                  live_source_divergence=[name for name, expected in report['source_hashes_end'].items()
                                          if not (HERE / name).is_file()
                                          or digest(HERE / name) != expected],
                  runtime_input_stability=(
                      dict(verified=True, limitation=None)
                      if (report.get('runtime_inputs_unchanged') is True
                          and report.get('geometry_dependencies_unchanged') is True
                          and report.get('runtime_input_hashes_start')
                          == report.get('runtime_input_hashes_end'))
                      else dict(verified=False,
                                limitation='Runtime recorded end-state input hashes only; evaluation verifies those current bytes but cannot exclude mid-run mutation.')),
                  truth_parts=len(truth_rows), allocated_parts=len(report['allocated_pieces']))
    if out.exists():
        raise ValueError('Use a fresh evaluation output path')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + '\n')
    seal = digest(out); Path(str(out) + '.sha256').write_text(seal + '  ' + out.name + '\n')
    print(json.dumps(dict(out=str(out), sha256=seal, selected=selected,
                          pose_recall=tiers), indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    evaluate(args.run, args.truth, args.out)
