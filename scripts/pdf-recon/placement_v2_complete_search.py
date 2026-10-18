"""Bounded exact search over complete physical placement assemblies.

The enumerator is intentionally generic.  It knows exact inventory quotas,
pairwise conflicts, and rooted support, but has no drawing-truth or rendering
dependency.  A caller supplies the one whole-assembly objective.  Every
physically feasible complete selection is passed to that callback exactly once.

This is an optimality certificate only for the finite candidate bank admitted
by :class:`CompleteSearchLimits`; it is not a scalable booklet search.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations, product
import math
from numbers import Real
from typing import Callable, Iterable, Mapping, Tuple


@dataclass(frozen=True)
class CompletePose:
    """One physical pose in a finite candidate bank.

    ``payload`` is opaque to this module and is retained so the objective sees
    the complete selected instances.  In particular, a caller must not omit a
    selected instance merely because it is hidden in the current drawing.
    ``support_pose_ids`` names possible parents; a selected pose is rooted when
    it is base-supported or has a path through selected parents to such a pose.
    """

    pose_id: str
    quota_key: str
    payload: object = None
    base_supported: bool = False
    support_pose_ids: Tuple[str, ...] = ()


@dataclass(frozen=True)
class CompleteSearchLimits:
    """Hard pre-score limits for the exact finite search."""

    max_poses: int = 64
    max_combinations: int = 100_000


@dataclass(frozen=True)
class CompleteAssemblyScore:
    selected_pose_ids: Tuple[str, ...]
    score: float


@dataclass(frozen=True)
class CompleteSearchResult:
    assemblies: Tuple[CompleteAssemblyScore, ...]
    optimum_selection_ids: Tuple[Tuple[str, ...], ...]
    optimum_score: float | None
    candidate_pose_count: int
    selected_pose_count: int
    complete_combination_bound: int
    enumerated_complete_combinations: int
    feasible_assembly_count: int
    score_call_count: int
    absolute_tolerance: float


class CompleteSearchRefused(ValueError):
    """The declared finite bank exceeds a limit required for exhaustiveness."""


def _positive_limit(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _is_rooted(selected_ids: Tuple[str, ...], by_id: Mapping[str, CompletePose]) -> bool:
    selected = set(selected_ids)
    reached = {pose_id for pose_id in selected if by_id[pose_id].base_supported}
    while True:
        added = {
            pose_id for pose_id in selected - reached
            if any(parent in reached for parent in by_id[pose_id].support_pose_ids)
        }
        if not added:
            return reached == selected
        reached.update(added)


def search_complete_assemblies(
    poses: Iterable[CompletePose],
    quotas: Mapping[str, int],
    conflicts: Iterable[Tuple[str, str]],
    score_complete: Callable[[Tuple[CompletePose, ...]], Real],
    *,
    limits: CompleteSearchLimits = CompleteSearchLimits(),
    absolute_tolerance: float = 1e-12,
) -> CompleteSearchResult:
    """Score every feasible complete assembly and return every optimum tie.

    Enumeration is canonical by quota key and pose ID, so input permutations do
    not change callback order or result order.  The raw exact-quota combination
    count is a conservative upper bound: conflicts and rootlessness are checked
    only after the limit test.  Consequently a refusal occurs before any score
    callback, with no unsupported objective-based pruning.
    """
    if not isinstance(limits, CompleteSearchLimits):
        raise ValueError("limits must be CompleteSearchLimits")
    max_poses = _positive_limit(limits.max_poses, "max_poses")
    max_combinations = _positive_limit(limits.max_combinations, "max_combinations")
    tolerance = float(absolute_tolerance)
    if not math.isfinite(tolerance) or tolerance < 0:
        raise ValueError("absolute_tolerance must be finite and non-negative")
    if not callable(score_complete):
        raise ValueError("score_complete must be callable")

    pose_rows = tuple(poses)
    if len(pose_rows) > max_poses:
        raise CompleteSearchRefused(
            f"exact complete search refused before scoring: {len(pose_rows)} poses "
            f"exceed max_poses={max_poses}")

    by_id = {}
    grouped = {}
    for pose in pose_rows:
        if not isinstance(pose, CompletePose):
            raise ValueError("poses must contain CompletePose records")
        pose_id = _text(pose.pose_id, "pose_id")
        quota_key = _text(pose.quota_key, f"{pose_id} quota_key")
        if pose_id in by_id:
            raise ValueError(f"duplicate pose_id: {pose_id}")
        if not isinstance(pose.base_supported, bool):
            raise ValueError(f"{pose_id} base_supported must be Boolean")
        support_ids = tuple(pose.support_pose_ids)
        if len(set(support_ids)) != len(support_ids):
            raise ValueError(f"{pose_id} support_pose_ids must be distinct")
        for parent in support_ids:
            _text(parent, f"{pose_id} support pose ID")
            if parent == pose_id:
                raise ValueError(f"{pose_id} cannot support itself")
        by_id[pose_id] = pose
        grouped.setdefault(quota_key, []).append(pose)

    clean_quotas = {}
    for key, quota in quotas.items():
        quota_key = _text(key, "quota key")
        if isinstance(quota, bool) or not isinstance(quota, int) or quota < 0:
            raise ValueError(f"quota for {quota_key} must be a non-negative integer")
        clean_quotas[quota_key] = quota
    unknown_quota_keys = sorted(set(grouped) - set(clean_quotas))
    if unknown_quota_keys:
        raise ValueError(f"poses use undeclared quota keys: {unknown_quota_keys}")
    for pose in pose_rows:
        unknown_parents = sorted(set(pose.support_pose_ids) - set(by_id))
        if unknown_parents:
            raise ValueError(
                f"{pose.pose_id} names unknown support poses: {unknown_parents}")

    conflict_set = set()
    for pair in conflicts:
        try:
            left, right = pair
        except (TypeError, ValueError):
            raise ValueError("each conflict must contain exactly two pose IDs") from None
        left = _text(left, "conflict pose ID")
        right = _text(right, "conflict pose ID")
        if left == right:
            raise ValueError(f"self conflict is invalid: {left}")
        missing = sorted({left, right} - set(by_id))
        if missing:
            raise ValueError(f"conflict names unknown poses: {missing}")
        conflict_set.add(frozenset((left, right)))

    ordered_keys = tuple(sorted(clean_quotas))
    group_specs = []
    group_counts = []
    for key in ordered_keys:
        candidates = tuple(sorted(grouped.get(key, ()), key=lambda pose: pose.pose_id))
        quota = clean_quotas[key]
        count = math.comb(len(candidates), quota) if quota <= len(candidates) else 0
        group_specs.append((candidates, quota))
        group_counts.append(count)
    combination_bound = math.prod(group_counts)
    if combination_bound > max_combinations:
        raise CompleteSearchRefused(
            "exact complete search refused before scoring: exact-quota combination "
            f"bound {combination_bound} exceeds max_combinations={max_combinations}")

    selected_pose_count = sum(clean_quotas.values())
    if combination_bound == 0:
        return CompleteSearchResult(
            assemblies=(), optimum_selection_ids=(), optimum_score=None,
            candidate_pose_count=len(pose_rows),
            selected_pose_count=selected_pose_count,
            complete_combination_bound=0,
            enumerated_complete_combinations=0,
            feasible_assembly_count=0, score_call_count=0,
            absolute_tolerance=tolerance,
        )

    # Each pool and their product are now bounded by max_combinations.  Python's
    # product materializes input pools, so constructing them only after this
    # preflight is part of the memory/refusal contract.
    choices = tuple(tuple(combinations(candidates, quota))
                    for candidates, quota in group_specs)
    scored = []
    enumerated = 0
    for grouped_selection in product(*choices):
        enumerated += 1
        selection = tuple(pose for group in grouped_selection for pose in group)
        selected_ids = tuple(pose.pose_id for pose in selection)
        selected_set = set(selected_ids)
        if any(pair <= selected_set for pair in conflict_set):
            continue
        if not _is_rooted(selected_ids, by_id):
            continue
        raw_score = score_complete(selection)
        if isinstance(raw_score, bool) or not isinstance(raw_score, Real):
            raise ValueError("score_complete must return a real number")
        score = float(raw_score)
        if not math.isfinite(score):
            raise ValueError("score_complete must return a finite number")
        scored.append(CompleteAssemblyScore(selected_ids, score))

    optimum_score = min((item.score for item in scored), default=None)
    optimum_ids = tuple(
        item.selected_pose_ids for item in scored
        if optimum_score is not None and abs(item.score - optimum_score) <= tolerance
    )
    assemblies = tuple(scored)
    return CompleteSearchResult(
        assemblies=assemblies,
        optimum_selection_ids=optimum_ids,
        optimum_score=optimum_score,
        candidate_pose_count=len(pose_rows),
        selected_pose_count=selected_pose_count,
        complete_combination_bound=combination_bound,
        enumerated_complete_combinations=enumerated,
        feasible_assembly_count=len(assemblies),
        score_call_count=len(assemblies),
        absolute_tolerance=tolerance,
    )
