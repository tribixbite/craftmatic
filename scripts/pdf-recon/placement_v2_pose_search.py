"""Bounded raw-registry pose search with exclusive v2 ownership assignment.

This diagnostic bypasses the legacy *retained complete-assembly* bank, but it
still consumes that generator's finite raw pose registry, support graph, and
camera hypotheses.  It is therefore not an unrestricted v2 proposal generator
and makes no candidate-recall or global-optimality claim.

Per camera and quota key, raw poses are thinned drawing-first by projected CAD
bounds and distance to drawing edges.  A bounded subset is then rendered as
``base + one pose`` on a padded native canvas.  Candidate-owned tokens and
conditionally visible base tokens jointly compete for every drawing token in
the sparse MILP; exact candidate owner buffers determine which base features a
pose can suppress.  The chosen complete assembly is rendered once more with
true visibility and reported with edge and curve costs.  Single-pose visibility
inside the MILP remains an explicit surrogate for that final assembly score.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, replace
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
import time
import itertools

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _cube_rotations():
    rotations = []
    for permutation in itertools.permutations(range(3)):
        for signs in itertools.product((-1.0, 1.0), repeat=3):
            matrix = np.zeros((3, 3), float)
            for row, column in enumerate(permutation):
                matrix[row, column] = signs[row]
            if np.linalg.det(matrix) > 0.5:
                rotations.append(matrix)
    return tuple(sorted(rotations, key=lambda matrix: tuple(matrix.flat)))


CUBE_ROTATIONS = _cube_rotations()


def rotation_family(rotation):
    """Nearest of 24 proper signed-axis rotations, for grouping only."""
    value = np.asarray(rotation, float)
    if value.shape != (3, 3) or not np.isfinite(value).all():
        raise ValueError("rotation must be finite 3x3")
    distances = [float(np.linalg.norm(value - family)) for family in CUBE_ROTATIONS]
    return f"cube:{min(range(len(distances)), key=lambda index: (distances[index], index)):02d}"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _progress(out, event, **fields):
    record = dict(event=event, unix_time=time.time(), **fields)
    line = json.dumps(record, sort_keys=True, default=str)
    with (Path(out) / "progress.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(line + "\n"); stream.flush()
    print(line, flush=True)


def quota_key(part, color):
    return f"{str(part)}:{int(color)}"


@dataclass(frozen=True)
class DrawingCandidate:
    pose_id: str
    quota_key: str
    registry_index: int
    part: str
    color: int
    transform: tuple
    bbox_overlap: float
    mean_edge_distance: float
    rotation_class: str = "rotation:unspecified"
    spatial_bin: tuple = (0, 0)
    projected_bounds: tuple = (0.0, 0.0, 0.0, 0.0)


def padded_camera_scene(scene, projected_bounds, spacing=3, max_dimension=4096):
    """Embed the native scene in a bounded canvas covering projected geometry."""
    step, limit = int(spacing), int(max_dimension)
    if step <= 0 or step != spacing or limit <= 0 or limit != max_dimension:
        raise ValueError("spacing and max_dimension must be positive integers")
    rgb, mask = np.asarray(scene["rgb"]), np.asarray(scene["mask"])
    if rgb.ndim != 3 or mask.shape != rgb.shape[:2]:
        raise ValueError("scene rgb/mask dimensions disagree")
    bounds = np.asarray(tuple(projected_bounds), dtype=float).reshape(-1, 4)
    if not len(bounds) or not np.isfinite(bounds).all():
        raise ValueError("projected bounds must be finite and non-empty")
    height, width = mask.shape
    low = np.minimum(bounds[:, :2].min(axis=0), (0.0, 0.0))
    high = np.maximum(bounds[:, 2:].max(axis=0), (float(width), float(height)))
    left = int(math.ceil(max(0.0, -low[0]) / step) * step)
    top = int(math.ceil(max(0.0, -low[1]) / step) * step)
    right = int(math.ceil(max(0.0, high[0] - width) / step) * step)
    bottom = int(math.ceil(max(0.0, high[1] - height) / step) * step)
    padded_width, padded_height = width + left + right, height + top + bottom
    record = dict(native_size=[width, height], padding=[left, top, right, bottom],
                  padded_size=[padded_width, padded_height], spacing=step,
                  max_dimension=limit, projected_union_bounds=[float(low[0]), float(low[1]),
                                                               float(high[0]), float(high[1])],
                  refused=max(padded_width, padded_height) > limit)
    if record["refused"]:
        return None, record
    padded = dict(scene)
    padded_rgb = np.full((padded_height, padded_width, rgb.shape[2]), 245, dtype=rgb.dtype)
    padded_mask = np.zeros((padded_height, padded_width), dtype=mask.dtype)
    padded_rgb[top:top + height, left:left + width] = rgb
    padded_mask[top:top + height, left:left + width] = mask
    padded["rgb"], padded["mask"] = padded_rgb, padded_mask
    return padded, record


def thin_drawing_candidates(candidates, per_key_budget):
    """Deterministically cap each key using only drawing-derived cheap scores."""
    budget = int(per_key_budget)
    if budget <= 0 or budget != per_key_budget:
        raise ValueError("per_key_budget must be a positive integer")
    groups = defaultdict(list)
    seen = set()
    for candidate in candidates:
        if candidate.pose_id in seen:
            raise ValueError(f"duplicate pose_id: {candidate.pose_id}")
        seen.add(candidate.pose_id)
        if (not math.isfinite(candidate.bbox_overlap)
                or not math.isfinite(candidate.mean_edge_distance)):
            raise ValueError("candidate drawing scores must be finite")
        groups[candidate.quota_key].append(candidate)
    retained, counts = [], {}
    for key in sorted(groups):
        def drawing_rank(row):
            return (-row.bbox_overlap, row.mean_edge_distance, row.registry_index, row.pose_id)
        rotations = defaultdict(lambda: defaultdict(list))
        for row in groups[key]:
            rotations[row.rotation_class][row.spatial_bin].append(row)
        rotation_queues = {}
        for rotation, bins in rotations.items():
            for rows in bins.values():
                rows.sort(key=drawing_rank)
            ordered_bins = sorted(bins, key=lambda cell: (drawing_rank(bins[cell][0]), cell))
            queue = []
            while any(bins[cell] for cell in ordered_bins):
                for cell in ordered_bins:
                    if bins[cell]:
                        queue.append(bins[cell].pop(0))
            rotation_queues[rotation] = queue
        ordered_rotations = sorted(rotation_queues,
                                   key=lambda rotation: (drawing_rank(rotation_queues[rotation][0]),
                                                         rotation))
        chosen = []
        while len(chosen) < budget and any(rotation_queues.values()):
            for rotation in ordered_rotations:
                if rotation_queues[rotation] and len(chosen) < budget:
                    chosen.append(rotation_queues[rotation].pop(0))
        retained.extend(chosen)
        counts[key] = dict(input=len(groups[key]), retained=len(chosen), budget=budget,
                           input_rotation_classes=len(rotations),
                           retained_rotation_classes=len({row.rotation_class for row in chosen}),
                           input_spatial_bins=len({row.spatial_bin for row in groups[key]}),
                           retained_spatial_bins=len({row.spatial_bin for row in chosen}))
    return tuple(retained), counts


def support_records(candidates, base_supported, support_edges):
    """Map registry-index support witnesses onto retained color-specific poses."""
    base_supported = {int(index) for index in base_supported}
    neighbors = defaultdict(set)
    for edge in support_edges:
        if len(edge) != 2:
            raise ValueError("support edge must contain two registry indices")
        a, b = map(int, edge)
        if a == b:
            continue
        neighbors[a].add(b); neighbors[b].add(a)
    by_index = defaultdict(list)
    for candidate in candidates:
        by_index[candidate.registry_index].append(candidate.pose_id)
    result = {}
    for candidate in candidates:
        supported_by = sorted(pose_id for index in neighbors[candidate.registry_index]
                              for pose_id in by_index.get(index, ()))
        result[candidate.pose_id] = dict(
            base_supported=candidate.registry_index in base_supported,
            support_pose_ids=tuple(supported_by))
    return result


def close_support_candidates(initial, available, base_supported, support_edges, extra_cap=64):
    """Add bounded, already-rendered visual witnesses along paths to the base."""
    cap = int(extra_cap)
    if cap < 0 or cap != extra_cap:
        raise ValueError("support extra cap must be a non-negative integer")
    base = {int(index) for index in base_supported}
    graph = defaultdict(set)
    for a, b in support_edges:
        a, b = int(a), int(b)
        if a != b:
            graph[a].add(b); graph[b].add(a)
    def rank(row):
        return (-row.bbox_overlap, row.mean_edge_distance, row.registry_index, row.pose_id)
    by_index = defaultdict(list)
    for row in available:
        by_index[row.registry_index].append(row)
    for rows in by_index.values():
        rows.sort(key=rank)
    chosen = {row.pose_id: row for row in initial}
    added, unreachable = [], []
    for child in sorted(initial, key=rank):
        if child.registry_index in base:
            continue
        frontier = [child.registry_index]; previous = {child.registry_index: None}; root = None
        while frontier and root is None:
            current = frontier.pop(0)
            neighbors = sorted((index for index in graph[current]
                                if index in by_index and index not in previous),
                               key=lambda index: rank(by_index[index][0]))
            for neighbor in neighbors:
                previous[neighbor] = current
                if neighbor in base:
                    root = neighbor; break
                frontier.append(neighbor)
        if root is None:
            unreachable.append(child.pose_id); continue
        path = []; current = root
        while current != child.registry_index:
            path.append(current); current = previous[current]
        needed = [by_index[index][0] for index in reversed(path)
                  if by_index[index][0].pose_id not in chosen]
        if len(added) + len(needed) > cap:
            unreachable.append(child.pose_id); continue
        for row in needed:
            chosen[row.pose_id] = row; added.append(row.pose_id)
    return tuple(chosen.values()), dict(added_pose_ids=added,
                                        unreachable_pose_ids=unreachable,
                                        extra_cap=cap, cap_hit=bool(unreachable and len(added) >= cap))


def selected_items(base, selected_pose_ids, candidates):
    """Build one assembly while enforcing distinct IDs and exact reported keys."""
    lookup = {candidate.pose_id: candidate for candidate in candidates}
    if len(lookup) != len(tuple(candidates)):
        raise ValueError("candidate pose IDs are not unique")
    if len(set(selected_pose_ids)) != len(tuple(selected_pose_ids)):
        raise ValueError("selected pose IDs are not unique")
    missing = sorted(set(selected_pose_ids) - set(lookup))
    if missing:
        raise ValueError(f"selected unknown pose IDs: {missing}")
    additions = [(lookup[pose_id].part, lookup[pose_id].color,
                  np.asarray(lookup[pose_id].transform, dtype=float))
                 for pose_id in selected_pose_ids]
    return list(base) + additions


def _validate_runtime_inputs(source):
    source = Path(source)
    meta_path = source / "results.json"
    if not meta_path.is_file():
        raise ValueError("source placement lacks results.json")
    meta_bytes = meta_path.read_bytes(); meta = json.loads(meta_bytes)
    if meta.get("truth_used") is not False or meta.get("runtime_vlm_calls") != 0:
        raise ValueError("source placement lacks truth-free zero-VLM provenance")
    required = ("pdf", "pdf_sha256", "registry_source", "registration_source", "base_source")
    if any(not meta.get(name) for name in required):
        raise ValueError("source placement lacks registry/camera/base provenance")
    pdf, registry_path = Path(meta["pdf"]), Path(meta["registry_source"])
    registration_path, base_path = Path(meta["registration_source"]), Path(meta["base_source"])
    for path in (pdf, registry_path, registration_path, base_path):
        if not path.is_file():
            raise ValueError(f"recorded runtime input is missing: {path}")
    source_model = source / "model.ldr"
    if not source_model.is_file():
        raise ValueError("source placement lacks model.ldr used to reproduce its mask")
    input_paths = dict(source_results=meta_path, source_model=source_model, pdf=pdf,
                       base=base_path, registry=registry_path, registration=registration_path)
    input_hashes = {name: digest(path) for name, path in input_paths.items()}
    if input_hashes["source_results"] != hashlib.sha256(meta_bytes).hexdigest():
        raise ValueError("source results changed while being read")
    registry_bytes = registry_path.read_bytes(); registration_bytes = registration_path.read_bytes()
    if (hashlib.sha256(registry_bytes).hexdigest() != input_hashes["registry"]
            or hashlib.sha256(registration_bytes).hexdigest() != input_hashes["registration"]):
        raise ValueError("registry or registration changed while being read")
    registry = json.loads(registry_bytes); registration = json.loads(registration_bytes)
    for label, record in (("registry", registry), ("registration", registration)):
        if record.get("truth_used") is not False or record.get("runtime_vlm_calls") != 0:
            raise ValueError(f"{label} lacks truth-free zero-VLM provenance")
    if digest(pdf) != meta["pdf_sha256"] or registry.get("pdf_sha256") != meta["pdf_sha256"]:
        raise ValueError("PDF hash mismatch")
    if (digest(base_path) != meta.get("base_sha256")
            or registry.get("base_sha256") != meta.get("base_sha256")
            or registration.get("base_sha256") != meta.get("base_sha256")):
        raise ValueError("base model hash mismatch")
    if (registry.get("page") != meta.get("page")
            or registration.get("page") != meta.get("page")
            or registration.get("xref") != meta.get("xref")):
        raise ValueError("page/scene provenance mismatch")
    if not registry.get("allocated_pieces") or not registry.get("poses"):
        raise ValueError("raw registry has no allocation or poses")
    return (meta, registry, registration, pdf, registry_path, registration_path, base_path,
            input_paths, input_hashes)


def _new_observations(observations, base_mask, target_mask, radius=4):
    unexplained = np.asarray(target_mask, bool) & ~cv2.dilate(
        np.asarray(base_mask, np.uint8), np.ones((2 * radius + 1, 2 * radius + 1), np.uint8)).astype(bool)
    band = cv2.dilate(unexplained.astype(np.uint8),
                      np.ones((2 * radius + 1, 2 * radius + 1), np.uint8)).astype(bool)
    selected = tuple(token for token in observations
                     if band[int(round(token.position[1])), int(round(token.position[0]))])
    # An empty residual is uncertainty, not evidence that every addition is free.
    return (selected or tuple(observations)), unexplained, bool(selected)


def _projected_descriptor(scorer, pose, color, matrix, origin, edge_tree, new_region,
                          camera_index, sample_limit=128):
    part, transform = str(pose["part"]), np.asarray(pose["T"], float)
    projected = scorer._project_part(part, int(color), transform, matrix)
    # _project_part caches orientation-dependent geometry.  An ndarray view
    # here would accumulate each pose translation into that shared cache and
    # corrupt every later descriptor and render using the same orientation.
    points = np.asarray(projected["xy"], float).reshape(-1, 2).copy()
    points += matrix @ transform[:3, 3] + origin
    low = np.floor(points.min(axis=0)).astype(int); high = np.ceil(points.max(axis=0)).astype(int) + 1
    if len(points) > sample_limit:
        points = points[np.linspace(0, len(points) - 1, sample_limit, dtype=int)]
    h, w = new_region.shape
    x0, y0 = max(0, low[0]), max(0, low[1]); x1, y1 = min(w, high[0]), min(h, high[1])
    bbox_area = max(1, (high[0] - low[0]) * (high[1] - low[1]))
    overlap = float(new_region[y0:y1, x0:x1].sum()) / bbox_area if x1 > x0 and y1 > y0 else 0.0
    distance = float(edge_tree.query(points, k=1)[0].mean())
    index = int(pose["_index"])
    pose_id = f"v{camera_index}:pose:{index}:{part}:{int(color)}"
    rotation = rotation_family(transform[:3, :3])
    centroid = points.mean(axis=0)
    spatial_bin = (int(math.floor(centroid[0] / 16.0)),
                   int(math.floor(centroid[1] / 16.0)))
    return DrawingCandidate(pose_id, quota_key(part, color), index, part, int(color),
                            tuple(tuple(float(value) for value in row) for row in transform),
                            overlap, distance, rotation, spatial_bin,
                            (float(low[0]), float(low[1]), float(high[0]), float(high[1])))


def _candidate_tokens(scorer, items, matrix, origin, pose_id, coordinate_shift=(0.0, 0.0),
                      base_feature_pixels=None):
    from placement_mixed_batch_search import fixed_native_score
    from placement_v2_observations import instance_owner, predicted_tokens
    fixed_native_score(scorer, items, matrix, origin)
    counts = [len(scorer.geometry[(part, str(color))]["triangles"])
              for part, color, _ in items]
    owner = instance_owner(scorer.last_layer["owner"][0], counts)
    tokens, _ = predicted_tokens(scorer.last_outline, scorer.last_layer["mask"][0], owner,
                                 include_seams=True)
    candidate_owner = f"part:{len(items) - 1}"
    shift = np.asarray(coordinate_shift, dtype=float)
    if shift.shape != (2,) or not np.isfinite(shift).all():
        raise ValueError("coordinate_shift must be a finite 2-vector")
    shifted = tuple(replace(token, position=tuple(np.asarray(token.position, float) - shift))
                    for token in tokens)
    owned = []
    for token in shifted:
        if candidate_owner not in token.owner_ids:
            continue
        owned.append(replace(token, token_id=f"{pose_id}:{token.token_id}",
                             owner_ids=(pose_id,), shared_boundary_id=None))
    suppressed = _suppressed_base_feature_ids(owner, len(items), base_feature_pixels or {})
    return tuple(owned), shifted, suppressed


def _suppressed_base_feature_ids(owner, candidate_instance, base_feature_pixels):
    """Read exact candidate-over-base visibility at fixed base foreground pixels."""
    owner = np.asarray(owner)
    instance = int(candidate_instance)
    if owner.ndim != 2 or instance <= 0 or instance != candidate_instance:
        raise ValueError("owner and candidate_instance are invalid")
    suppressed = []
    for feature_id, pixel in base_feature_pixels.items():
        x, y = map(int, pixel)
        if not (0 <= y < owner.shape[0] and 0 <= x < owner.shape[1]):
            raise ValueError("base feature sample pixel falls outside padded render")
        if owner[y, x] == instance:
            suppressed.append(feature_id)
    return tuple(sorted(suppressed))


def _base_features(scorer, base, matrix, origin, coordinate_shift):
    """Render stable padded base tokens and their nearest base-foreground pixels."""
    from placement_mixed_batch_search import fixed_native_score
    from placement_v2_observations import instance_owner, predicted_tokens
    fixed_native_score(scorer, base, matrix, origin)
    counts = [len(scorer.geometry[(part, str(color))]["triangles"])
              for part, color, _ in base]
    owner = instance_owner(scorer.last_layer["owner"][0], counts)
    tokens, _ = predicted_tokens(scorer.last_outline, scorer.last_layer["mask"][0], owner,
                                 include_seams=True)
    mask = np.asarray(scorer.last_layer["mask"][0], bool)
    if not mask.any():
        return (), {}
    nearest = distance_transform_edt(~mask, return_distances=False, return_indices=True)
    shift = np.asarray(coordinate_shift, dtype=float)
    features, pixels = [], {}
    height, width = mask.shape
    for index, token in enumerate(tokens):
        feature_id = f"base-feature:{index}:{token.token_id}"
        x = min(width - 1, max(0, int(round(token.position[0]))))
        y = min(height - 1, max(0, int(round(token.position[1]))))
        if not mask[y, x]:
            y, x = int(nearest[0, y, x]), int(nearest[1, y, x])
        shifted = replace(token, token_id=f"base:{token.token_id}",
                          position=tuple(np.asarray(token.position, float) - shift))
        features.append((feature_id, shifted)); pixels[feature_id] = (x, y)
    return tuple(features), pixels


def _conflicts(candidates):
    from placement_attach_group import make_assembly
    from placement_fast_collision import accelerate
    conflicts = []
    assemblies = {}
    for index, left in enumerate(candidates):
        for right in candidates[index + 1:]:
            if left.registry_index == right.registry_index:
                conflicts.append((left.pose_id, right.pose_id)); continue
            if left.pose_id not in assemblies:
                assembly = make_assembly([(left.part, left.color,
                                           np.asarray(left.transform, float))])
                if hasattr(assembly, "occ") and hasattr(assembly, "corevox"):
                    accelerate(assembly)
                assemblies[left.pose_id] = assembly
            if assemblies[left.pose_id].collides(right.part, np.asarray(right.transform, float)):
                conflicts.append((left.pose_id, right.pose_id))
    return tuple(conflicts)


def _source_hashes():
    from placement_v2_replay import source_hashes as replay_source_hashes
    names = tuple(replay_source_hashes()) + (
        "placement_v2_pose_search.py", "placement_v2_pose_assignment.py",
        "placement_v2_joint_assignment.py",
        "placement_mixed_batch_search.py", "placement_attach_group.py",
        "placement_fast_collision.py", "placement_run_scene.py")
    names = tuple(dict.fromkeys(names))
    if any(not (HERE / name).is_file() for name in names):
        raise ValueError("pose-search source dependency is missing")
    return {name: digest(HERE / name) for name in names}


def run(source, out, max_cameras=1, cheap_budget=256, render_budget=32,
        solver_time_limit=30.0, support_extra_cap=64, max_padded_dimension=4096):
    from placement_arrow_contacts import read_items
    from placement_attach_group import make_assembly
    from placement_feature_edges import FeatureEdgeScorer
    from placement_mixed_batch_search import fixed_native_score
    from placement_run_scene import run_scene
    from placement_v2_correspondence import CorrespondenceConfig, score_correspondence
    from placement_v2_curves import curve_observations, score_curves
    from placement_v2_observations import instance_owner, observed_tokens, predicted_tokens
    from placement_v2_joint_assignment import BaseFeature, solve_joint_base_assignment
    from placement_v2_pose_assignment import PoseOption

    source, out = Path(source), Path(out)
    if out.exists():
        raise ValueError("fresh output directory required")
    camera_limit, render_limit = int(max_cameras), int(render_budget)
    padded_limit = int(max_padded_dimension)
    if (camera_limit <= 0 or camera_limit != max_cameras
            or render_limit <= 0 or render_limit != render_budget
            or padded_limit <= 0 or padded_limit != max_padded_dimension):
        raise ValueError("camera and render budgets must be positive integers")
    (meta, registry, registration, pdf, registry_path, registration_path, base_path,
     input_paths, input_hashes_start) = _validate_runtime_inputs(source)
    out.mkdir(parents=True)
    hashes_start = _source_hashes()
    snapshot = out / "sources"; snapshot.mkdir()
    for name in hashes_start:
        shutil.copyfile(HERE / name, snapshot / name)
    base = read_items(base_path)
    complete_model = read_items(source / "model.ldr")
    scene, mask_source = run_scene(meta, complete_model)
    observations = tuple(observed_tokens(scene["rgb"], scene["mask"]))
    target_curves = curve_observations(scene["rgb"], scene["mask"])
    quotas = Counter(quota_key(part, color) for part, color in registry["allocated_pieces"])
    raw_poses = [dict(pose, _index=index) for index, pose in enumerate(registry["poses"])]
    started = time.perf_counter(); camera_records = []; complete = []
    geometry_dependencies = {}
    _progress(out, "run_start", cameras=camera_limit, raw_poses=len(raw_poses))

    for camera_index, view in enumerate(registration["hypotheses"][:camera_limit]):
        camera_started = time.perf_counter(); phase_seconds = {}
        _progress(out, "camera_start", camera_index=camera_index)
        cheap_started = time.perf_counter()
        matrix = np.asarray(view["projection"], float); origin = np.asarray(view["origin"], float)
        scorer = FeatureEdgeScorer(scene, span_tolerance=float("inf"), plane_depth=True)
        fixed_native_score(scorer, base, matrix, origin)
        base_counts = [len(scorer.geometry[(part, str(color))]["triangles"])
                       for part, color, _ in base]
        base_owner = instance_owner(scorer.last_layer["owner"][0], base_counts)
        base_tokens, _ = predicted_tokens(scorer.last_outline, scorer.last_layer["mask"][0],
                                          base_owner, include_seams=True)
        base_match = score_correspondence(base_tokens, observations)
        unmatched_ids = set(base_match.unmatched_observed_token_ids)
        residual_observations = tuple(token for token in observations if token.token_id in unmatched_ids)
        residual_observations, new_region, localized = _new_observations(
            residual_observations, scorer.last_layer["mask"][0], scene["mask"])
        edge_tree = cKDTree(np.asarray([token.position for token in residual_observations], float))

        cheap = []
        colors_by_part = defaultdict(set)
        for part, color in registry["allocated_pieces"]:
            colors_by_part[str(part)].add(int(color))
        for pose in raw_poses:
            for color in sorted(colors_by_part.get(str(pose["part"]), ())):
                cheap.append(_projected_descriptor(scorer, pose, color, matrix, origin,
                                                   edge_tree, new_region, camera_index))
        cheap_retained, cheap_counts = thin_drawing_candidates(cheap, cheap_budget)
        phase_seconds["cheap_projection_and_thinning"] = time.perf_counter() - cheap_started
        _progress(out, "cheap_complete", camera_index=camera_index,
                  retained=len(cheap_retained),
                  seconds=phase_seconds["cheap_projection_and_thinning"])

        base_bounds = []
        for part, color, transform in base:
            transform = np.asarray(transform, float)
            projected = scorer._project_part(part, int(color), transform, matrix)
            points = np.asarray(projected["xy"], float).reshape(-1, 2).copy()
            points += matrix @ transform[:3, 3] + origin
            low, high = points.min(axis=0), points.max(axis=0)
            base_bounds.append((float(low[0]), float(low[1]), float(high[0]), float(high[1])))
        padded_scene, padding = padded_camera_scene(
            scene, base_bounds + [candidate.projected_bounds for candidate in cheap],
            spacing=3, max_dimension=padded_limit)
        if padded_scene is None:
            phase_seconds["camera_total"] = time.perf_counter() - camera_started
            camera_records.append(dict(
                camera_index=camera_index, projection=matrix.tolist(), origin=origin.tolist(),
                raw_pose_count=len(raw_poses), cheap_counts=cheap_counts,
                rendered_pose_count=0, padding=padding, status="padded_dimension_refused",
                phase_seconds=phase_seconds,
                minimum_matches_per_selected_pose=1,
                complete_alternatives_true_visibility_rescored=0))
            _progress(out, "camera_refused_padding", camera_index=camera_index,
                      seconds=phase_seconds["camera_total"], padding=padding)
            continue
        render_scorer = FeatureEdgeScorer(
            padded_scene, span_tolerance=float("inf"), plane_depth=True)
        pad = np.asarray(padding["padding"][:2], dtype=float)
        padded_origin = origin + pad
        base_feature_rows, base_feature_pixels = _base_features(
            render_scorer, base, matrix, padded_origin, pad)

        rendered = []
        standalone_rows = []
        render_started = time.perf_counter()
        for rendered_index, candidate in enumerate(cheap_retained, 1):
            items = base + [(candidate.part, candidate.color,
                             np.asarray(candidate.transform, float))]
            tokens, full_tokens, suppressed = _candidate_tokens(
                render_scorer, items, matrix, padded_origin, candidate.pose_id, pad,
                base_feature_pixels)
            standalone = score_correspondence(full_tokens, observations)
            owned_support = score_correspondence(tokens, observations)
            rendered.append((standalone.normalized_cost, candidate.pose_id, candidate, tokens))
            standalone_rows.append(dict(pose_id=candidate.pose_id,
                                        registry_index=candidate.registry_index,
                                        quota_key=candidate.quota_key,
                                        tokens=len(tokens),
                                        exclusive_match_count=len(owned_support.matches),
                                        normalized_cost=standalone.normalized_cost,
                                        full_prediction_tokens=len(full_tokens),
                                        suppressed_base_feature_ids=list(suppressed),
                                        bbox_overlap=candidate.bbox_overlap,
                                        mean_edge_distance=candidate.mean_edge_distance))
            if rendered_index % 512 == 0 or rendered_index == len(cheap_retained):
                _progress(out, "standalone_render_progress", camera_index=camera_index,
                          completed=rendered_index, total=len(cheap_retained),
                          seconds=time.perf_counter() - render_started)
        phase_seconds["standalone_render_and_score"] = time.perf_counter() - render_started
        selection_started = time.perf_counter()
        by_key = defaultdict(list)
        visually_ineligible = defaultdict(list)
        standalone_by_id = {row["pose_id"]: row for row in standalone_rows}
        for row in rendered:
            if standalone_by_id[row[2].pose_id]["exclusive_match_count"] > 0:
                by_key[row[2].quota_key].append(row)
            else:
                visually_ineligible[row[2].quota_key].append(row[2].pose_id)
        render_retained = []
        render_counts = {}
        for key in sorted(quotas):
            ranked = sorted(by_key[key], key=lambda row: (row[0], row[1]))
            render_retained.extend(ranked[:render_limit])
            render_counts[key] = dict(
                rendered_input=sum(row[2].quota_key == key for row in rendered),
                visually_ineligible=len(visually_ineligible[key]), eligible=len(ranked),
                retained=min(render_limit, len(ranked)), budget=render_limit)
        primary_render_ids = tuple(row[2].pose_id for row in render_retained)
        available_rows = [row for row in rendered
                          if standalone_by_id[row[2].pose_id]["exclusive_match_count"] > 0]
        closed_candidates, support_closure = close_support_candidates(
            tuple(row[2] for row in render_retained), tuple(row[2] for row in available_rows),
            registry["base_supported"], registry["support_edges"], support_extra_cap)
        rendered_by_id = {row[2].pose_id: row for row in rendered}
        render_retained = [rendered_by_id[candidate.pose_id] for candidate in closed_candidates]
        candidates = tuple(row[2] for row in render_retained)
        support = support_records(candidates, registry["base_supported"], registry["support_edges"])
        support_pruned = []
        while True:
            unusable = {candidate.pose_id for candidate in candidates
                        if not support[candidate.pose_id]["base_supported"]
                        and not support[candidate.pose_id]["support_pose_ids"]}
            if not unusable:
                break
            support_pruned.extend(sorted(unusable))
            render_retained = [row for row in render_retained if row[2].pose_id not in unusable]
            candidates = tuple(row[2] for row in render_retained)
            support = support_records(candidates, registry["base_supported"],
                                      registry["support_edges"])
        options = tuple(PoseOption(candidate.pose_id, candidate.quota_key, row[3],
                                   support[candidate.pose_id]["base_supported"],
                                   support[candidate.pose_id]["support_pose_ids"])
                        for row, candidate in zip(render_retained, candidates))
        candidate_ids = {candidate.pose_id for candidate in candidates}
        occluders_by_feature = defaultdict(list)
        for row in standalone_rows:
            if row["pose_id"] in candidate_ids:
                for feature_id in row["suppressed_base_feature_ids"]:
                    occluders_by_feature[feature_id].append(row["pose_id"])
        base_features = tuple(BaseFeature(
            feature_id, (token,), tuple(sorted(occluders_by_feature[feature_id])))
            for feature_id, token in base_feature_rows)
        viability = {}
        for key in sorted(quotas):
            pre = [row for row in standalone_rows if row["quota_key"] == key
                   and row["pose_id"] in set(primary_render_ids)]
            post = [standalone_by_id[candidate.pose_id] for candidate in candidates
                    if candidate.quota_key == key]
            viability[key] = dict(
                quota=quotas[key], rendered_before_support_prune=len(pre),
                nonzero_tokens_before_support_prune=sum(row["tokens"] > 0 for row in pre),
                exclusive_match_before_support_prune=sum(row["exclusive_match_count"] > 0
                                                         for row in pre),
                retained_after_support_prune=len(post),
                nonzero_tokens_after_support_prune=sum(row["tokens"] > 0 for row in post),
                exclusive_match_after_support_prune=sum(row["exclusive_match_count"] > 0
                                                        for row in post))
        phase_seconds["retention_and_support"] = time.perf_counter() - selection_started
        conflict_started = time.perf_counter()
        _progress(out, "conflicts_start", camera_index=camera_index,
                  retained=len(candidates))
        conflicts = _conflicts(candidates)
        phase_seconds["conflicts"] = time.perf_counter() - conflict_started
        _progress(out, "conflicts_complete", camera_index=camera_index,
                  conflicts=len(conflicts), seconds=phase_seconds["conflicts"])
        config = CorrespondenceConfig(kind_mismatch_cost=4.0)
        camera_record = dict(camera_index=camera_index, projection=matrix.tolist(),
                             origin=origin.tolist(), raw_pose_count=len(raw_poses),
                             padding=padding,
                             cheap_counts=cheap_counts, rendered_pose_count=len(rendered),
                             render_counts=render_counts, residual_observations=len(residual_observations),
                             residual_localized_to_new_region=localized,
                             base_match=asdict(base_match), conflicts=len(conflicts),
                             support_pruned_pose_ids=support_pruned,
                             support_pruned_count=len(support_pruned),
                             primary_render_retained_pose_ids=list(primary_render_ids),
                             support_closure=support_closure,
                             rendered_retained_pose_ids=[candidate.pose_id
                                                         for candidate in candidates],
                             base_features=dict(total=len(base_features)),
                             phase_seconds=phase_seconds,
                             visual_quota_viability=viability,
                             minimum_matches_per_selected_pose=1,
                             standalone_candidates=standalone_rows,
                             complete_alternatives_true_visibility_rescored=0)
        for parsed in render_scorer.geometry.values():
            geometry_dependencies.update(parsed.get("files", {}))
        solve_started = time.perf_counter()
        _progress(out, "solve_start", camera_index=camera_index,
                  real_options=len(options), base_features=len(base_features),
                  observations=len(observations), time_limit=float(solver_time_limit))
        try:
            assignment = solve_joint_base_assignment(
                options, observations, dict(quotas), base_features,
                conflicts=conflicts, config=config, time_limit=float(solver_time_limit),
                minimum_matches_per_real_pose=1)
        except Exception as exc:
            phase_seconds["joint_solve"] = time.perf_counter() - solve_started
            camera_record.update(status="solver_refused",
                                 solver_error=f"{type(exc).__name__}: {exc}")
            phase_seconds["camera_total"] = time.perf_counter() - camera_started
            _progress(out, "solve_refused", camera_index=camera_index,
                      seconds=phase_seconds["joint_solve"], error=str(exc))
            camera_records.append(camera_record)
            continue
        phase_seconds["joint_solve"] = time.perf_counter() - solve_started
        _progress(out, "solve_complete", camera_index=camera_index,
                  status=assignment.status, optimal=assignment.optimal,
                  mip_gap=assignment.mip_gap, seconds=phase_seconds["joint_solve"])
        option_tokens = {option.pose_id: len(option.tokens) for option in options}
        zero_token_selected = [pose_id for pose_id in assignment.selected_pose_ids
                               if option_tokens.get(pose_id) == 0]
        camera_record["joint_solver"] = dict(
            selected_pose_ids=list(assignment.selected_pose_ids),
            total_cost=assignment.total_cost, optimal=assignment.optimal,
            status=assignment.status, real_match_count=len(assignment.matches),
            base_match_count=len(assignment.base_matches),
            base_matches=[asdict(match) for match in assignment.base_matches],
            visible_base_feature_ids=list(assignment.visible_base_feature_ids),
            suppressed_base_feature_ids=list(assignment.suppressed_base_feature_ids),
            mip_gap=assignment.mip_gap, solver_message=assignment.solver_message,
            selected_token_counts={pose_id: option_tokens[pose_id]
                                   for pose_id in assignment.selected_pose_ids},
            zero_token_selected_pose_ids=zero_token_selected,
            zero_token_selected_visually_supported=False)
        camera_record["base_features"].update(
            visible_count=len(assignment.visible_base_feature_ids),
            suppressed_count=len(assignment.suppressed_base_feature_ids),
            visible_feature_ids=list(assignment.visible_base_feature_ids),
            suppressed_feature_ids=list(assignment.suppressed_base_feature_ids),
            feature_match_count=len(assignment.base_matches))
        if assignment.selected_pose_ids:
            actual_started = time.perf_counter()
            items = selected_items(base, assignment.selected_pose_ids, candidates)
            render_path = out / f"view-{camera_index:02d}.png"
            evidence = fixed_native_score(render_scorer, items, matrix, padded_origin, render_path)
            counts = [len(render_scorer.geometry[(part, str(color))]["triangles"])
                      for part, color, _ in items]
            owner = instance_owner(render_scorer.last_layer["owner"][0], counts)
            actual_tokens, buffers = predicted_tokens(
                render_scorer.last_outline, render_scorer.last_layer["mask"][0], owner,
                include_seams=True)
            actual_tokens = tuple(replace(
                token, position=tuple(np.asarray(token.position, float) - pad))
                for token in actual_tokens)
            actual_edge = score_correspondence(actual_tokens, observations, config)
            actual_curves = curve_observations(
                buffers["outline"], render_scorer.last_layer["mask"][0])
            actual_curves = [dict(curve, center=(np.asarray(curve["center"], float) - pad).tolist())
                             for curve in actual_curves]
            curve_score = score_curves(actual_curves, target_curves)
            actual_cost = (0.5 * (actual_edge.normalized_cost + curve_score["normalized_cost"])
                           if target_curves else actual_edge.normalized_cost)
            model = make_assembly(items).to_ldr(
                "0 Raw legacy pose registry + v2 ownership assignment; uncertified")
            model_path = out / f"view-{camera_index:02d}.ldr"; model_path.write_text(model)
            selected_feature_rows = [row for row in standalone_rows
                                     if row["pose_id"] in set(assignment.selected_pose_ids)]
            camera_record.update(actual=dict(
                normalized_cost=actual_cost, edge=asdict(actual_edge), curves=curve_score,
                raster_evidence=evidence, predicted_tokens=len(actual_tokens),
                primitive_curves=len(actual_curves), selected_pose_features=selected_feature_rows),
                model=str(model_path), render=str(render_path))
            camera_record["complete_alternatives_true_visibility_rescored"] = 1
            complete.append((actual_cost, camera_index, model_path, render_path,
                             tuple(assignment.selected_pose_ids)))
            phase_seconds["complete_true_visibility_rescore"] = time.perf_counter() - actual_started
        phase_seconds["camera_total"] = time.perf_counter() - camera_started
        _progress(out, "camera_complete", camera_index=camera_index,
                  seconds=phase_seconds["camera_total"],
                  actual_cost=camera_record.get("actual", {}).get("normalized_cost"))
        camera_records.append(camera_record)

    if not complete:
        status, selected = "no_complete_assignment", None
    else:
        complete.sort(key=lambda row: (row[0], row[1], row[4]))
        best = complete[0]
        shutil.copyfile(best[2], out / "model.ldr"); shutil.copyfile(best[3], out / "selected.png")
        status = "bounded_complete_assignment"
        selected = dict(camera_index=best[1], normalized_cost=best[0],
                        selected_pose_ids=list(best[4]), model_sha256=digest(out / "model.ldr"))
    hashes_end = _source_hashes()
    input_hashes_end = {name: digest(path) for name, path in input_paths.items()}
    geometry_unchanged = all(Path(path).is_file() and digest(path) == expected
                             for path, expected in geometry_dependencies.items())
    report = dict(
        protocol="raw-legacy-registry-v2-joint-base-ownership-search-v2", status=status,
        source_placement=str(source), source_results_sha256=input_hashes_start["source_results"],
        pdf=str(pdf), pdf_sha256=digest(pdf), page=meta["page"], xref=meta["xref"],
        mask_source=mask_source, base_source=str(base_path), base_sha256=digest(base_path),
        registry_source=str(registry_path), registry_sha256=digest(registry_path),
        registration_source=str(registration_path), registration_sha256=digest(registration_path),
        geometry_dependencies=geometry_dependencies,
        allocated_pieces=registry["allocated_pieces"], quotas=dict(quotas),
        raw_pose_count=len(raw_poses), max_cameras=camera_limit,
        cheap_budget_per_key=int(cheap_budget), render_budget_per_key=render_limit,
        support_extra_cap=int(support_extra_cap), solver_time_limit=float(solver_time_limit),
        max_padded_dimension=padded_limit,
        cameras=camera_records, selected=selected,
        seconds=time.perf_counter() - started, source_hashes_start=hashes_start,
        source_hashes_end=hashes_end, sources_unchanged=hashes_start == hashes_end,
        runtime_input_hashes_start=input_hashes_start,
        runtime_input_hashes_end=input_hashes_end,
        runtime_inputs_unchanged=input_hashes_start == input_hashes_end,
        geometry_dependencies_unchanged=geometry_unchanged,
        truth_used=False, runtime_vlm_calls=0, certified=False,
        limitations=[
            "Consumes the bounded legacy raw pose registry; correct poses may be absent",
            "Drawing-first and single-pose render caps can discard the best joint assembly",
            "Unsupported poses whose every support witness was removed by thinning are explicitly pruned and reported",
            "The base-only residual mask affects cheap drawing thinning, while joint MILP matching receives every observation",
            "Base-feature suppression is sampled at each token's nearest padded base-foreground pixel",
            "MILP token ownership uses single-pose visibility; only the selected complete assembly gets true-visibility edge+curve rescoring",
            "One complete assignment per camera is rescored; no quiet optimality claim beyond the retained MILP representation"])
    (out / "report.json").write_text(json.dumps(report, indent=2, default=str))
    if (not report["sources_unchanged"] or not report["runtime_inputs_unchanged"]
            or not report["geometry_dependencies_unchanged"]):
        raise RuntimeError("pose-search code, runtime inputs, or CAD dependencies changed during run")
    _progress(out, "run_complete", status=status, seconds=report["seconds"])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True,
                        help="Complete legacy page placement containing raw registry provenance")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-cameras", type=int, default=1)
    parser.add_argument("--cheap-budget", type=int, default=256)
    parser.add_argument("--render-budget", type=int, default=32)
    parser.add_argument("--solver-time-limit", type=float, default=30.0)
    parser.add_argument("--support-extra-cap", type=int, default=64)
    parser.add_argument("--max-padded-dimension", type=int, default=4096)
    args = parser.parse_args()
    try:
        result = run(args.source, args.out, args.max_cameras, args.cheap_budget,
                     args.render_budget, args.solver_time_limit, args.support_extra_cap,
                     args.max_padded_dimension)
    except Exception as exc:
        if args.out.is_dir():
            (args.out / "failure.json").write_text(json.dumps(dict(
                status="error", error=f"{type(exc).__name__}: {exc}",
                source=str(args.source), max_cameras=args.max_cameras,
                cheap_budget=args.cheap_budget, render_budget=args.render_budget,
                solver_time_limit=args.solver_time_limit,
                support_extra_cap=args.support_extra_cap,
                max_padded_dimension=args.max_padded_dimension,
                truth_used=False, runtime_vlm_calls=0), indent=2))
        raise
    print(json.dumps(dict(status=result["status"], selected=result["selected"],
                          output=str(args.out / "report.json"))))


if __name__ == "__main__":
    main()
