"""Sealed evaluation-only complete-objective control for the 41624 page-3 fixture.

The freeze phase derives a six-pose finite domain from the already sealed real
fixture.  The run phase ranks every mechanically feasible exact-quota assembly
without exposing reference labels to either the search or objective callback;
only after ranking does it compute fixed-frame evaluation metrics.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
import time

import numpy as np


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PARENT_PROTOCOL = "placement-v2-real-fixture-control-v1"
PROTOCOL = "placement-v2-complete-fixture-control-v1"
RESULT_PROTOCOL = "placement-v2-complete-fixture-result-v1"
EXPECTED_PARENT_SHA256 = "53943efeb340d8916e95627993d6ce558236ca9d7dcfe7425ee9e7131b4a297d"
EXPECTED_POSES = 6
EXPECTED_RAW_COMBINATIONS = 12
MAX_RENDERS = 32
TIE_TOLERANCE = 1e-12
LEGACY_HELPERS = (
    "placement_v2_fixture_controls.py", "placement_v2_pose_search.py",
    "placement_v2_pose_search_evaluate.py", "placement_arrow_contacts.py",
    "placement_run_scene.py", "placement_feature_edges.py",
    "placement_gpu_colored_scene_score.py", "placement_cuda_layers.py",
    "placement_cuda_planes.py", "placement_v2_observations.py",
    "placement_v2_correspondence.py", "placement_v2_curves.py",
    "placement_mixed_batch_search.py", "placement_part_library.py",
    "placement_diagnose_alias_poses.py", "pose_score.py",
)
OWN_SOURCES = (
    "placement_v2_complete_fixture.py", "placement_v2_complete_search.py",
    "placement_v2_complete_objective.py",
)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read(path):
    return json.loads(Path(path).read_text())


def _verify_seal(path):
    path = Path(path)
    sidecar = Path(str(path) + ".sha256")
    if not sidecar.is_file():
        raise ValueError(f"missing seal: {sidecar}")
    words = sidecar.read_text().split()
    if not words or words[0].lower() != digest(path):
        raise ValueError(f"seal differs from bytes: {path}")
    return digest(sidecar)


def _source_hashes():
    names = OWN_SOURCES + LEGACY_HELPERS
    missing = [name for name in names if not (HERE / name).is_file()]
    if missing:
        raise ValueError(f"required control source missing: {missing[0]}")
    return {name: digest(HERE / name) for name in names}


def _objective_config_record():
    from placement_v2_complete_objective import CompleteObjectiveConfig
    config = CompleteObjectiveConfig()
    if is_dataclass(config):
        return asdict(config)
    return dict(vars(config))


def freeze_complete_fixture(parent_path, out):
    """Create a sealed child manifest without changing the protected parent."""
    parent_path, out = Path(parent_path), Path(out)
    if out.exists() or Path(str(out) + ".sha256").exists():
        raise ValueError("fresh child manifest path required")
    parent_seal_sha256 = _verify_seal(parent_path)
    parent_sha256 = digest(parent_path)
    parent = _read(parent_path)
    if parent_sha256 != EXPECTED_PARENT_SHA256:
        raise ValueError("unexpected parent fixture bytes")
    if (parent.get("protocol") != PARENT_PROTOCOL
            or parent.get("truth_use") != "evaluation_only"
            or parent.get("bounds", {}).get("raw_registry_scan") is not False):
        raise ValueError("refusing invalid parent fixture")
    correct = tuple(parent["correct_pose_ids"])
    wrong = tuple(parent["runtime_selected_wrong_pose_ids"])
    domain_ids = tuple(sorted(set(correct) | set(wrong)))
    if set(correct) & set(wrong) or len(domain_ids) != EXPECTED_POSES:
        raise ValueError("parent does not define a disjoint six-pose union")
    poses = {}
    for pose_id in domain_ids:
        row = parent["poses"][pose_id]
        poses[pose_id] = {
            "pose_id": pose_id, "quota_key": row["quota_key"],
            "registry_index": int(row["registry_index"]), "part": str(row["part"]),
            "color": int(row["quota_key"].rsplit(":", 1)[1]),
            "transform": row["transform"],
        }
    quotas = {str(key): int(value) for key, value in parent["quotas"].items()}
    counts = {key: sum(row["quota_key"] == key for row in poses.values()) for key in quotas}
    raw_count = math.prod(math.comb(counts[key], quotas[key]) for key in sorted(quotas))
    if counts != {"3700:4": 4, "2780:0": 2} or raw_count != EXPECTED_RAW_COMBINATIONS:
        raise ValueError("six-pose domain does not have the frozen 2-pin/4-brick shape")
    manifest = {
        "protocol": PROTOCOL, "status": "frozen_before_measurement",
        "scope": ("Evaluation-only finite domain derived from a reference-selected parent. "
                  "Never a runtime proposal, cache, model, policy, or accuracy claim."),
        "truth_use": "evaluation_only",
        "permitted_consumers": [Path(__file__).name],
        "prohibited_consumers": ["runtime search", "proposal generation", "runtime cache",
                                 "production model path", "accuracy claim"],
        "parent": {"path": str(parent_path), "sha256": parent_sha256,
                   "seal_path": str(Path(str(parent_path) + ".sha256")),
                   "seal_sha256": parent_seal_sha256, "protocol": PARENT_PROTOCOL,
                   "preserved_bytes": True},
        "runtime": parent["runtime"], "camera": parent["camera"],
        "shared_base_alignment": parent["shared_base_alignment"],
        "domain": {"construction": "sorted union of the parent's two frozen evaluation sets",
                   "reference_selected": True, "poses": poses, "quotas": quotas,
                   "pose_count": len(poses), "raw_exact_quota_combinations": raw_count,
                   "raw_registry_scan": False},
        "selector_contract": {"inputs": ["domain.poses", "domain.quotas",
                                            "recomputed collision conflicts",
                                            "recomputed selected-only rooted support",
                                            "complete objective callback"],
                              "truth_labels_visible": False},
        "evaluation_only_labels": {"correct_pose_ids": list(correct),
                                   "runtime_selected_wrong_pose_ids": list(wrong),
                                   "truth_path": parent["evaluation"]["truth_path"],
                                   "truth_sha256": parent["evaluation"]["truth_sha256"]},
        "objective": {"name": "placement_v2_complete_objective",
                      "config": _objective_config_record(), "lower_is_better": True,
                      "absolute_tie_tolerance": TIE_TOLERANCE},
        "bounds": {"pose_count": EXPECTED_POSES,
                   "raw_exact_quota_combinations": EXPECTED_RAW_COMBINATIONS,
                   "maximum_complete_renders": MAX_RENDERS, "camera_count": 1,
                   "full_booklet": False},
        "source_hashes": _source_hashes(),
        "limitations": [
            "The parent domain was selected using reference truth and is evaluation-only.",
            "Complete enumeration is only over this six-pose union, not the runtime registry.",
            "Structural and strict labels are applied only after objective ranking.",
            "A winning correct assembly would not establish runtime recall or accuracy.",
        ],
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    Path(str(out) + ".sha256").write_text(f"{digest(out)}  {out.name}\n")
    return manifest


def _load_manifest(path):
    path = Path(path)
    _verify_seal(path)
    manifest = _read(path)
    if (manifest.get("protocol") != PROTOCOL
            or manifest.get("truth_use") != "evaluation_only"
            or manifest.get("selector_contract", {}).get("truth_labels_visible") is not False
            or manifest.get("domain", {}).get("raw_registry_scan") is not False):
        raise ValueError("refusing invalid complete-fixture manifest")
    bounds = manifest.get("bounds", {})
    if (int(bounds.get("pose_count", 0)) != EXPECTED_POSES
            or int(bounds.get("raw_exact_quota_combinations", 0)) != EXPECTED_RAW_COMBINATIONS
            or int(bounds.get("maximum_complete_renders", 0)) > MAX_RENDERS):
        raise ValueError("complete-fixture bounds differ")
    parent_path = Path(manifest["parent"]["path"])
    parent_seal_sha256 = _verify_seal(parent_path)
    if (digest(parent_path) != manifest["parent"]["sha256"]
            or digest(parent_path) != EXPECTED_PARENT_SHA256
            or parent_seal_sha256 != manifest["parent"]["seal_sha256"]):
        raise ValueError("parent manifest provenance changed")
    if _source_hashes() != manifest["source_hashes"]:
        raise ValueError("control source changed after freeze")
    return manifest


def _strict_added_count(selected, base, truth, rotation, translation,
                        position_tolerance=1.0, rotation_tolerance=1e-4):
    """Fixed-frame strict matches after reserving truth instances for the base."""
    def edges(items, targets):
        rows, cols = [], []
        for i, (part, color, position, frame) in enumerate(items):
            mapped_position = rotation @ np.asarray(position) + translation
            mapped_frame = rotation @ np.asarray(frame)
            for j in targets:
                tpart, tcolor, tposition, tframe = truth[j]
                if ((part, int(color)) == (tpart, int(tcolor))
                        and np.max(np.abs(mapped_position - tposition)) <= position_tolerance + 1e-8
                        and np.allclose(mapped_frame, tframe, atol=rotation_tolerance, rtol=0)):
                    rows.append(i); cols.append(j)
        return rows, cols

    def maximum_targets(rows, cols, item_count):
        neighbors = {row: [] for row in range(item_count)}
        for row, col in zip(rows, cols):
            neighbors[row].append(col)
        owner = {}

        def visit(row, seen):
            for col in neighbors[row]:
                if col in seen:
                    continue
                seen.add(col)
                if col not in owner or visit(owner[col], seen):
                    owner[col] = row
                    return True
            return False

        for row in range(item_count):
            visit(row, set())
        return set(owner)

    available = list(range(len(truth)))
    br, bt = edges(base, available)
    used = maximum_targets(br, bt, len(base))
    remaining = [index for index in available if index not in used]
    sr, st = edges(selected, remaining)
    return len(maximum_targets(sr, st, len(selected)))


def _evaluation_counts(pose_ids, pose_rows, manifest, registry, base):
    """Apply labels after selection under the one frozen base frame."""
    from placement_part_library import PartLibrary
    from placement_v2_pose_search_evaluate import _pose_recall
    from pose_score import read_parts

    labels = manifest["evaluation_only_labels"]
    truth_path = Path(labels["truth_path"])
    if not truth_path.is_file() or digest(truth_path) != labels["truth_sha256"]:
        raise ValueError("evaluation truth changed")
    truth = read_parts(truth_path)
    alignment = manifest["shared_base_alignment"]
    rotation = np.asarray(alignment["rotation"], float)
    translation = np.asarray(alignment["translation"], float)
    stage = [(int(pose_rows[pose_id]["registry_index"]), pose_rows[pose_id]["quota_key"])
             for pose_id in pose_ids]
    # Allocation is the exact selected quota multiset; stage controls the poses.
    allocation = [(pose_rows[pose_id]["part"], pose_rows[pose_id]["color"])
                  for pose_id in pose_ids]
    structural = _pose_recall(stage, registry, allocation, truth, base,
                              rotation, translation, PartLibrary())
    selected = []
    for pose_id in pose_ids:
        row = pose_rows[pose_id]
        transform = np.asarray(row["transform"], float)
        selected.append((row["part"], int(row["color"]),
                         transform[:3, 3], transform[:3, :3]))
    strict = _strict_added_count(selected, base, truth, rotation, translation)
    return {"structural_exact_added": int(structural["matched"]),
            "strict_exact_added": strict, "denominator": len(pose_ids),
            "common_base_alignment_index": int(alignment["index"])}


def _plain(value):
    if is_dataclass(value):
        return {key: _plain(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_plain(item) for item in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    return value


def run_complete_fixture(manifest_path, out):
    from placement_arrow_contacts import read_items
    from placement_v2_complete_objective import CompleteObjectiveConfig, CompleteObjectiveScorer
    from placement_v2_complete_search import CompletePose, CompleteSearchLimits, search_complete_assemblies
    from placement_v2_pose_search import DrawingCandidate, _conflicts, support_records
    from placement_v2_pose_search_evaluate import validate_runtime
    from placement_run_scene import run_scene

    manifest_path, out = Path(manifest_path), Path(out)
    if out.exists():
        raise ValueError("fresh result directory required")
    manifest = _load_manifest(manifest_path)
    objective_config = CompleteObjectiveConfig(**manifest["objective"]["config"])
    if asdict(objective_config) != manifest["objective"]["config"]:
        raise ValueError("objective configuration differs from freeze")
    report, registry, _, report_path = validate_runtime(manifest["runtime"]["run"])
    if (report_path.resolve() != Path(manifest["runtime"]["report"]).resolve()
            or digest(report_path) != manifest["runtime"]["report_sha256"]):
        raise ValueError("runtime report differs from child manifest")
    out.mkdir(parents=True)
    snapshots = out / "sources-start"; snapshots.mkdir()
    source_hashes_start = _source_hashes()
    for name, expected in source_hashes_start.items():
        if expected != manifest["source_hashes"][name]:
            raise ValueError(f"source changed before run: {name}")
        shutil.copyfile(HERE / name, snapshots / name)
    source_root = Path(report["source_placement"])
    input_paths = {"runtime_report": report_path, "source_results": source_root / "results.json",
                   "source_model": source_root / "model.ldr", "pdf": Path(report["pdf"]),
                   "base": Path(report["base_source"]), "registry": Path(report["registry_source"]),
                   "registration": Path(report["registration_source"])}
    input_paths.update({f"cad:{path}": Path(path)
                        for path in report.get("geometry_dependencies", {})})
    if any(not path.is_file() for path in input_paths.values()):
        raise ValueError("runtime input or CAD dependency missing")
    input_hashes_start = {name: digest(path) for name, path in input_paths.items()}
    expected = {"source_results": report["source_results_sha256"], "pdf": report["pdf_sha256"],
                "base": report["base_sha256"], "registry": report["registry_sha256"],
                "registration": report["registration_sha256"]}
    if any(input_hashes_start[key] != value for key, value in expected.items()):
        raise ValueError("runtime input differs from seal")
    base = read_items(input_paths["base"])
    complete_model = read_items(input_paths["source_model"])
    scene, mask_source = run_scene(_read(input_paths["source_results"]), complete_model)
    pose_rows = manifest["domain"]["poses"]
    candidates = []
    for pose_id, row in pose_rows.items():
        candidates.append(DrawingCandidate(
            pose_id, row["quota_key"], int(row["registry_index"]), row["part"],
            int(row["color"]), tuple(tuple(float(v) for v in line) for line in row["transform"]),
            0.0, 0.0))
    conflicts = _conflicts(tuple(candidates))
    support = support_records(tuple(candidates), registry["base_supported"], registry["support_edges"])
    payload_by_id = {candidate.pose_id: (candidate.part, candidate.color,
                     np.asarray(candidate.transform, float)) for candidate in candidates}
    complete_poses = tuple(CompletePose(
        candidate.pose_id, candidate.quota_key, payload_by_id[candidate.pose_id],
        bool(support[candidate.pose_id]["base_supported"]),
        tuple(support[candidate.pose_id]["support_pose_ids"])) for candidate in candidates)
    coverage_items = [payload_by_id[pose_id] for pose_id in sorted(payload_by_id)]
    scorer = CompleteObjectiveScorer(scene, base, manifest["camera"], coverage_items,
                                     config=objective_config)
    objective_rows = {}

    def score_selected(selected):
        ids = tuple(pose.pose_id for pose in selected)
        score = scorer(base + [pose.payload for pose in selected])
        objective_rows[ids] = _plain(score)
        return float(score.normalized_cost)

    search = search_complete_assemblies(
        complete_poses, manifest["domain"]["quotas"], conflicts, score_selected,
        limits=CompleteSearchLimits(max_poses=EXPECTED_POSES,
                                    max_combinations=EXPECTED_RAW_COMBINATIONS),
        absolute_tolerance=float(manifest["objective"]["absolute_tie_tolerance"]))
    search_record = _plain(search)
    rendered = len(objective_rows)
    if rendered > int(manifest["bounds"]["maximum_complete_renders"]):
        raise ValueError("render limit exceeded")
    labels = manifest["evaluation_only_labels"]  # first read after search returns
    correct_ids = tuple(sorted(labels["correct_pose_ids"]))
    wrong_ids = tuple(sorted(labels["runtime_selected_wrong_pose_ids"]))
    old = _read("output/pdf-placement-v2/41624-page3-fixture-diagnostic-v2/diagnostic.json")
    old_path = Path("output/pdf-placement-v2/41624-page3-fixture-diagnostic-v2/diagnostic.json")
    _verify_seal(old_path)
    parity = {}
    for label, ids in (("correct", correct_ids), ("runtime_selected_wrong", wrong_ids)):
        current = objective_rows.get(ids)
        previous = old["results"][label]["complete_objective"]["normalized_cost"]
        value = None if current is None else float(current["normalized_cost"])
        legacy_order = tuple(old["results"][label]["pose_ids"])
        legacy_score = scorer(base + [payload_by_id[pose_id] for pose_id in legacy_order])
        rendered += 1
        legacy_value = float(legacy_score.normalized_cost)
        parity[label] = {"pose_ids": list(ids), "previous": previous, "current": value,
                         "absolute_delta": None if value is None else abs(value - previous),
                         "legacy_order_pose_ids": list(legacy_order),
                         "legacy_order_current": legacy_value,
                         "order_invariant": value is not None and math.isclose(
                             value, legacy_value, abs_tol=TIE_TOLERANCE, rel_tol=0),
                         "verified": value is not None
                             and math.isclose(value, previous, abs_tol=TIE_TOLERANCE, rel_tol=0)
                             and math.isclose(legacy_value, previous,
                                              abs_tol=TIE_TOLERANCE, rel_tol=0)}
    if rendered > int(manifest["bounds"]["maximum_complete_renders"]):
        raise ValueError("render limit exceeded during parity checks")
    winning_ids = [tuple(ids) for ids in search_record["optimum_selection_ids"]]
    evaluated_ids = sorted(set(winning_ids + [tuple(ids) for ids in objective_rows]))
    evaluation = {"winner_ties": {"|".join(ids): _evaluation_counts(
                      ids, pose_rows, manifest, registry, base) for ids in winning_ids},
                  "all_feasible": {"|".join(ids): _evaluation_counts(
                      ids, pose_rows, manifest, registry, base) for ids in evaluated_ids}}
    source_hashes_end = _source_hashes()
    input_hashes_end = {name: digest(path) for name, path in input_paths.items()}
    if source_hashes_end != source_hashes_start or input_hashes_end != input_hashes_start:
        raise ValueError("sources or runtime/CAD inputs changed during run")
    end_snapshots = out / "sources-end"; end_snapshots.mkdir()
    for name in source_hashes_end:
        shutil.copyfile(HERE / name, end_snapshots / name)
    ranked = sorted(((float(row["normalized_cost"]), ids) for ids, row in objective_rows.items()),
                    key=lambda item: (item[0], item[1]))
    ranking = []
    rank = 0
    previous_score = None
    for ordinal, (score, ids) in enumerate(ranked, 1):
        if previous_score is None or not math.isclose(
                score, previous_score, abs_tol=TIE_TOLERANCE, rel_tol=0):
            rank = ordinal
        ranking.append({"rank": rank, "pose_ids": list(ids), "score": score})
        previous_score = score
    parity_passed = all(row["verified"] for row in parity.values())
    result = {"protocol": RESULT_PROTOCOL,
              "status": "completed" if parity_passed else "completed_with_failed_parity_gate",
              "scope": manifest["scope"], "truth_use": "evaluation_only",
              "manifest": str(manifest_path), "manifest_sha256": digest(manifest_path),
              "parent_manifest_provenance": manifest["parent"],
              "source_hashes_start": source_hashes_start,
              "source_hashes_end": source_hashes_end, "sources_unchanged": True,
              "source_snapshots": {"start": str(snapshots), "end": str(end_snapshots)},
              "input_hashes_start": input_hashes_start, "input_hashes_end": input_hashes_end,
              "inputs_unchanged": True, "mask_source": mask_source,
              "domain": {"pose_count": len(complete_poses),
                         "raw_exact_quota_combinations": EXPECTED_RAW_COMBINATIONS,
                         "conflicts": [list(pair) for pair in conflicts], "support": support},
              "render_count": rendered, "render_limit": MAX_RENDERS,
              "search": search_record,
              "complete_ranking": ranking,
              "objective_by_selection": {"|".join(ids): value
                                         for ids, value in sorted(objective_rows.items())},
              "sealed_previous_diagnostic_v2": {"path": str(old_path),
                                                  "sha256": digest(old_path),
                                                  "pair_parity": parity,
                                                  "gate_passed": parity_passed},
              "evaluation_only": evaluation,
              "permitted_conclusion": ("Ranks every mechanically feasible exact-quota assembly "
                  "in this reference-selected six-pose domain under one frozen complete objective; "
                  "it does not establish runtime candidate generation or placement accuracy."),
              "completed_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    result_path = out / "result.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    Path(str(result_path) + ".sha256").write_text(f"{digest(result_path)}  {result_path.name}\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    freeze = sub.add_parser("freeze")
    freeze.add_argument("--parent", type=Path, required=True)
    freeze.add_argument("--out", type=Path, required=True)
    run = sub.add_parser("run")
    run.add_argument("--manifest", type=Path, required=True)
    run.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = (freeze_complete_fixture(args.parent, args.out) if args.command == "freeze"
              else run_complete_fixture(args.manifest, args.out))
    print(json.dumps(_plain(result), indent=2))


if __name__ == "__main__":
    main()
