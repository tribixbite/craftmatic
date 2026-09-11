"""Joint finite pose selection and exclusive drawing-stroke assignment.

This module consumes only caller-supplied pose hypotheses and drawing feature
tokens.  It neither generates geometry nor reads model/reference data.  Every
supplied pose remains in the MILP; only each predicted feature's sparse
observation neighborhood is capped, deterministically, at 24 edges.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Mapping, Sequence, Tuple

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix
from scipy.spatial import cKDTree

from placement_v2_correspondence import (
    CorrespondenceConfig,
    ObservedFeatureToken,
    PredictedFeatureToken,
    _prepare_observations,
    _prepare_predictions,
    _validate_config,
)


@dataclass(frozen=True)
class PoseOption:
    """One finite pose alternative in an inventory/quota pool."""

    pose_id: str
    quota_key: str
    tokens: Tuple[PredictedFeatureToken, ...]
    base_supported: bool = True
    support_pose_ids: Tuple[str, ...] = ()


@dataclass(frozen=True)
class PoseAssignmentMatch:
    pose_id: str
    predicted_token_ids: Tuple[str, ...]
    observed_token_id: str
    owner_ids: Tuple[str, ...]
    cost: float
    distance_sigma: float
    tangent_residual: float


@dataclass(frozen=True)
class PoseAssignmentResult:
    selected_pose_ids: Tuple[str, ...]
    total_cost: float
    optimal: bool
    status: str
    matches: Tuple[PoseAssignmentMatch, ...]
    mip_gap: float | None = None
    solver_message: str = ""


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _validate_support_graph(options: Sequence[PoseOption], index: Mapping[str, int]) -> None:
    """Validate references; rooted connectivity is enforced by MILP flow."""
    for option in options:
        missing = sorted(set(option.support_pose_ids) - set(index))
        if missing:
            raise ValueError(f"unknown support pose for {option.pose_id}: {missing[0]}")


def solve_pose_assignment(
    options: Iterable[PoseOption],
    observed: Iterable[ObservedFeatureToken],
    quotas: Mapping[str, int],
    conflicts: Iterable[Tuple[str, str]] = (),
    config: CorrespondenceConfig = CorrespondenceConfig(),
    time_limit: float = 30.0,
    minimum_matches_per_selected_pose: int = 0,
    minimum_matches_by_pose: Mapping[str, int] | None = None,
) -> PoseAssignmentResult:
    """Select poses and jointly assign exclusive observed stroke intervals.

    Raises ``ValueError`` when the finite problem is malformed, infeasible, or
    terminates without a feasible integral pose incumbent.  A time-limited
    feasible incumbent is returned with ``optimal=False`` and an explicit
    ``limit_feasible`` status.
    """
    _validate_config(config)
    if config.max_neighbors_per_prediction > 24:
        raise ValueError("max_neighbors_per_prediction cannot exceed 24")
    time_limit = float(time_limit)
    if not math.isfinite(time_limit) or time_limit <= 0:
        raise ValueError("time_limit must be finite and positive")
    if (isinstance(minimum_matches_per_selected_pose, bool)
            or not isinstance(minimum_matches_per_selected_pose, (int, np.integer))
            or minimum_matches_per_selected_pose < 0):
        raise ValueError("minimum_matches_per_selected_pose must be a non-negative integer")
    minimum_matches = int(minimum_matches_per_selected_pose)

    options = tuple(options)
    observations = _prepare_observations(observed)
    pose_index = {}
    prepared = []
    for position, option in enumerate(options):
        if not isinstance(option, PoseOption):
            raise ValueError("options must contain PoseOption records")
        pose_id = _required_text(option.pose_id, "pose_id")
        quota_key = _required_text(option.quota_key, f"{pose_id} quota_key")
        if pose_id in pose_index:
            raise ValueError(f"duplicate pose_id: {pose_id}")
        pose_index[pose_id] = position
        supports = tuple(_required_text(item, f"{pose_id} support_pose_id")
                         for item in option.support_pose_ids)
        if len(set(supports)) != len(supports):
            raise ValueError(f"duplicate support_pose_ids for {pose_id}")
        prepared.append(_prepare_predictions(option.tokens, config))
        if quota_key not in quotas:
            raise ValueError(f"missing quota for key {quota_key}")

    clean_quotas = {}
    for key, value in quotas.items():
        key = _required_text(key, "quota key")
        if isinstance(value, bool) or not isinstance(value, (int, np.integer)) or value < 0:
            raise ValueError(f"quota for {key} must be a non-negative integer")
        clean_quotas[key] = int(value)
    clean_match_overrides = {}
    for pose_id, value in (minimum_matches_by_pose or {}).items():
        pose_id = _required_text(pose_id, "minimum-match override pose_id")
        if pose_id not in pose_index:
            raise ValueError(f"unknown minimum-match override pose: {pose_id}")
        if (isinstance(value, bool) or not isinstance(value, (int, np.integer))
                or value < 0):
            raise ValueError(f"minimum-match override for {pose_id} must be a non-negative integer")
        clean_match_overrides[pose_id] = int(value)
    _validate_support_graph(options, pose_index)

    conflict_rows = []
    seen_conflicts = set()
    for pair in conflicts:
        if len(pair) != 2:
            raise ValueError("each conflict must contain two pose IDs")
        left, right = pair
        if left not in pose_index or right not in pose_index:
            missing = left if left not in pose_index else right
            raise ValueError(f"unknown conflict pose: {missing}")
        canonical = tuple(sorted((left, right)))
        if canonical not in seen_conflicts:
            conflict_rows.append(canonical)
            seen_conflicts.add(canonical)

    # Each row is (pose index, prepared prediction group). Hidden features have
    # no visual cost or confidence and therefore need no assignment variable.
    predictions = []
    for option_index, groups in enumerate(prepared):
        predictions.extend((option_index, group) for group in groups if group.visible)

    observation_penalties = np.asarray([
        config.unmatched_observation_cost * (1.0 - item[6])
        for item in observations
    ], dtype=float)
    edges = []
    observation_tree = None
    search_radius = None
    if observations:
        observation_tree = cKDTree(np.asarray([item[1] for item in observations], dtype=float))
        search_radius = (config.max_distance_sigma
                         * max(item[3] for item in observations))
    for prediction_index, (option_index, prediction) in enumerate(predictions):
        eligible = []
        nearby = (() if observation_tree is None else
                  observation_tree.query_ball_point(prediction.position, search_radius))
        for observation_index in nearby:
            observation = observations[observation_index]
            distance_sigma = math.dist(prediction.position, observation[1]) / observation[3]
            if distance_sigma > config.max_distance_sigma:
                continue
            tangent_residual = 1.0 - abs(float(np.dot(prediction.tangent, observation[2])))
            cost = (config.distance_weight * distance_sigma
                    + config.tangent_weight * tangent_residual
                    + config.kind_mismatch_cost
                    * (prediction.feature_kind != observation[4])
                    + config.material_mismatch_cost
                    * (prediction.material_class is not None
                       and observation[5] is not None
                       and prediction.material_class != observation[5]))
            eligible.append((distance_sigma, observation[0], observation_index,
                             float(cost), float(tangent_residual)))
        eligible.sort()
        for distance_sigma, _, observation_index, cost, tangent_residual in (
                eligible[:config.max_neighbors_per_prediction]):
            edges.append((prediction_index, option_index, observation_index,
                          cost, float(distance_sigma), tangent_residual))

    n_x = len(options)
    n_y = len(edges)
    support_arcs = [
        (pose_index[parent], child_index)
        for child_index, option in enumerate(options) if not option.base_supported
        for parent in option.support_pose_ids
    ]
    source_roots = [i for i, option in enumerate(options) if option.base_supported]
    n_support_flow = len(support_arcs)
    flow_start = n_x + n_y
    source_flow_start = flow_start + n_support_flow
    n_variables = source_flow_start + len(source_roots)
    edges_by_prediction = [[] for _ in predictions]
    edges_by_observation = [[] for _ in observations]
    edges_by_option = [[] for _ in options]
    for edge_index, edge in enumerate(edges):
        edges_by_prediction[edge[0]].append(edge_index)
        edges_by_observation[edge[2]].append(edge_index)
        edges_by_option[edge[1]].append(edge_index)
    constant = float(observation_penalties.sum())
    if n_variables == 0:
        if any(clean_quotas.values()):
            raise ValueError("pose assignment is infeasible: quota has no pose options")
        return PoseAssignmentResult((), constant, True, "optimal", (), 0.0,
                                    "solved without MILP variables")

    objective = np.zeros(n_variables, dtype=float)
    for option_index, _ in predictions:
        objective[option_index] += config.unmatched_visible_prediction_cost
    for edge_index, (_, _, observation_index, cost, _, _) in enumerate(edges):
        objective[n_x + edge_index] = (
            cost - config.unmatched_visible_prediction_cost
            - observation_penalties[observation_index])

    row_indices, columns, data, lower, upper = [], [], [], [], []

    def add_constraint(coefficients, lb, ub):
        row = len(lower)
        for column, value in coefficients:
            row_indices.append(row); columns.append(column); data.append(value)
        lower.append(lb); upper.append(ub)

    # Exact inventory/instance quota selection.
    for key in sorted(clean_quotas):
        add_constraint([(i, 1.0) for i, option in enumerate(options)
                        if option.quota_key == key], clean_quotas[key], clean_quotas[key])
    # A predicted feature can match once and only when its owning pose is selected.
    for prediction_index, (option_index, _) in enumerate(predictions):
        add_constraint([(n_x + edge_index, 1.0)
                        for edge_index in edges_by_prediction[prediction_index]]
                       + [(option_index, -1.0)],
                       -np.inf, 0.0)
    # One drawing interval cannot reward two selected physical features.
    for observation_index in range(len(observations)):
        add_constraint([(n_x + edge_index, 1.0)
                        for edge_index in edges_by_observation[observation_index]],
                       -np.inf, 1.0)
    if minimum_matches or clean_match_overrides:
        for option_index, option in enumerate(options):
            required_matches = clean_match_overrides.get(option.pose_id, minimum_matches)
            if not required_matches:
                continue
            add_constraint([(n_x + edge_index, 1.0)
                            for edge_index in edges_by_option[option_index]]
                           + [(option_index, -float(required_matches))],
                           0.0, np.inf)
    for left, right in conflict_rows:
        add_constraint([(pose_index[left], 1.0), (pose_index[right], 1.0)],
                       -np.inf, 1.0)
    flow_capacity = float(max(1, sum(clean_quotas.values())))
    incoming_flow = [[] for _ in options]
    outgoing_flow = [[] for _ in options]
    for arc_index, (parent_index, child_index) in enumerate(support_arcs):
        variable = flow_start + arc_index
        outgoing_flow[parent_index].append(variable)
        incoming_flow[child_index].append(variable)
        add_constraint([(variable, 1.0), (parent_index, -flow_capacity)],
                       -np.inf, 0.0)
        add_constraint([(variable, 1.0), (child_index, -flow_capacity)],
                       -np.inf, 0.0)
    for root_offset, root_index in enumerate(source_roots):
        variable = source_flow_start + root_offset
        incoming_flow[root_index].append(variable)
        add_constraint([(variable, 1.0), (root_index, -flow_capacity)],
                       -np.inf, 0.0)
    # Each selected node consumes one unit. A rootless component has no source
    # inflow, so summing its balances forces every x in that component to zero.
    for option_index in range(n_x):
        add_constraint([(variable, 1.0) for variable in incoming_flow[option_index]]
                       + [(variable, -1.0) for variable in outgoing_flow[option_index]]
                       + [(option_index, -1.0)], 0.0, 0.0)

    matrix = coo_matrix((data, (row_indices, columns)),
                        shape=(len(lower), n_variables)).tocsr()
    constraints = LinearConstraint(matrix, np.asarray(lower), np.asarray(upper))
    integrality = np.zeros(n_variables, dtype=np.uint8)
    integrality[:n_x] = 1
    upper_bounds = np.ones(n_variables)
    upper_bounds[flow_start:] = flow_capacity
    result = milp(objective, integrality=integrality,
                  bounds=Bounds(np.zeros(n_variables), upper_bounds),
                  constraints=constraints,
                  options={"time_limit": time_limit, "mip_rel_gap": 0.0})

    if result.x is None:
        label = "infeasible" if result.status == 2 else "no feasible integral incumbent"
        raise ValueError(f"pose assignment {label}: {result.message}")
    solution = np.asarray(result.x, dtype=float)
    tolerance = 1e-6
    if (solution.shape != (n_variables,) or not np.all(np.isfinite(solution))
            or np.any(solution < -tolerance)
            or np.any(solution > upper_bounds + tolerance)):
        raise ValueError(f"pose assignment has no feasible bounded incumbent: {result.message}")
    selected_values = solution[:n_x]
    if np.any(np.abs(selected_values - np.rint(selected_values)) > 1e-6):
        raise ValueError(f"pose assignment has no feasible integral incumbent: {result.message}")
    # Although y is declared continuous, its fixed-x bipartite matching polytope
    # has integral vertices. Refuse an interrupted fractional credit rather than
    # silently thresholding it into a different reported correspondence.
    if np.any(np.abs(solution[n_x:n_x + n_y]
                     - np.rint(solution[n_x:n_x + n_y])) > tolerance):
        raise ValueError(f"pose assignment has no integral correspondence incumbent: {result.message}")
    row_values = np.asarray(matrix @ solution, dtype=float).reshape(-1)
    lower_values = np.asarray(lower, dtype=float)
    upper_values = np.asarray(upper, dtype=float)
    if (np.any(row_values < lower_values - tolerance)
            or np.any(row_values > upper_values + tolerance)):
        raise ValueError(f"pose assignment solver returned an infeasible incumbent: {result.message}")
    recomputed_objective = float(objective @ solution)
    if (result.fun is None or not math.isfinite(float(result.fun))
            or not math.isclose(recomputed_objective, float(result.fun),
                                rel_tol=1e-7, abs_tol=1e-7)):
        raise ValueError(f"pose assignment solver returned an inconsistent objective: {result.message}")
    selected_indices = {i for i, value in enumerate(selected_values) if value > 0.5}

    matches = []
    for edge_index, (prediction_index, option_index, observation_index,
                     cost, distance_sigma, tangent_residual) in enumerate(edges):
        if solution[n_x + edge_index] <= 0.5:
            continue
        prediction = predictions[prediction_index][1]
        matches.append(PoseAssignmentMatch(
            pose_id=options[option_index].pose_id,
            predicted_token_ids=prediction.token_ids,
            observed_token_id=observations[observation_index][0],
            owner_ids=prediction.owner_ids,
            cost=cost, distance_sigma=distance_sigma,
            tangent_residual=tangent_residual))
    matches.sort(key=lambda item: (item.pose_id, item.predicted_token_ids,
                                   item.observed_token_id))
    optimal = result.status == 0
    if optimal:
        status = "optimal"
    elif result.status == 1:
        status = "limit_feasible"
    else:
        status = f"solver_status_{result.status}_feasible"
    raw_gap = getattr(result, "mip_gap", None)
    mip_gap = (float(raw_gap) if raw_gap is not None and math.isfinite(float(raw_gap))
               else None)
    return PoseAssignmentResult(
        selected_pose_ids=tuple(sorted(options[i].pose_id for i in selected_indices)),
        total_cost=float(constant + result.fun), optimal=optimal, status=status,
        matches=tuple(matches), mip_gap=mip_gap, solver_message=str(result.message))


__all__ = [
    "PoseOption", "PoseAssignmentMatch", "PoseAssignmentResult",
    "solve_pose_assignment",
]
