"""Sparse, exclusive correspondence between rendered and drawing feature tokens.

The scorer is deliberately drawing-only: it consumes already extracted 2-D
tokens and has no access to model truth, a VLM, or reference poses.  Positions
are in one caller-declared coordinate system.  Tangents are unoriented (``t``
and ``-t`` describe the same stroke).  ``uncertainty`` uses the same units as
positions.

``shared_boundary_id`` is the explicit seam-deduplication contract.  Renderers
may emit the same physical seam once per adjacent instance; tokens with the
same non-null value are collapsed to one assignment row after their geometry
and metadata are checked.  Its owners are unioned, so one ink interval can
reward the physical boundary once, never once per adjacent part.

The sparse assignment has one row per deduplicated visible prediction, columns
for nearby observations, and a private unmatched column for each row.  The
constant cost of every unmatched observation is folded into real-edge costs.
Consequently the minimum full row matching is the desired minimum-cost partial
one-to-one matching.  Candidate edges are capped per prediction and no dense
all-page matrix is constructed.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Optional, Sequence, Tuple

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import min_weight_full_bipartite_matching
from scipy.spatial import cKDTree


Point2 = Tuple[float, float]


@dataclass(frozen=True)
class PredictedFeatureToken:
    """A rendered physical feature interval with stable instance ownership."""

    token_id: str
    owner_ids: Tuple[str, ...]
    position: Point2
    tangent: Point2
    visible: bool = True
    shared_boundary_id: Optional[str] = None
    feature_kind: str = "boundary"
    material_class: Optional[str] = None


@dataclass(frozen=True)
class ObservedFeatureToken:
    """A drawing feature interval; annotation probability softens its penalty."""

    token_id: str
    position: Point2
    tangent: Point2
    uncertainty: float = 1.0
    feature_kind: str = "boundary"
    material_class: Optional[str] = None
    annotation_probability: float = 0.0


@dataclass(frozen=True)
class CorrespondenceConfig:
    max_distance_sigma: float = 4.0
    max_neighbors_per_prediction: int = 24
    distance_weight: float = 1.0
    tangent_weight: float = 1.0
    kind_mismatch_cost: float = 1.0
    material_mismatch_cost: float = 0.5
    unmatched_visible_prediction_cost: float = 2.0
    unmatched_observation_cost: float = 2.0
    seam_position_tolerance: float = 1e-6
    seam_tangent_tolerance: float = 1e-6


@dataclass(frozen=True)
class CorrespondenceMatch:
    predicted_token_ids: Tuple[str, ...]
    observed_token_id: str
    owner_ids: Tuple[str, ...]
    cost: float
    distance_sigma: float
    tangent_residual: float


@dataclass(frozen=True)
class OwnerAccounting:
    """Visual evidence only; support_fraction is absent for fully hidden owners."""

    owner_id: str
    visible_feature_share: float
    matched_feature_share: float
    match_cost: float
    unmatched_visible_cost: float
    support_fraction: Optional[float]


@dataclass(frozen=True)
class CorrespondenceScore:
    total_cost: float
    normalized_cost: float
    match_cost: float
    unmatched_visible_prediction_cost: float
    unmatched_observation_cost: float
    normalization_evidence: float
    matches: Tuple[CorrespondenceMatch, ...]
    unmatched_predicted_token_ids: Tuple[str, ...]
    unmatched_observed_token_ids: Tuple[str, ...]
    per_owner: Tuple[OwnerAccounting, ...]
    visible_prediction_count: int
    observed_count: int


@dataclass(frozen=True)
class _PredictionGroup:
    token_ids: Tuple[str, ...]
    owner_ids: Tuple[str, ...]
    position: Point2
    tangent: Point2
    visible: bool
    feature_kind: str
    material_class: Optional[str]


def _finite_pair(value: Sequence[float], label: str) -> Point2:
    if len(value) != 2:
        raise ValueError(f"{label} must contain exactly two coordinates")
    pair = (float(value[0]), float(value[1]))
    if not all(math.isfinite(item) for item in pair):
        raise ValueError(f"{label} must be finite")
    return pair


def _unit_tangent(value: Sequence[float], label: str) -> Point2:
    tangent = _finite_pair(value, label)
    norm = math.hypot(*tangent)
    if norm <= 0.0:
        raise ValueError(f"{label} must be non-zero")
    return (tangent[0] / norm, tangent[1] / norm)


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _validate_config(config: CorrespondenceConfig) -> None:
    finite_nonnegative = (
        "max_distance_sigma", "distance_weight", "tangent_weight",
        "kind_mismatch_cost", "material_mismatch_cost",
        "unmatched_visible_prediction_cost", "unmatched_observation_cost",
        "seam_position_tolerance", "seam_tangent_tolerance",
    )
    for name in finite_nonnegative:
        value = float(getattr(config, name))
        if not math.isfinite(value) or value < 0.0:
            raise ValueError(f"{name} must be finite and non-negative")
    if config.max_distance_sigma <= 0.0:
        raise ValueError("max_distance_sigma must be positive")
    if (not isinstance(config.max_neighbors_per_prediction, int)
            or config.max_neighbors_per_prediction <= 0):
        raise ValueError("max_neighbors_per_prediction must be a positive integer")


def _prepare_predictions(tokens: Iterable[PredictedFeatureToken],
                         config: CorrespondenceConfig) -> Tuple[_PredictionGroup, ...]:
    prepared = []
    seen_ids = set()
    for token in tokens:
        token_id = _text(token.token_id, "predicted token_id")
        if token_id in seen_ids:
            raise ValueError(f"duplicate predicted token_id: {token_id}")
        seen_ids.add(token_id)
        owners = tuple(_text(owner, "owner_id") for owner in token.owner_ids)
        if not owners or len(set(owners)) != len(owners):
            raise ValueError(f"{token_id} must have non-empty, distinct owner_ids")
        shared = token.shared_boundary_id
        if shared is not None:
            _text(shared, "shared_boundary_id")
        prepared.append((token, token_id, tuple(sorted(owners)),
                         _finite_pair(token.position, f"{token_id} position"),
                         _unit_tangent(token.tangent, f"{token_id} tangent")))

    by_key = {}
    for token, token_id, owners, position, tangent in prepared:
        key = ("shared", token.shared_boundary_id) if token.shared_boundary_id else ("token", token_id)
        by_key.setdefault(key, []).append((token, token_id, owners, position, tangent))

    groups = []
    for key in sorted(by_key, key=lambda item: (item[0], item[1])):
        members = sorted(by_key[key], key=lambda item: item[1])
        first, _, _, position, tangent = members[0]
        owners = set()
        for token, token_id, token_owners, other_position, other_tangent in members:
            same_tangent = 1.0 - abs(float(np.dot(tangent, other_tangent)))
            if (math.dist(position, other_position) > config.seam_position_tolerance
                    or same_tangent > config.seam_tangent_tolerance
                    or token.visible != first.visible
                    or token.feature_kind != first.feature_kind
                    or token.material_class != first.material_class):
                raise ValueError(f"inconsistent shared boundary metadata at {token_id}")
            owners.update(token_owners)
        groups.append(_PredictionGroup(
            token_ids=tuple(member[1] for member in members), owner_ids=tuple(sorted(owners)),
            position=position, tangent=tangent, visible=bool(first.visible),
            feature_kind=_text(first.feature_kind, "feature_kind"),
            material_class=first.material_class))
    return tuple(groups)


def _prepare_observations(tokens: Iterable[ObservedFeatureToken]):
    prepared = []
    seen_ids = set()
    for token in tokens:
        token_id = _text(token.token_id, "observed token_id")
        if token_id in seen_ids:
            raise ValueError(f"duplicate observed token_id: {token_id}")
        seen_ids.add(token_id)
        uncertainty = float(token.uncertainty)
        annotation = float(token.annotation_probability)
        if not math.isfinite(uncertainty) or uncertainty <= 0.0:
            raise ValueError(f"{token_id} uncertainty must be finite and positive")
        if not math.isfinite(annotation) or not 0.0 <= annotation <= 1.0:
            raise ValueError(f"{token_id} annotation_probability must be in [0, 1]")
        prepared.append((token_id, _finite_pair(token.position, f"{token_id} position"),
                         _unit_tangent(token.tangent, f"{token_id} tangent"), uncertainty,
                         _text(token.feature_kind, "feature_kind"), token.material_class, annotation))
    return tuple(sorted(prepared, key=lambda item: item[0]))


def score_correspondence(
    predicted: Iterable[PredictedFeatureToken],
    observed: Iterable[ObservedFeatureToken],
    config: CorrespondenceConfig = CorrespondenceConfig(),
) -> CorrespondenceScore:
    """Return a deterministic minimum-cost exclusive feature correspondence."""
    _validate_config(config)
    predictions = _prepare_predictions(predicted, config)
    observations = _prepare_observations(observed)
    visible = tuple(group for group in predictions if group.visible)
    owner_ids = sorted({owner for group in predictions for owner in group.owner_ids})

    observation_penalties = np.asarray([
        config.unmatched_observation_cost * (1.0 - item[6]) for item in observations
    ], dtype=float)
    matched_by_row = {}
    if visible and observations:
        points = np.asarray([item[1] for item in observations], dtype=float)
        max_radius = config.max_distance_sigma * max(item[3] for item in observations)
        tree = cKDTree(points)
        edges = []
        edge_details = {}
        for row, prediction in enumerate(visible):
            candidates = tree.query_ball_point(prediction.position, max_radius)
            eligible = []
            for column in candidates:
                observation = observations[column]
                distance_sigma = math.dist(prediction.position, observation[1]) / observation[3]
                if distance_sigma <= config.max_distance_sigma:
                    eligible.append((distance_sigma, observation[0], column))
            eligible.sort()
            for distance_sigma, _, column in eligible[:config.max_neighbors_per_prediction]:
                observation = observations[column]
                tangent_residual = 1.0 - abs(float(np.dot(prediction.tangent, observation[2])))
                cost = (config.distance_weight * distance_sigma
                        + config.tangent_weight * tangent_residual
                        + config.kind_mismatch_cost
                        * (prediction.feature_kind != observation[4])
                        + config.material_mismatch_cost
                        * (prediction.material_class is not None
                           and observation[5] is not None
                           and prediction.material_class != observation[5]))
                adjusted = cost - observation_penalties[column]
                edges.append((row, column, adjusted))
                edge_details[(row, column)] = (cost, distance_sigma, tangent_residual)

        # Every row has its own unmatched column.  A common positive shift avoids
        # sparse zero entries and does not change the optimum (one edge per row).
        raw_costs = [edge[2] for edge in edges]
        raw_costs.extend([config.unmatched_visible_prediction_cost] * len(visible))
        shift = max(1.0, 1.0 - min(raw_costs))
        rows, columns, data = [], [], []
        for row, column, cost in edges:
            rows.append(row); columns.append(column); data.append(cost + shift)
        for row in range(len(visible)):
            rows.append(row); columns.append(len(observations) + row)
            data.append(config.unmatched_visible_prediction_cost + shift)
        graph = coo_matrix((data, (rows, columns)),
                           shape=(len(visible), len(observations) + len(visible))).tocsr()
        matched_rows, matched_columns = min_weight_full_bipartite_matching(graph)
        for row, column in zip(matched_rows.tolist(), matched_columns.tolist()):
            if column < len(observations):
                matched_by_row[row] = (column, edge_details[(row, column)])

    matches = []
    matched_observations = set()
    unmatched_predictions = []
    owner_values = {owner: [0.0, 0.0, 0.0, 0.0] for owner in owner_ids}
    for row, prediction in enumerate(visible):
        share = 1.0 / len(prediction.owner_ids)
        for owner in prediction.owner_ids:
            owner_values[owner][0] += share
        if row not in matched_by_row:
            unmatched_predictions.extend(prediction.token_ids)
            for owner in prediction.owner_ids:
                owner_values[owner][3] += config.unmatched_visible_prediction_cost * share
            continue
        column, (cost, distance_sigma, tangent_residual) = matched_by_row[row]
        matched_observations.add(column)
        for owner in prediction.owner_ids:
            owner_values[owner][1] += share
            owner_values[owner][2] += cost * share
        matches.append(CorrespondenceMatch(
            predicted_token_ids=prediction.token_ids,
            observed_token_id=observations[column][0], owner_ids=prediction.owner_ids,
            cost=float(cost), distance_sigma=float(distance_sigma),
            tangent_residual=float(tangent_residual)))

    match_cost = sum(match.cost for match in matches)
    unmatched_prediction_cost = (len(visible) - len(matches)) * config.unmatched_visible_prediction_cost
    unmatched_observation_indices = [
        index for index in range(len(observations)) if index not in matched_observations
    ]
    unmatched_observation_cost = float(observation_penalties[unmatched_observation_indices].sum())
    total = float(match_cost + unmatched_prediction_cost + unmatched_observation_cost)
    evidence = float(len(visible) + observation_penalties.sum()
                     / config.unmatched_observation_cost) if config.unmatched_observation_cost else float(len(visible))
    normalized = total / evidence if evidence else 0.0
    per_owner = []
    for owner in owner_ids:
        visible_share, matched_share, owner_match_cost, owner_unmatched_cost = owner_values[owner]
        per_owner.append(OwnerAccounting(
            owner_id=owner, visible_feature_share=visible_share,
            matched_feature_share=matched_share, match_cost=owner_match_cost,
            unmatched_visible_cost=owner_unmatched_cost,
            support_fraction=(matched_share / visible_share if visible_share else None)))

    return CorrespondenceScore(
        total_cost=total, normalized_cost=float(normalized), match_cost=float(match_cost),
        unmatched_visible_prediction_cost=float(unmatched_prediction_cost),
        unmatched_observation_cost=unmatched_observation_cost,
        normalization_evidence=evidence,
        matches=tuple(sorted(matches, key=lambda item: item.predicted_token_ids)),
        unmatched_predicted_token_ids=tuple(sorted(unmatched_predictions)),
        unmatched_observed_token_ids=tuple(observations[index][0]
                                           for index in unmatched_observation_indices),
        per_owner=tuple(per_owner), visible_prediction_count=len(visible),
        observed_count=len(observations))


__all__ = [
    "PredictedFeatureToken", "ObservedFeatureToken", "CorrespondenceConfig",
    "CorrespondenceMatch", "OwnerAccounting", "CorrespondenceScore",
    "score_correspondence",
]
