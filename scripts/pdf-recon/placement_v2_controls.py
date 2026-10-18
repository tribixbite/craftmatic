"""Bounded exhaustive controls for the finite placement-v2 joint solver.

This module is deliberately evaluation-only.  It enumerates physical pose
selections, checks support with ordinary graph reachability, derives base
visibility directly, and enumerates every exclusive token matching.  It does
not call SciPy, the MILP solver, or correspondence implementation helpers.

The oracle refuses problems whose declared bounds would be exceeded.  It also
refuses when ``max_neighbors_per_prediction`` would prune an otherwise eligible
edge, because a capped correspondence graph is not an exhaustive certificate.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations, product
import math
from typing import Iterable, Mapping, Sequence, Tuple

from placement_v2_correspondence import (
    CorrespondenceConfig, ObservedFeatureToken, PredictedFeatureToken,
)
from placement_v2_joint_assignment import BaseFeature
from placement_v2_pose_assignment import PoseOption


@dataclass(frozen=True)
class ExhaustiveControlLimits:
    max_options: int = 16
    max_base_features: int = 1_000
    max_observations: int = 12
    max_pose_combinations: int = 100_000
    max_prediction_groups_per_assembly: int = 14
    max_total_matching_states: int = 1_000_000


@dataclass(frozen=True)
class ExhaustiveControlMatch:
    pose_id: str | None
    base_feature_id: str | None
    predicted_token_ids: Tuple[str, ...]
    observed_token_id: str
    cost: float
    distance_sigma: float
    tangent_residual: float


@dataclass(frozen=True)
class ExhaustiveAssemblyScore:
    selected_pose_ids: Tuple[str, ...]
    total_cost: float
    matches: Tuple[ExhaustiveControlMatch, ...]
    visible_base_feature_ids: Tuple[str, ...]
    suppressed_base_feature_ids: Tuple[str, ...]


@dataclass(frozen=True)
class ExhaustiveJointControlResult:
    mechanically_feasible_selection_ids: Tuple[Tuple[str, ...], ...]
    feasible_selection_ids: Tuple[Tuple[str, ...], ...]
    optimum_selection_ids: Tuple[Tuple[str, ...], ...]
    optimum_cost: float
    assemblies: Tuple[ExhaustiveAssemblyScore, ...]
    enumerated_pose_combinations: int
    enumerated_matching_state_bound: int


@dataclass(frozen=True)
class PhysicalSelectionCheck:
    selected_pose_ids: Tuple[str, ...]
    exact_quotas: bool
    conflict_free: bool
    rooted_support: bool
    visible_base_feature_ids: Tuple[str, ...]
    suppressed_base_feature_ids: Tuple[str, ...]

    @property
    def feasible(self) -> bool:
        return self.exact_quotas and self.conflict_free and self.rooted_support


@dataclass(frozen=True)
class _Observation:
    token_id: str
    position: Tuple[float, float]
    tangent: Tuple[float, float]
    uncertainty: float
    feature_kind: str
    material_class: str | None
    unmatched_cost: float


@dataclass(frozen=True)
class _PredictionGroup:
    pose_id: str | None
    base_feature_id: str | None
    token_ids: Tuple[str, ...]
    position: Tuple[float, float]
    tangent: Tuple[float, float]
    feature_kind: str
    material_class: str | None


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _pair(value: Sequence[float], label: str) -> Tuple[float, float]:
    if len(value) != 2:
        raise ValueError(f"{label} must contain exactly two coordinates")
    result = (float(value[0]), float(value[1]))
    if not all(math.isfinite(item) for item in result):
        raise ValueError(f"{label} must be finite")
    return result


def _tangent(value: Sequence[float], label: str) -> Tuple[float, float]:
    result = _pair(value, label)
    norm = math.hypot(*result)
    if norm <= 0:
        raise ValueError(f"{label} must be non-zero")
    return (result[0] / norm, result[1] / norm)


def _validate_config(config: CorrespondenceConfig) -> None:
    for name in (
        "max_distance_sigma", "distance_weight", "tangent_weight",
        "kind_mismatch_cost", "material_mismatch_cost",
        "unmatched_visible_prediction_cost", "unmatched_observation_cost",
        "seam_position_tolerance", "seam_tangent_tolerance",
    ):
        value = float(getattr(config, name))
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"{name} must be finite and non-negative")
    if config.max_distance_sigma <= 0:
        raise ValueError("max_distance_sigma must be positive")
    if (isinstance(config.max_neighbors_per_prediction, bool)
            or not isinstance(config.max_neighbors_per_prediction, int)
            or config.max_neighbors_per_prediction <= 0):
        raise ValueError("max_neighbors_per_prediction must be a positive integer")


def _validate_limits(limits: ExhaustiveControlLimits) -> None:
    if not isinstance(limits, ExhaustiveControlLimits):
        raise ValueError("limits must be ExhaustiveControlLimits")
    for name in limits.__dataclass_fields__:
        value = getattr(limits, name)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")


def _prepare_observations(tokens: Iterable[ObservedFeatureToken], config):
    result = []
    seen = set()
    for token in tokens:
        if not isinstance(token, ObservedFeatureToken):
            raise ValueError("observed must contain ObservedFeatureToken records")
        token_id = _text(token.token_id, "observed token_id")
        if token_id in seen:
            raise ValueError(f"duplicate observed token_id: {token_id}")
        seen.add(token_id)
        uncertainty = float(token.uncertainty)
        annotation = float(token.annotation_probability)
        if not math.isfinite(uncertainty) or uncertainty <= 0:
            raise ValueError(f"{token_id} uncertainty must be finite and positive")
        if not math.isfinite(annotation) or not 0 <= annotation <= 1:
            raise ValueError(f"{token_id} annotation_probability must be in [0, 1]")
        result.append(_Observation(
            token_id, _pair(token.position, f"{token_id} position"),
            _tangent(token.tangent, f"{token_id} tangent"), uncertainty,
            _text(token.feature_kind, "feature_kind"), token.material_class,
            float(config.unmatched_observation_cost) * (1.0 - annotation)))
    return tuple(sorted(result, key=lambda item: item.token_id))


def _prepare_groups(tokens, config, pose_id=None, base_feature_id=None):
    prepared = []
    seen = set()
    for token in tokens:
        if not isinstance(token, PredictedFeatureToken):
            raise ValueError("predictions must contain PredictedFeatureToken records")
        token_id = _text(token.token_id, "predicted token_id")
        if token_id in seen:
            raise ValueError(f"duplicate predicted token_id: {token_id}")
        seen.add(token_id)
        owners = tuple(_text(owner, "owner_id") for owner in token.owner_ids)
        if not owners or len(set(owners)) != len(owners):
            raise ValueError(f"{token_id} must have non-empty, distinct owner_ids")
        shared = token.shared_boundary_id
        if shared is not None:
            _text(shared, "shared_boundary_id")
        prepared.append((token, token_id,
                         _pair(token.position, f"{token_id} position"),
                         _tangent(token.tangent, f"{token_id} tangent")))
    by_key = {}
    for item in prepared:
        token = item[0]
        key = ("shared", token.shared_boundary_id) if token.shared_boundary_id else ("token", item[1])
        by_key.setdefault(key, []).append(item)
    groups = []
    for key in sorted(by_key):
        members = sorted(by_key[key], key=lambda item: item[1])
        first, _, position, tangent = members[0]
        for token, token_id, other_position, other_tangent in members:
            tangent_delta = 1.0 - abs(tangent[0] * other_tangent[0] + tangent[1] * other_tangent[1])
            if (math.dist(position, other_position) > config.seam_position_tolerance
                    or tangent_delta > config.seam_tangent_tolerance
                    or token.visible != first.visible
                    or token.feature_kind != first.feature_kind
                    or token.material_class != first.material_class):
                raise ValueError(f"inconsistent shared boundary metadata at {token_id}")
        if first.visible:
            groups.append(_PredictionGroup(
                pose_id, base_feature_id, tuple(item[1] for item in members),
                position, tangent, _text(first.feature_kind, "feature_kind"),
                first.material_class))
    return tuple(groups)


def _is_rooted(selected, by_id):
    reached = {pose_id for pose_id in selected if by_id[pose_id].base_supported}
    while True:
        added = {pose_id for pose_id in selected - reached
                 if any(parent in reached for parent in by_id[pose_id].support_pose_ids)}
        if not added:
            return reached == selected
        reached.update(added)


def _eligible_edges(prediction, observations, config):
    edges = []
    for index, observation in enumerate(observations):
        distance_sigma = math.dist(prediction.position, observation.position) / observation.uncertainty
        if distance_sigma > config.max_distance_sigma:
            continue
        dot = prediction.tangent[0] * observation.tangent[0] + prediction.tangent[1] * observation.tangent[1]
        tangent_residual = 1.0 - abs(dot)
        cost = (config.distance_weight * distance_sigma
                + config.tangent_weight * tangent_residual
                + config.kind_mismatch_cost
                * (prediction.feature_kind != observation.feature_kind)
                + config.material_mismatch_cost
                * (prediction.material_class is not None
                   and observation.material_class is not None
                   and prediction.material_class != observation.material_class))
        edges.append((index, float(cost), float(distance_sigma), float(tangent_residual)))
    edges.sort(key=lambda item: (item[2], observations[item[0]].token_id))
    if len(edges) > config.max_neighbors_per_prediction:
        raise ValueError(
            "exhaustive control refused: max_neighbors_per_prediction would prune eligible edges")
    return tuple(edges)


def _matching_state_bound(groups, observations, config):
    bound = 1
    edge_rows = []
    for group in groups:
        edges = _eligible_edges(group, observations, config)
        edge_rows.append(edges)
        bound *= 1 + len(edges)  # unmatched plus every eligible observation
    return bound, tuple(edge_rows)


def check_physical_pose_selection(
    options: Iterable[PoseOption],
    quotas: Mapping[str, int],
    base_features: Iterable[BaseFeature],
    selected_pose_ids: Iterable[str],
    conflicts: Iterable[Tuple[str, str]] = (),
    limits: ExhaustiveControlLimits = ExhaustiveControlLimits(),
) -> PhysicalSelectionCheck:
    """Independently check one fixed physical selection without visual scoring."""
    _validate_limits(limits)
    options = tuple(options)
    features = tuple(base_features)
    if len(options) > limits.max_options:
        raise ValueError("physical control refused: max_options exceeded")
    if len(features) > limits.max_base_features:
        raise ValueError("physical control refused: max_base_features exceeded")
    clean_quotas = {
        _text(key, "quota key"): _nonnegative_int(value, f"quota for {key}")
        for key, value in quotas.items()
    }
    by_id = {}
    for option in options:
        if not isinstance(option, PoseOption):
            raise ValueError("options must contain PoseOption records")
        pose_id = _text(option.pose_id, "pose_id")
        if pose_id in by_id:
            raise ValueError(f"duplicate pose_id: {pose_id}")
        if option.quota_key not in clean_quotas:
            raise ValueError(f"missing quota for key {option.quota_key}")
        by_id[pose_id] = option
    for pose_id, option in by_id.items():
        missing = sorted(set(option.support_pose_ids) - set(by_id))
        if missing:
            raise ValueError(f"unknown support pose for {pose_id}: {missing[0]}")
    selected_tuple = tuple(sorted(_text(item, "selected pose_id")
                                  for item in selected_pose_ids))
    if len(set(selected_tuple)) != len(selected_tuple):
        raise ValueError("selected_pose_ids must be distinct")
    unknown_selected = sorted(set(selected_tuple) - set(by_id))
    if unknown_selected:
        raise ValueError(f"unknown selected pose: {unknown_selected[0]}")
    selected = set(selected_tuple)
    exact = all(sum(by_id[pose_id].quota_key == key for pose_id in selected)
                == quota for key, quota in clean_quotas.items())
    conflict_free = True
    for pair in conflicts:
        if len(pair) != 2:
            raise ValueError("each conflict must contain two pose IDs")
        left, right = pair
        if left not in by_id or right not in by_id:
            raise ValueError(f"unknown conflict pose: {left if left not in by_id else right}")
        if set(pair) <= selected:
            conflict_free = False
    feature_ids = set()
    visible = []
    suppressed = []
    for feature in features:
        if not isinstance(feature, BaseFeature):
            raise ValueError("base_features must contain BaseFeature records")
        feature_id = _text(feature.feature_id, "base feature_id")
        if feature_id in feature_ids:
            raise ValueError(f"duplicate base feature_id: {feature_id}")
        feature_ids.add(feature_id)
        if not feature.tokens:
            raise ValueError(f"base feature {feature_id} must contain tokens")
        occluders = tuple(_text(item, f"{feature_id} occluding_pose_id")
                          for item in feature.occluding_pose_ids)
        if len(set(occluders)) != len(occluders):
            raise ValueError(f"duplicate occluders for base feature {feature_id}")
        unknown = sorted(set(occluders) - set(by_id))
        if unknown:
            raise ValueError(f"unknown occluding pose for {feature_id}: {unknown[0]}")
        (suppressed if set(occluders) & selected else visible).append(feature_id)
    return PhysicalSelectionCheck(
        selected_tuple, exact, conflict_free, _is_rooted(selected, by_id),
        tuple(sorted(visible)), tuple(sorted(suppressed)))


def _best_matching(groups, observations, edge_rows, minimum_matches,
                   required_pose_ids, config):
    best_cost = math.inf
    best_signature = None
    best_matches = ()
    unmatched_observation_total = sum(item.unmatched_cost for item in observations)

    def visit(row, used, cost, matches, pose_match_counts, reclaimed):
        nonlocal best_cost, best_signature, best_matches
        if row == len(groups):
            if any(pose_match_counts.get(pose_id, 0) < minimum_matches
                   for pose_id in required_pose_ids):
                return
            total = cost + unmatched_observation_total - reclaimed
            signature = tuple((match.pose_id or "", match.base_feature_id or "",
                               match.predicted_token_ids, match.observed_token_id)
                              for match in matches)
            if (total < best_cost - 1e-12
                    or (math.isclose(total, best_cost, abs_tol=1e-12)
                        and (best_signature is None or signature < best_signature))):
                best_cost, best_signature, best_matches = total, signature, tuple(matches)
            return
        group = groups[row]
        visit(row + 1, used,
              cost + config.unmatched_visible_prediction_cost,
              matches, pose_match_counts, reclaimed)
        for observation_index, edge_cost, distance_sigma, tangent_residual in edge_rows[row]:
            if observation_index in used:
                continue
            observation = observations[observation_index]
            match = ExhaustiveControlMatch(
                group.pose_id, group.base_feature_id, group.token_ids,
                observation.token_id, edge_cost, distance_sigma, tangent_residual)
            counts = pose_match_counts
            if group.pose_id is not None:
                counts = dict(pose_match_counts)
                counts[group.pose_id] = counts.get(group.pose_id, 0) + 1
            visit(row + 1, used | {observation_index}, cost + edge_cost,
                  matches + (match,), counts, reclaimed + observation.unmatched_cost)

    visit(0, set(), 0.0, (), {}, 0.0)
    return best_cost, best_matches


def solve_exhaustive_joint_base_assignment(
    options: Iterable[PoseOption],
    observed: Iterable[ObservedFeatureToken],
    quotas: Mapping[str, int],
    base_features: Iterable[BaseFeature],
    conflicts: Iterable[Tuple[str, str]] = (),
    config: CorrespondenceConfig = CorrespondenceConfig(),
    minimum_matches_per_real_pose: int = 1,
    limits: ExhaustiveControlLimits = ExhaustiveControlLimits(),
) -> ExhaustiveJointControlResult:
    """Return every bounded feasible selection and all minimum-cost ties."""
    _validate_config(config)
    _validate_limits(limits)
    minimum_matches = _nonnegative_int(
        minimum_matches_per_real_pose, "minimum_matches_per_real_pose")
    options = tuple(options)
    features = tuple(base_features)
    if len(options) > limits.max_options:
        raise ValueError("exhaustive control refused: max_options exceeded")
    if len(features) > limits.max_base_features:
        raise ValueError("exhaustive control refused: max_base_features exceeded")
    observations = _prepare_observations(observed, config)
    if len(observations) > limits.max_observations:
        raise ValueError("exhaustive control refused: max_observations exceeded")

    clean_quotas = {}
    for key, value in quotas.items():
        clean_quotas[_text(key, "quota key")] = _nonnegative_int(value, f"quota for {key}")
    by_id = {}
    by_quota = {key: [] for key in clean_quotas}
    pose_groups = {}
    for option in options:
        if not isinstance(option, PoseOption):
            raise ValueError("options must contain PoseOption records")
        pose_id = _text(option.pose_id, "pose_id")
        quota_key = _text(option.quota_key, f"{pose_id} quota_key")
        if pose_id in by_id:
            raise ValueError(f"duplicate pose_id: {pose_id}")
        if quota_key not in clean_quotas:
            raise ValueError(f"missing quota for key {quota_key}")
        supports = tuple(_text(parent, f"{pose_id} support_pose_id")
                         for parent in option.support_pose_ids)
        if len(set(supports)) != len(supports):
            raise ValueError(f"duplicate support_pose_ids for {pose_id}")
        by_id[pose_id] = option
        by_quota[quota_key].append(pose_id)
        pose_groups[pose_id] = _prepare_groups(option.tokens, config, pose_id=pose_id)
    for pose_id, option in by_id.items():
        missing = sorted(set(option.support_pose_ids) - set(by_id))
        if missing:
            raise ValueError(f"unknown support pose for {pose_id}: {missing[0]}")

    conflict_pairs = set()
    for pair in conflicts:
        if len(pair) != 2:
            raise ValueError("each conflict must contain two pose IDs")
        left, right = pair
        if left not in by_id or right not in by_id:
            raise ValueError(f"unknown conflict pose: {left if left not in by_id else right}")
        conflict_pairs.add(frozenset((left, right)))

    base_groups = {}
    occluders = {}
    base_predicted_ids = set()
    seam_owners = {}
    for feature in features:
        if not isinstance(feature, BaseFeature):
            raise ValueError("base_features must contain BaseFeature records")
        feature_id = _text(feature.feature_id, "base feature_id")
        if feature_id in base_groups:
            raise ValueError(f"duplicate base feature_id: {feature_id}")
        if not feature.tokens:
            raise ValueError(f"base feature {feature_id} must contain tokens")
        seam_ids = set()
        for token in feature.tokens:
            if not isinstance(token, PredictedFeatureToken):
                raise ValueError(f"base feature {feature_id} has a non-predicted token")
            token_id = _text(token.token_id, f"{feature_id} token_id")
            if token_id in base_predicted_ids:
                raise ValueError(f"duplicate base predicted token_id: {token_id}")
            base_predicted_ids.add(token_id)
            seam_ids.add(token.shared_boundary_id)
            if token.shared_boundary_id is not None:
                previous = seam_owners.setdefault(token.shared_boundary_id, feature_id)
                if previous != feature_id:
                    raise ValueError(
                        f"shared boundary {token.shared_boundary_id} is split across base features")
        if len(feature.tokens) > 1 and (None in seam_ids or len(seam_ids) != 1):
            raise ValueError(
                f"base feature {feature_id} tokens must form one shared-boundary group")
        values = tuple(_text(item, f"{feature_id} occluding_pose_id")
                       for item in feature.occluding_pose_ids)
        if len(set(values)) != len(values):
            raise ValueError(f"duplicate occluders for base feature {feature_id}")
        unknown = sorted(set(values) - set(by_id))
        if unknown:
            raise ValueError(f"unknown occluding pose for {feature_id}: {unknown[0]}")
        occluders[feature_id] = frozenset(values)
        base_groups[feature_id] = _prepare_groups(
            feature.tokens, config, base_feature_id=feature_id)

    choices = []
    pose_combination_count = 1
    for key in sorted(clean_quotas):
        available = tuple(sorted(by_quota[key]))
        quota = clean_quotas[key]
        count = math.comb(len(available), quota) if quota <= len(available) else 0
        pose_combination_count *= count
        if pose_combination_count > limits.max_pose_combinations:
            raise ValueError("exhaustive control refused: max_pose_combinations exceeded")
        choices.append(tuple(combinations(available, quota)))
    raw_selections = product(*choices) if choices else [()]
    mechanical = []
    for parts in raw_selections:
        selected_tuple = tuple(sorted(item for group in parts for item in group))
        selected = set(selected_tuple)
        if any(pair <= selected for pair in conflict_pairs):
            continue
        if _is_rooted(selected, by_id):
            mechanical.append(selected_tuple)

    prepared_assemblies = []
    total_matching_bound = 0
    for selected_tuple in mechanical:
        selected = set(selected_tuple)
        visible = tuple(sorted(feature_id for feature_id in base_groups
                               if not (occluders[feature_id] & selected)))
        suppressed = tuple(sorted(set(base_groups) - set(visible)))
        groups = tuple(group for pose_id in selected_tuple for group in pose_groups[pose_id])
        groups += tuple(group for feature_id in visible for group in base_groups[feature_id])
        if len(groups) > limits.max_prediction_groups_per_assembly:
            raise ValueError(
                "exhaustive control refused: max_prediction_groups_per_assembly exceeded")
        state_bound, edge_rows = _matching_state_bound(groups, observations, config)
        total_matching_bound += state_bound
        if total_matching_bound > limits.max_total_matching_states:
            raise ValueError("exhaustive control refused: max_total_matching_states exceeded")
        prepared_assemblies.append((selected_tuple, visible, suppressed, groups, edge_rows))

    scores = []
    for selected_tuple, visible, suppressed, groups, edge_rows in prepared_assemblies:
        cost, matches = _best_matching(
            groups, observations, edge_rows, minimum_matches,
            selected_tuple, config)
        if math.isfinite(cost):
            scores.append(ExhaustiveAssemblyScore(
                selected_tuple, float(cost), matches, visible, suppressed))
    if not scores:
        raise ValueError("exhaustive joint control infeasible")
    scores.sort(key=lambda item: item.selected_pose_ids)
    optimum = min(item.total_cost for item in scores)
    optimum_ids = tuple(item.selected_pose_ids for item in scores
                        if math.isclose(item.total_cost, optimum, abs_tol=1e-9))
    return ExhaustiveJointControlResult(
        mechanically_feasible_selection_ids=tuple(mechanical),
        feasible_selection_ids=tuple(item.selected_pose_ids for item in scores),
        optimum_selection_ids=optimum_ids,
        optimum_cost=float(optimum), assemblies=tuple(scores),
        enumerated_pose_combinations=pose_combination_count,
        enumerated_matching_state_bound=total_matching_bound)


__all__ = [
    "ExhaustiveControlLimits", "ExhaustiveControlMatch",
    "ExhaustiveAssemblyScore", "ExhaustiveJointControlResult",
    "PhysicalSelectionCheck", "check_physical_pose_selection",
    "solve_exhaustive_joint_base_assignment",
]
