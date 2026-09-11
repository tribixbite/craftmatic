"""Evaluation-only real-fixture controls for placement v2.

Reference data is accepted only while freezing a diagnostic manifest.  The
manifest may then drive fixed, bounded feasibility and complete-assembly score
controls; it is never a runtime proposal, cache, or model input.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from dataclasses import asdict, replace
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import sys
import time

import numpy as np


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PROTOCOL = "placement-v2-real-fixture-control-v1"
MAX_ALTERNATIVES = 8


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read(path):
    return json.loads(Path(path).read_text())


def _verify_sha_sidecar(path):
    path = Path(path)
    sidecar = Path(str(path) + ".sha256")
    if not sidecar.is_file():
        raise ValueError(f"missing seal: {sidecar}")
    expected = sidecar.read_text().split()[0]
    if expected != digest(path):
        raise ValueError(f"seal differs from bytes: {path}")


def _truth_assignment(rows, quotas):
    """Return deterministic exact-quota rows with distinct truth instances."""
    groups = defaultdict(list)
    for row in rows:
        groups[row["quota_key"]].append(row)
    choices = []
    for key, quota in sorted(quotas.items()):
        if len(groups[key]) < quota:
            return None
        choices.append(tuple(itertools.combinations(groups[key], int(quota))))
    best = None
    for grouped in itertools.product(*choices):
        selected = tuple(row for members in grouped for row in members)
        truth_options = [tuple(map(int, row["truth_indices"])) for row in selected]

        def match(position, used):
            if position == len(truth_options):
                return ()
            for truth_index in sorted(truth_options[position]):
                if truth_index not in used:
                    rest = match(position + 1, used | {truth_index})
                    if rest is not None:
                        return (truth_index,) + rest
            return None

        witness = match(0, set())
        if witness is None:
            continue
        key = (sum(float(row["normalized_cost"]) for row in selected),
               tuple(row["pose_id"] for row in selected))
        if best is None or key < best[0]:
            best = (key, selected, witness)
    return None if best is None else (best[1], best[2])


def _support_witness(pose_ids, rows_by_id, registry):
    indices = {pose_id: int(rows_by_id[pose_id]["registry_index"])
               for pose_id in pose_ids}
    by_index = defaultdict(list)
    for pose_id, index in indices.items():
        by_index[index].append(pose_id)
    graph = defaultdict(set)
    for a, b in registry["support_edges"]:
        if int(a) in by_index and int(b) in by_index:
            graph[int(a)].add(int(b)); graph[int(b)].add(int(a))
    roots = set(map(int, registry["base_supported"])) & set(by_index)
    reached = set(roots); queue = deque(sorted(roots)); parent = {}
    while queue:
        current = queue.popleft()
        for neighbor in sorted(graph[current]):
            if neighbor not in reached:
                reached.add(neighbor); parent[neighbor] = current; queue.append(neighbor)
    paths = {}
    for pose_id, index in indices.items():
        if index not in reached:
            paths[pose_id] = None
            continue
        path = [index]
        while path[-1] not in roots:
            path.append(parent[path[-1]])
        paths[pose_id] = path
    return dict(feasible=all(value is not None for value in paths.values()),
                base_supported_registry_indices=sorted(roots), paths=paths)


def freeze_fixture(run, evaluation, out, camera_index=0, alignment_index=None):
    """Freeze truth-derived IDs after validating the sealed runtime/evaluation."""
    from placement_v2_pose_search_evaluate import validate_runtime

    run, evaluation, out = map(Path, (run, evaluation, out))
    if out.exists():
        raise ValueError("fresh fixture manifest path required")
    report, registry, _, report_path = validate_runtime(run)
    _verify_sha_sidecar(evaluation)
    record = _read(evaluation)
    if (record.get("protocol") != "placement-v2-pose-search-sealed-posthoc-evaluation-v1"
            or "post-hoc evaluation" not in record.get("scope", "")):
        raise ValueError("input is not the sealed evaluation-only pose evaluation")
    if (Path(record["runtime_report"]).resolve() != report_path.resolve()
            or record["runtime_report_sha256"] != digest(report_path)):
        raise ValueError("evaluation/runtime report linkage differs")
    camera = next((item for item in report["cameras"]
                   if int(item["camera_index"]) == int(camera_index)), None)
    if camera is None:
        raise ValueError("requested camera is absent")
    quotas = {str(key): int(value) for key, value in report["quotas"].items()}
    diagnostics = record.get("correct_pose_diagnostics") or []
    if alignment_index is not None:
        diagnostics = [row for row in diagnostics
                       if int(row["alignment_index"]) == int(alignment_index)]
    options = []
    retained = set(camera["rendered_retained_pose_ids"])
    for diagnostic in diagnostics:
        rows = [row for row in diagnostic["candidates"]
                if int(row["camera_index"]) == int(camera_index)
                and row["pose_id"] in retained]
        assignment = _truth_assignment(rows, quotas)
        if assignment is not None:
            options.append((int(diagnostic["alignment_index"]), diagnostic, assignment))
    if not options:
        raise ValueError("no exact-quota, distinct-truth retained correct combination")
    alignment_index, diagnostic, (correct_rows, truth_witness) = min(
        options, key=lambda item: item[0])
    solver = camera.get("joint_solver") or camera.get("solver") or {}
    wrong_ids = tuple(solver.get("selected_pose_ids") or ())
    if len(wrong_ids) != sum(quotas.values()):
        raise ValueError("runtime camera has no exact-quota selected alternative")
    correct_ids = tuple(row["pose_id"] for row in correct_rows)
    if set(wrong_ids) & set(correct_ids):
        raise ValueError("runtime alternative overlaps the correct combination")
    rows_by_id = {row["pose_id"]: row for row in camera["standalone_candidates"]}
    required = set(correct_ids) | set(wrong_ids)
    if not required <= set(rows_by_id):
        raise ValueError("fixture pose absent from sealed standalone records")
    quota_checks = {}
    for label, ids in (("correct", correct_ids), ("runtime_selected_wrong", wrong_ids)):
        counts = Counter(rows_by_id[pose_id]["quota_key"] for pose_id in ids)
        quota_checks[label] = dict(feasible=dict(counts) == quotas, counts=dict(counts))
    poses = {}
    for pose_id in sorted(required):
        row = rows_by_id[pose_id]
        index = int(row["registry_index"])
        poses[pose_id] = dict(
            registry_index=index, quota_key=row["quota_key"],
            part=str(registry["poses"][index]["part"]),
            transform=registry["poses"][index]["T"],
            retained=pose_id in retained, tokens=int(row["tokens"]),
            exclusive_match_count=int(row["exclusive_match_count"]),
            unary_normalized_cost=float(row["normalized_cost"]),
            suppressed_base_feature_ids=row["suppressed_base_feature_ids"])
    manifest = dict(
        protocol=PROTOCOL, status="frozen_evaluation_fixture",
        scope=("Evaluation-only truth-derived diagnostic. Never permitted as a runtime "
               "proposal, cache, model, alignment, or selection input."),
        truth_use="evaluation_only", permitted_consumers=["placement_v2_fixture_controls.py"],
        prohibited_consumers=["runtime search", "proposal generation", "runtime cache",
                              "production model path", "set-specific rules"],
        fixture_id="41624-page3-v8-camera0-retained-correct-v1",
        runtime=dict(run=str(run), report=str(report_path), report_sha256=digest(report_path),
                     source_results_sha256=report["source_results_sha256"],
                     pdf=str(report["pdf"]), pdf_sha256=report["pdf_sha256"],
                     base=str(report["base_source"]), base_sha256=report["base_sha256"],
                     registry=str(report["registry_source"]),
                     registry_sha256=report["registry_sha256"],
                     registration=str(report["registration_source"]),
                     registration_sha256=report["registration_sha256"],
                     source_hashes=report["source_hashes_end"]),
        evaluation=dict(path=str(evaluation), sha256=digest(evaluation),
                        truth_path=record["truth_path"], truth_sha256=record["truth_sha256"]),
        camera=dict(index=int(camera_index), projection=camera["projection"],
                    origin=camera["origin"], padding=camera["padding"]),
        shared_base_alignment=dict(index=alignment_index,
                                   rotation=diagnostic["alignment"]["rotation"],
                                   translation=diagnostic["alignment"]["translation"],
                                   policy=record["pose_recall_alignment_policy"]),
        quotas=quotas, correct_pose_ids=list(correct_ids),
        correct_truth_indices=list(truth_witness),
        runtime_selected_wrong_pose_ids=list(wrong_ids), poses=poses,
        preflight=dict(
            retained_correct=all(poses[pose_id]["retained"] for pose_id in correct_ids),
            quota=quota_checks,
            support={label: _support_witness(ids, rows_by_id, registry)
                     for label, ids in (("correct", correct_ids),
                                        ("runtime_selected_wrong", wrong_ids))},
            collision="pending bounded recomputation",
            joint_visibility_assignment="pending bounded fixed-selection solve",
            complete_assembly_objective="pending bounded true-visibility render"),
        bounds=dict(candidate_assemblies=2, poses_per_assembly=sum(quotas.values()),
                    max_candidate_assemblies=MAX_ALTERNATIVES,
                    raw_registry_scan=False, full_booklet=False, camera_count=1),
        limitations=[
            "Development fixture selected with reference truth; it is not held out.",
            "The finite comparison contains only the correct and runtime-selected assemblies.",
            "Support edges and collision tests are witnesses in the runtime representation, not physical certificates.",
            "Unary suppression remains an approximation to full new-part/new-part visibility."],
        created_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    Path(str(out) + ".sha256").write_text(f"{digest(out)}  {out.name}\n")
    return manifest


def _load_and_validate_manifest(path):
    path = Path(path); _verify_sha_sidecar(path); manifest = _read(path)
    if (manifest.get("protocol") != PROTOCOL
            or manifest.get("truth_use") != "evaluation_only"
            or manifest.get("bounds", {}).get("raw_registry_scan") is not False):
        raise ValueError("refusing non-evaluation or unbounded fixture manifest")
    if int(manifest["bounds"]["candidate_assemblies"]) > MAX_ALTERNATIVES:
        raise ValueError("fixture exceeds the bounded assembly limit")
    for key in ("report", "pdf", "base", "registry", "registration"):
        value = manifest["runtime"][key]
        if not Path(value).is_file() or digest(value) != manifest["runtime"][f"{key}_sha256"]:
            raise ValueError(f"sealed fixture input changed: {key}")
    return manifest


def diagnose_fixture(manifest_path, out, solver_time_limit=30.0, render=True):
    """Run two fixed-selection solves and same-objective complete renders."""
    from placement_arrow_contacts import read_items
    from placement_attach_group import make_assembly
    from placement_feature_edges import FeatureEdgeScorer
    from placement_mixed_batch_search import fixed_native_score
    from placement_run_scene import run_scene
    from placement_v2_correspondence import CorrespondenceConfig, score_correspondence
    from placement_v2_controls import check_physical_pose_selection
    from placement_v2_curves import curve_observations, score_curves
    from placement_v2_joint_assignment import BaseFeature, solve_joint_base_assignment
    from placement_v2_observations import instance_owner, observed_tokens, predicted_tokens
    from placement_v2_pose_assignment import PoseOption
    from placement_v2_pose_search import (
        _base_features, _candidate_tokens, _conflicts, _source_hashes,
        DrawingCandidate, digest as source_digest, support_records,
    )
    from placement_v2_pose_search_evaluate import validate_runtime

    manifest_path, out = Path(manifest_path), Path(out)
    if out.exists():
        raise ValueError("fresh diagnostic output directory required")
    manifest = _load_and_validate_manifest(manifest_path)
    report, registry, _, report_path = validate_runtime(manifest["runtime"]["run"])
    if (Path(manifest["runtime"]["report"]).resolve() != report_path.resolve()
            or digest(report_path) != manifest["runtime"]["report_sha256"]):
        raise ValueError("validated runtime report differs from fixture manifest")
    current_sources = _source_hashes()
    current_sources[Path(__file__).name] = source_digest(__file__)
    current_sources["placement_v2_controls.py"] = source_digest(
        HERE / "placement_v2_controls.py")
    out.mkdir(parents=True)
    snapshot = out / "sources"; snapshot.mkdir()
    for name, expected in current_sources.items():
        path = HERE / name
        if not path.is_file() or source_digest(path) != expected:
            raise ValueError(f"diagnostic source changed before snapshot: {name}")
        shutil.copyfile(path, snapshot / name)
    source_root = Path(report["source_placement"])
    input_paths = dict(
        runtime_report=report_path, source_results=source_root / "results.json",
        source_model=source_root / "model.ldr", pdf=Path(report["pdf"]),
        base=Path(report["base_source"]), registry=Path(report["registry_source"]),
        registration=Path(report["registration_source"]))
    input_paths.update({f"cad:{path}": Path(path)
                        for path in report.get("geometry_dependencies", {})})
    if any(not path.is_file() for path in input_paths.values()):
        raise ValueError("diagnostic input or CAD dependency is missing")
    input_hashes_start = {name: digest(path) for name, path in input_paths.items()}
    if (input_hashes_start["source_results"] != report["source_results_sha256"]
            or input_hashes_start["pdf"] != report["pdf_sha256"]
            or input_hashes_start["base"] != report["base_sha256"]
            or input_hashes_start["registry"] != report["registry_sha256"]
            or input_hashes_start["registration"] != report["registration_sha256"]):
        raise ValueError("diagnostic inputs differ from the runtime seal")
    meta = _read(input_paths["source_results"])
    base = read_items(manifest["runtime"]["base"])
    complete_model = read_items(input_paths["source_model"])
    scene, mask_source = run_scene(meta, complete_model)
    observations = tuple(observed_tokens(scene["rgb"], scene["mask"]))
    target_curves = curve_observations(scene["rgb"], scene["mask"])
    camera = manifest["camera"]
    matrix = np.asarray(camera["projection"], float)
    origin = np.asarray(camera["origin"], float)
    padding = camera["padding"]
    left, top, right, bottom = map(int, padding["padding"])
    rgb, mask = scene["rgb"], scene["mask"]
    padded_rgb = np.full((rgb.shape[0] + top + bottom, rgb.shape[1] + left + right,
                          rgb.shape[2]), 245, dtype=rgb.dtype)
    padded_mask = np.zeros(padded_rgb.shape[:2], dtype=mask.dtype)
    padded_rgb[top:top + rgb.shape[0], left:left + rgb.shape[1]] = rgb
    padded_mask[top:top + mask.shape[0], left:left + mask.shape[1]] = mask
    if list(padded_rgb.shape[1::-1]) != padding["padded_size"]:
        raise ValueError("saved padding no longer matches the scene")
    padded_scene = dict(scene, rgb=padded_rgb, mask=padded_mask)
    padded_origin = origin + np.asarray((left, top), float)
    scorer = FeatureEdgeScorer(padded_scene, span_tolerance=float("inf"), plane_depth=True)
    base_rows, base_pixels = _base_features(
        scorer, base, matrix, padded_origin, (left, top))
    rows = {}
    for pose_id, frozen in manifest["poses"].items():
        transform = tuple(tuple(float(value) for value in row)
                          for row in frozen["transform"])
        candidate = DrawingCandidate(
            pose_id, frozen["quota_key"], int(frozen["registry_index"]), frozen["part"],
            int(frozen["quota_key"].rsplit(":", 1)[1]), transform, 0.0, 0.0)
        items = base + [(candidate.part, candidate.color, np.asarray(transform, float))]
        tokens, _, suppressed = _candidate_tokens(
            scorer, items, matrix, padded_origin, pose_id, (left, top), base_pixels)
        if (len(tokens) != int(frozen["tokens"])
                or list(suppressed) != frozen["suppressed_base_feature_ids"]):
            raise ValueError(f"reconstructed unary visibility differs for {pose_id}")
        rows[pose_id] = (candidate, tokens, suppressed)

    results = {}
    for label, ids in (("correct", manifest["correct_pose_ids"]),
                       ("runtime_selected_wrong", manifest["runtime_selected_wrong_pose_ids"])):
        candidates = tuple(rows[pose_id][0] for pose_id in ids)
        conflicts = _conflicts(candidates)
        support = support_records(candidates, registry["base_supported"],
                                  registry["support_edges"])
        options = tuple(PoseOption(
            candidate.pose_id, candidate.quota_key, rows[candidate.pose_id][1],
            support[candidate.pose_id]["base_supported"],
            support[candidate.pose_id]["support_pose_ids"]) for candidate in candidates)
        occluders = defaultdict(list)
        for pose_id in ids:
            for feature_id in rows[pose_id][2]:
                occluders[feature_id].append(pose_id)
        features = tuple(BaseFeature(feature_id, (token,), tuple(sorted(occluders[feature_id])))
                         for feature_id, token in base_rows)
        independent = check_physical_pose_selection(
            options, manifest["quotas"], features, ids, conflicts=conflicts)
        entry = dict(pose_ids=list(ids), conflicts=[list(pair) for pair in conflicts],
                     collision_feasible=not conflicts,
                     support=manifest["preflight"]["support"][label],
                     independent_physical_visibility=asdict(independent))
        try:
            assignment = solve_joint_base_assignment(
                options, observations, manifest["quotas"], features,
                conflicts=conflicts, config=CorrespondenceConfig(kind_mismatch_cost=4.0),
                time_limit=float(solver_time_limit), minimum_matches_per_real_pose=1)
            assignment_record = dict(
                selected_pose_ids=list(assignment.selected_pose_ids),
                total_cost=assignment.total_cost, optimal=assignment.optimal,
                status=assignment.status, matches=len(assignment.matches),
                base_matches=len(assignment.base_matches),
                visible_base_feature_count=len(assignment.visible_base_feature_ids),
                suppressed_base_feature_count=len(assignment.suppressed_base_feature_ids),
                mip_gap=assignment.mip_gap, solver_message=assignment.solver_message,
                raw_primal_bound=assignment.raw_primal_bound,
                raw_dual_bound=assignment.raw_dual_bound,
                objective_constant=assignment.objective_constant,
                absolute_gap=assignment.absolute_gap,
                solver_time_seconds=assignment.solver_time_seconds,
                variable_count=assignment.variable_count,
                integer_variable_count=assignment.integer_variable_count,
                constraint_count=assignment.constraint_count,
                nonzero_count=assignment.nonzero_count)
            entry["joint_assignment"] = assignment_record
            entry["joint_feasible"] = set(assignment.selected_pose_ids) == set(ids)
        except ValueError as exc:
            entry["joint_feasible"] = False
            entry["joint_assignment"] = dict(status="refused", error=str(exc))
        if render and entry["joint_feasible"]:
            items = base + [(candidate.part, candidate.color,
                             np.asarray(candidate.transform, float)) for candidate in candidates]
            render_path = out / f"{label}.png"
            evidence = fixed_native_score(scorer, items, matrix, padded_origin, render_path)
            counts = [len(scorer.geometry[(part, str(color))]["triangles"])
                      for part, color, _ in items]
            owner = instance_owner(scorer.last_layer["owner"][0], counts)
            tokens, buffers = predicted_tokens(scorer.last_outline,
                                                scorer.last_layer["mask"][0], owner,
                                                include_seams=True)
            tokens = tuple(replace(token, position=tuple(
                np.asarray(token.position, float) - (left, top))) for token in tokens)
            edge = score_correspondence(tokens, observations,
                                        CorrespondenceConfig(kind_mismatch_cost=4.0))
            curves = curve_observations(buffers["outline"], scorer.last_layer["mask"][0])
            curves = [dict(curve, center=(np.asarray(curve["center"], float)
                                          - (left, top)).tolist()) for curve in curves]
            curve = score_curves(curves, target_curves)
            normalized = (0.5 * (edge.normalized_cost + curve["normalized_cost"])
                          if target_curves else edge.normalized_cost)
            ldr = make_assembly(items).to_ldr("0 Evaluation-only fixed fixture control")
            model_path = out / f"{label}.ldr"; model_path.write_text(ldr)
            entry["complete_objective"] = dict(
                normalized_cost=normalized, edge=asdict(edge), curves=curve,
                raster_evidence=evidence, render=str(render_path), model=str(model_path),
                model_sha256=digest(model_path))
        results[label] = entry
    correct_cost = (results["correct"].get("complete_objective") or {}).get("normalized_cost")
    wrong_cost = (results["runtime_selected_wrong"].get("complete_objective") or {}).get(
        "normalized_cost")
    preference = "unresolved"
    if correct_cost is not None and wrong_cost is not None:
        delta = float(correct_cost) - float(wrong_cost)
        preference = ("tie" if abs(delta) <= 1e-12 else
                      "correct" if delta < 0 else "runtime_selected_wrong")
    sealed_camera = next(item for item in report["cameras"]
                         if int(item["camera_index"]) == int(manifest["camera"]["index"]))
    sealed_wrong_cost = (sealed_camera.get("actual") or {}).get("normalized_cost")
    scorer_parity = dict(verified=False, sealed_normalized_cost=sealed_wrong_cost,
                         reconstructed_normalized_cost=wrong_cost)
    if render:
        if sealed_wrong_cost is None or wrong_cost is None or not np.isclose(
                float(sealed_wrong_cost), float(wrong_cost), atol=1e-12, rtol=0):
            raise ValueError("runtime-selected complete scorer parity failed")
        scorer_parity["verified"] = True
    current_sources_end = _source_hashes()
    current_sources_end[Path(__file__).name] = source_digest(__file__)
    current_sources_end["placement_v2_controls.py"] = source_digest(
        HERE / "placement_v2_controls.py")
    input_hashes_end = {name: digest(path) for name, path in input_paths.items()}
    sources_unchanged = current_sources_end == current_sources
    inputs_unchanged = input_hashes_end == input_hashes_start
    if not sources_unchanged or not inputs_unchanged:
        raise ValueError("diagnostic sources or inputs changed during execution")
    result = dict(
        protocol="placement-v2-real-fixture-diagnostic-v1", status="completed",
        scope=manifest["scope"], truth_use="evaluation_only",
        fixture_manifest=str(manifest_path), fixture_manifest_sha256=digest(manifest_path),
        diagnostic_source_hashes_start=current_sources,
        diagnostic_source_hashes_end=current_sources_end,
        diagnostic_sources_unchanged=sources_unchanged,
        diagnostic_source_snapshot=str(snapshot),
        diagnostic_input_hashes_start=input_hashes_start,
        diagnostic_input_hashes_end=input_hashes_end,
        diagnostic_inputs_unchanged=inputs_unchanged,
        mask_source=mask_source,
        solver_time_limit=float(solver_time_limit), candidate_assemblies=2,
        results=results, complete_objective_preference=preference,
        runtime_selected_scorer_parity=scorer_parity,
        visually_indistinguishable="not independently adjudicated",
        permitted_conclusion=(
            "Classifies this fixed finite fixture under the recorded representation and objective; "
            "does not establish runtime candidate generation, generalization, or physical correctness."))
    result_path = out / "diagnostic.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    Path(str(result_path) + ".sha256").write_text(
        f"{digest(result_path)}  {result_path.name}\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    freeze = sub.add_parser("freeze")
    freeze.add_argument("--run", type=Path, required=True)
    freeze.add_argument("--evaluation", type=Path, required=True)
    freeze.add_argument("--out", type=Path, required=True)
    freeze.add_argument("--camera-index", type=int, default=0)
    freeze.add_argument("--alignment-index", type=int)
    diagnose = sub.add_parser("diagnose")
    diagnose.add_argument("--manifest", type=Path, required=True)
    diagnose.add_argument("--out", type=Path, required=True)
    diagnose.add_argument("--solver-time-limit", type=float, default=30.0)
    diagnose.add_argument("--no-render", action="store_true")
    args = parser.parse_args()
    if args.command == "freeze":
        result = freeze_fixture(args.run, args.evaluation, args.out,
                                args.camera_index, args.alignment_index)
    else:
        result = diagnose_fixture(args.manifest, args.out, args.solver_time_limit,
                                  not args.no_render)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
