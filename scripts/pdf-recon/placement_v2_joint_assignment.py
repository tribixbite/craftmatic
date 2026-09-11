"""Joint base/new-pose feature ownership through the existing pose MILP.

Each stable base feature becomes an exact-quota choice between a visible
auxiliary pose carrying its feature token group and an empty hidden auxiliary
pose supported by its possible occluders. Visible/occluder conflicts plus
rooted support encode the exact OR: the hidden state is selectable iff at least
one occluding real pose is selected. Auxiliary identities never leave the
public result.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Tuple

from placement_v2_correspondence import (
    CorrespondenceConfig, ObservedFeatureToken, PredictedFeatureToken,
)
from placement_v2_pose_assignment import (
    PoseAssignmentMatch, PoseOption, solve_pose_assignment,
)


_AUX_PREFIX = "__joint_base_aux__:"
_QUOTA_PREFIX = "__joint_base_quota__:"


@dataclass(frozen=True)
class BaseFeature:
    """One deduplicated base feature and the real poses that suppress it."""

    feature_id: str
    tokens: Tuple[PredictedFeatureToken, ...]
    occluding_pose_ids: Tuple[str, ...] = ()


@dataclass(frozen=True)
class BaseAssignmentMatch:
    base_feature_id: str
    predicted_token_ids: Tuple[str, ...]
    observed_token_id: str
    owner_ids: Tuple[str, ...]
    cost: float
    distance_sigma: float
    tangent_residual: float


@dataclass(frozen=True)
class JointPoseAssignmentResult:
    selected_pose_ids: Tuple[str, ...]
    total_cost: float
    optimal: bool
    status: str
    matches: Tuple[PoseAssignmentMatch, ...]
    base_matches: Tuple[BaseAssignmentMatch, ...]
    visible_base_feature_ids: Tuple[str, ...]
    suppressed_base_feature_ids: Tuple[str, ...]
    mip_gap: float | None = None
    solver_message: str = ""


def _text(value, label):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _aux_ids(feature_id):
    return (f"{_AUX_PREFIX}visible:{feature_id}",
            f"{_AUX_PREFIX}hidden:{feature_id}",
            f"{_QUOTA_PREFIX}{feature_id}")


def solve_joint_base_assignment(
    options: Iterable[PoseOption],
    observed: Iterable[ObservedFeatureToken],
    quotas: Mapping[str, int],
    base_features: Iterable[BaseFeature],
    conflicts: Iterable[Tuple[str, str]] = (),
    config: CorrespondenceConfig = CorrespondenceConfig(),
    time_limit: float = 30.0,
    minimum_matches_per_real_pose: int = 1,
) -> JointPoseAssignmentResult:
    """Solve exclusive ownership with conditional fixed-base visibility."""
    real_options = tuple(options)
    features = tuple(base_features)
    real_ids = set()
    real_quota_keys = set(quotas)
    if any(isinstance(key, str) and key.startswith(_QUOTA_PREFIX)
           for key in real_quota_keys):
        raise ValueError("real quotas cannot use the joint-base auxiliary namespace")
    for option in real_options:
        if not isinstance(option, PoseOption):
            raise ValueError("options must contain PoseOption records")
        pose_id = _text(option.pose_id, "real pose_id")
        if pose_id.startswith(_AUX_PREFIX) or pose_id in real_ids:
            raise ValueError(f"reserved or duplicate real pose_id: {pose_id}")
        real_ids.add(pose_id)

    feature_ids = set()
    predicted_ids = set()
    seam_owners = {}
    auxiliary_options = []
    auxiliary_conflicts = []
    visible_lookup = {}
    hidden_lookup = {}
    for feature in features:
        if not isinstance(feature, BaseFeature):
            raise ValueError("base_features must contain BaseFeature records")
        feature_id = _text(feature.feature_id, "base feature_id")
        if feature_id in feature_ids:
            raise ValueError(f"duplicate base feature_id: {feature_id}")
        feature_ids.add(feature_id)
        tokens = tuple(feature.tokens)
        if not tokens:
            raise ValueError(f"base feature {feature_id} must contain tokens")
        token_ids = []
        seam_ids = set()
        for token in tokens:
            if not isinstance(token, PredictedFeatureToken):
                raise ValueError(f"base feature {feature_id} has a non-predicted token")
            token_id = _text(token.token_id, f"{feature_id} token_id")
            if token_id in predicted_ids:
                raise ValueError(f"duplicate base predicted token_id: {token_id}")
            predicted_ids.add(token_id); token_ids.append(token_id)
            seam_ids.add(token.shared_boundary_id)
            if token.shared_boundary_id is not None:
                previous = seam_owners.setdefault(token.shared_boundary_id, feature_id)
                if previous != feature_id:
                    raise ValueError(
                        f"shared boundary {token.shared_boundary_id} is split across base features")
        if len(tokens) > 1 and (None in seam_ids or len(seam_ids) != 1):
            raise ValueError(
                f"base feature {feature_id} tokens must form one shared-boundary group")
        occluders = tuple(_text(value, f"{feature_id} occluding_pose_id")
                          for value in feature.occluding_pose_ids)
        if len(set(occluders)) != len(occluders):
            raise ValueError(f"duplicate occluders for base feature {feature_id}")
        unknown = sorted(set(occluders) - real_ids)
        if unknown:
            raise ValueError(f"unknown occluding pose for {feature_id}: {unknown[0]}")
        visible_id, hidden_id, quota_key = _aux_ids(feature_id)
        if quota_key in real_quota_keys or visible_id in real_ids or hidden_id in real_ids:
            raise ValueError(f"auxiliary namespace collision for base feature {feature_id}")
        visible_lookup[visible_id] = feature_id
        hidden_lookup[hidden_id] = feature_id
        auxiliary_options.append(PoseOption(visible_id, quota_key, tokens, True, ()))
        auxiliary_options.append(PoseOption(hidden_id, quota_key, (), False, occluders))
        auxiliary_conflicts.extend((visible_id, pose_id) for pose_id in occluders)

    real_conflicts = tuple(conflicts)
    for pair in real_conflicts:
        if len(pair) != 2 or any(pose_id not in real_ids for pose_id in pair):
            raise ValueError("joint-base caller conflicts must reference two real poses")
    combined_quotas = dict(quotas)
    for feature_id in feature_ids:
        combined_quotas[_aux_ids(feature_id)[2]] = 1
    combined_conflicts = real_conflicts + tuple(auxiliary_conflicts)
    auxiliary_ids = set(visible_lookup) | set(hidden_lookup)
    minimum_overrides = {pose_id: 0 for pose_id in auxiliary_ids}
    assignment = solve_pose_assignment(
        real_options + tuple(auxiliary_options), observed, combined_quotas,
        conflicts=combined_conflicts, config=config, time_limit=time_limit,
        minimum_matches_per_selected_pose=minimum_matches_per_real_pose,
        minimum_matches_by_pose=minimum_overrides)

    selected = set(assignment.selected_pose_ids)
    leaked = selected - real_ids - auxiliary_ids
    if leaked:
        raise AssertionError(f"unknown solver identities: {sorted(leaked)}")
    visible = tuple(sorted(visible_lookup[pose_id] for pose_id in selected
                           if pose_id in visible_lookup))
    suppressed = tuple(sorted(hidden_lookup[pose_id] for pose_id in selected
                              if pose_id in hidden_lookup))
    if set(visible) | set(suppressed) != feature_ids or set(visible) & set(suppressed):
        raise AssertionError("solver did not choose exactly one state per base feature")
    real_matches = tuple(match for match in assignment.matches if match.pose_id in real_ids)
    base_matches = tuple(BaseAssignmentMatch(
        base_feature_id=visible_lookup[match.pose_id],
        predicted_token_ids=match.predicted_token_ids,
        observed_token_id=match.observed_token_id,
        owner_ids=match.owner_ids,
        cost=match.cost,
        distance_sigma=match.distance_sigma,
        tangent_residual=match.tangent_residual)
        for match in assignment.matches if match.pose_id in visible_lookup)
    if any(match.pose_id in hidden_lookup for match in assignment.matches):
        raise AssertionError("empty hidden base state produced a feature match")
    return JointPoseAssignmentResult(
        selected_pose_ids=tuple(sorted(selected & real_ids)),
        total_cost=assignment.total_cost, optimal=assignment.optimal,
        status=assignment.status, matches=real_matches,
        base_matches=base_matches, visible_base_feature_ids=visible,
        suppressed_base_feature_ids=suppressed, mip_gap=assignment.mip_gap,
        solver_message=assignment.solver_message)


__all__ = [
    "BaseFeature", "BaseAssignmentMatch", "JointPoseAssignmentResult",
    "solve_joint_base_assignment",
]
