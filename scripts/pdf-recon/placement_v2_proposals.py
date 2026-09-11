"""Drawing-driven 3-D translation proposals for fixed cameras and part rotation.

For one calibrated view, feature matches constrain translation in the camera
image plane and leave a one-dimensional camera-nullspace coordinate.  This
module reports that ambiguity directly.  It never invents a scene-size bound:
the optional depth interval is caller evidence, and its provenance is retained.
Connector witnesses instantiate discrete poses only when they agree with both
the drawing and that interval.  Multiple nonparallel calibrated views may
instead resolve a full-rank translation by triangulation.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Optional, Sequence, Tuple

import numpy as np


Vector2 = Tuple[float, float]
Vector3 = Tuple[float, float, float]
Matrix3 = Tuple[Tuple[float, float, float], ...]


@dataclass(frozen=True)
class FeatureMatch:
    match_id: str
    part_point: Vector3
    image_point: Vector2
    uncertainty: float = 1.0
    observation_id: Optional[str] = None
    predicted_feature_id: Optional[str] = None


@dataclass(frozen=True)
class DepthInterval:
    minimum: float
    maximum: float
    provenance: str


@dataclass(frozen=True)
class ConnectorTranslationWitness:
    witness_id: str
    translation: Vector3
    provenance: str = "connector_mate"


@dataclass(frozen=True)
class TranslationDomain:
    base_translation: Vector3
    nullspace_direction: Vector3
    depth_interval: Optional[DepthInterval]
    covariance: Matrix3
    normalized_residual_rms: float
    rank: int
    match_ids: Tuple[str, ...]


@dataclass(frozen=True)
class PoseHypothesis:
    translation: Vector3
    rotation: Matrix3
    normalized_residual_rms: float
    match_ids: Tuple[str, ...]
    provenance: Tuple[str, ...]
    connector_witness_id: Optional[str] = None


@dataclass(frozen=True)
class RejectedWitness:
    witness_id: str
    reason: str
    image_residual_rms: float
    depth_coordinate: float


@dataclass(frozen=True)
class TranslationLift:
    domain: TranslationDomain
    hypotheses: Tuple[PoseHypothesis, ...]
    rejected_witnesses: Tuple[RejectedWitness, ...]


@dataclass(frozen=True)
class CalibratedView:
    view_id: str
    projection: Tuple[Tuple[float, float, float], Tuple[float, float, float]]
    matches: Tuple[FeatureMatch, ...]
    image_offset: Vector2 = (0.0, 0.0)


@dataclass(frozen=True)
class TriangulatedTranslation:
    translation: Vector3
    covariance: Matrix3
    normalized_residual_rms: float
    rank: int
    view_ids: Tuple[str, ...]
    match_ids: Tuple[str, ...]


def _identifier(value, label):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _array(value, shape, label):
    result = np.asarray(value, dtype=float)
    if result.shape != shape or not np.isfinite(result).all():
        raise ValueError(f"{label} must be a finite array with shape {shape}")
    return result


def _rotation(value):
    result = _array(value, (3, 3), "rotation")
    if (not np.allclose(result.T @ result, np.eye(3), atol=1e-7, rtol=0)
            or np.linalg.det(result) < 1.0 - 1e-7):
        raise ValueError("rotation must be a proper orthonormal 3x3 matrix")
    return result


def _matches(values: Iterable[FeatureMatch]):
    result, seen = [], set()
    for match in values:
        match_id = _identifier(match.match_id, "match_id")
        if match_id in seen:
            raise ValueError(f"duplicate match_id: {match_id}")
        seen.add(match_id)
        uncertainty = float(match.uncertainty)
        if not math.isfinite(uncertainty) or uncertainty <= 0:
            raise ValueError(f"{match_id} uncertainty must be finite and positive")
        result.append((match_id, _array(match.part_point, (3,), f"{match_id} part_point"),
                       _array(match.image_point, (2,), f"{match_id} image_point"),
                       uncertainty, match.observation_id, match.predicted_feature_id))
    if not result:
        raise ValueError("at least one feature match is required")
    return tuple(sorted(result, key=lambda item: item[0]))


def _system(matches, projection, rotation, image_offset):
    rows, targets = [], []
    for _, point, image, uncertainty, _, _ in matches:
        rows.append(projection / uncertainty)
        targets.append((image - image_offset - projection @ (rotation @ point)) / uncertainty)
    return np.vstack(rows), np.concatenate(targets)


def _solve(a, b):
    translation, _, rank, _ = np.linalg.lstsq(a, b, rcond=None)
    residual = a @ translation - b
    rms = float(np.sqrt(np.mean(residual ** 2)))
    covariance = np.linalg.pinv(a.T @ a, hermitian=True)
    return translation, int(rank), rms, covariance


def _tuple3(value):
    return tuple(float(item) for item in value)


def _matrix3(value):
    return tuple(tuple(float(item) for item in row) for row in value)


def _canonical_nullspace(projection):
    _, _, vh = np.linalg.svd(projection, full_matrices=True)
    direction = vh[-1].copy()
    pivot = int(np.argmax(np.abs(direction)))
    if direction[pivot] < 0:
        direction *= -1
    direction /= np.linalg.norm(direction)
    return direction


def lift_translation(
    matches: Iterable[FeatureMatch],
    projection: Sequence[Sequence[float]],
    rotation: Sequence[Sequence[float]],
    image_offset: Sequence[float] = (0.0, 0.0),
    depth_interval: Optional[DepthInterval] = None,
    connector_witnesses: Iterable[ConnectorTranslationWitness] = (),
    image_residual_tolerance: float = 1.0,
) -> TranslationLift:
    """Lift one-view image matches to ``t0 + d * camera_nullspace``.

    ``depth_interval`` bounds scalar ``d`` relative to the returned minimum-norm
    ``base_translation``.  With no interval the domain remains explicitly
    unbounded and connector witnesses are checked only against image evidence.
    """
    projection_array = _array(projection, (2, 3), "projection")
    if np.linalg.matrix_rank(projection_array) != 2:
        raise ValueError("projection must have rank 2")
    rotation_array = _rotation(rotation)
    offset_array = _array(image_offset, (2,), "image_offset")
    match_rows = _matches(matches)
    tolerance = float(image_residual_tolerance)
    if not math.isfinite(tolerance) or tolerance < 0:
        raise ValueError("image_residual_tolerance must be finite and non-negative")
    if depth_interval is not None:
        low, high = float(depth_interval.minimum), float(depth_interval.maximum)
        if (not math.isfinite(low) or not math.isfinite(high) or low > high
                or not isinstance(depth_interval.provenance, str)
                or not depth_interval.provenance):
            raise ValueError("depth_interval needs finite ordered bounds and provenance")
        interval = DepthInterval(low, high, depth_interval.provenance)
    else:
        interval = None

    a, b = _system(match_rows, projection_array, rotation_array, offset_array)
    base, rank, residual_rms, covariance = _solve(a, b)
    if rank != 2:
        raise ValueError("single-view feature system does not constrain both image directions")
    nullspace = _canonical_nullspace(projection_array)
    match_ids = tuple(item[0] for item in match_rows)
    domain = TranslationDomain(_tuple3(base), _tuple3(nullspace), interval,
                               _matrix3(covariance), residual_rms, rank, match_ids)

    hypotheses, rejected, seen_witnesses = [], [], set()
    witness_rows = []
    for witness in connector_witnesses:
        witness_id = _identifier(witness.witness_id, "witness_id")
        if witness_id in seen_witnesses:
            raise ValueError(f"duplicate witness_id: {witness_id}")
        seen_witnesses.add(witness_id)
        witness_rows.append((witness_id, witness))
    for witness_id, witness in sorted(witness_rows):
        translation = _array(witness.translation, (3,), f"{witness_id} translation")
        provenance = _identifier(witness.provenance, "witness provenance")
        depth = float(np.dot(translation - base, nullspace))
        witness_residual = a @ translation - b
        witness_rms = float(np.sqrt(np.mean(witness_residual ** 2)))
        if interval is not None and not interval.minimum <= depth <= interval.maximum:
            rejected.append(RejectedWitness(witness_id, "outside_depth_interval",
                                            witness_rms, depth))
        elif witness_rms > tolerance:
            rejected.append(RejectedWitness(witness_id, "image_residual",
                                            witness_rms, depth))
        else:
            provenance_rows = ("drawing_feature_matches", provenance)
            if interval is not None:
                provenance_rows += (interval.provenance,)
            hypotheses.append(PoseHypothesis(
                _tuple3(translation), _matrix3(rotation_array), witness_rms,
                match_ids, provenance_rows, witness_id))
    return TranslationLift(domain, tuple(hypotheses), tuple(rejected))


def triangulate_translation(
    views: Iterable[CalibratedView],
    rotation: Sequence[Sequence[float]],
) -> TriangulatedTranslation:
    """Solve translation across calibrated views, rejecting unresolved depth."""
    rotation_array = _rotation(rotation)
    prepared = tuple(views)
    if len(prepared) < 2:
        raise ValueError("at least two calibrated views are required")
    for view in prepared:
        _identifier(view.view_id, "view_id")
    prepared = sorted(prepared, key=lambda item: item.view_id)
    seen_views, seen_matches, systems, targets, match_ids = set(), set(), [], [], []
    for view in prepared:
        view_id = _identifier(view.view_id, "view_id")
        if view_id in seen_views:
            raise ValueError(f"duplicate view_id: {view_id}")
        seen_views.add(view_id)
        projection = _array(view.projection, (2, 3), f"{view_id} projection")
        if np.linalg.matrix_rank(projection) != 2:
            raise ValueError(f"{view_id} projection must have rank 2")
        offset = _array(view.image_offset, (2,), f"{view_id} image_offset")
        rows = _matches(view.matches)
        for row in rows:
            qualified_id = f"{view_id}:{row[0]}"
            if qualified_id in seen_matches:
                raise ValueError(f"duplicate qualified match_id: {qualified_id}")
            seen_matches.add(qualified_id); match_ids.append(qualified_id)
        a, b = _system(rows, projection, rotation_array, offset)
        systems.append(a); targets.append(b)
    a, b = np.vstack(systems), np.concatenate(targets)
    translation, rank, residual_rms, covariance = _solve(a, b)
    if rank != 3:
        raise ValueError("calibrated views are rank deficient and do not resolve depth")
    return TriangulatedTranslation(
        _tuple3(translation), _matrix3(covariance), residual_rms, rank,
        tuple(view.view_id for view in prepared), tuple(match_ids))


__all__ = [
    "FeatureMatch", "DepthInterval", "ConnectorTranslationWitness",
    "TranslationDomain", "PoseHypothesis", "RejectedWitness", "TranslationLift",
    "CalibratedView", "TriangulatedTranslation", "lift_translation",
    "triangulate_translation",
]
