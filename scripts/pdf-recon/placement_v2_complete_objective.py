"""Reusable exact complete-assembly objective from the sealed placement-v2 v8 run.

The scorer renders every proposed complete assembly on one declared padded
canvas.  Visible physical-instance boundaries (including actual seams) compete
exclusively for drawing edges, and whole rendered curves compete exclusively
for drawing curves.  It contains no proposal logic, reference assembly, VLM,
or filesystem knowledge and is suitable as a callback in bounded enumeration.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import math
from typing import Any, Mapping, Optional, Sequence, Tuple

import numpy as np

from placement_v2_correspondence import (
    CorrespondenceConfig,
    CorrespondenceScore,
    score_correspondence,
)
from placement_v2_curves import curve_observations, score_curves
from placement_v2_observations import instance_owner, observed_tokens, predicted_tokens


Item = Tuple[str, int, np.ndarray]


@dataclass(frozen=True)
class CompleteObjectiveConfig:
    """Canonical v8 objective declaration; constants are not fixture-tuned."""

    protocol: str = "placement-v2-complete-objective-v1"
    padding_spacing: int = 3
    max_padded_dimension: int = 4096
    padding_background: int = 245
    edge_spacing: int = 3
    observation_uncertainty: float = 1.5
    correspondence: CorrespondenceConfig = field(default_factory=lambda: CorrespondenceConfig(
        kind_mismatch_cost=4.0))
    curve_unmatched_cost: float = 2.0
    max_curves: int = 512
    edge_weight_with_curves: float = 0.5
    curve_weight_with_curves: float = 0.5


@dataclass(frozen=True)
class CompleteRenderBuffers:
    """Renderer-independent buffers needed by the declared objective."""

    outline_rgb: np.ndarray
    mask: np.ndarray
    triangle_owner: np.ndarray
    triangle_counts: Tuple[int, ...]
    evidence: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CompleteObjectiveScore:
    normalized_cost: float
    edge: CorrespondenceScore
    curves: Mapping[str, Any]
    edge_weight: float
    curve_weight: float
    predicted_token_count: int
    predicted_curve_count: int
    visible_owner_ids: Tuple[str, ...]
    hidden_owner_ids: Tuple[str, ...]
    padding: Mapping[str, Any]
    config: Mapping[str, Any]
    raster_evidence: Mapping[str, Any]

    @property
    def components(self) -> Mapping[str, Any]:
        return {
            "edge_normalized_cost": self.edge.normalized_cost,
            "curve_normalized_cost": self.curves["normalized_cost"],
            "edge_weight": self.edge_weight,
            "curve_weight": self.curve_weight,
        }


def _validate_config(config: CompleteObjectiveConfig) -> None:
    if not isinstance(config.protocol, str) or not config.protocol:
        raise ValueError("protocol must be a non-empty string")
    integers = ("padding_spacing", "max_padded_dimension", "padding_background",
                "edge_spacing", "max_curves")
    for name in integers:
        value = getattr(config, name)
        if not isinstance(value, int):
            raise ValueError(f"{name} must be an integer")
    if config.padding_spacing <= 0 or config.max_padded_dimension <= 0:
        raise ValueError("padding spacing and maximum dimension must be positive")
    if config.edge_spacing <= 0 or config.max_curves <= 0:
        raise ValueError("edge spacing and maximum curves must be positive")
    if not 0 <= config.padding_background <= 255:
        raise ValueError("padding_background must be in [0, 255]")
    if not math.isfinite(config.observation_uncertainty) or config.observation_uncertainty <= 0:
        raise ValueError("observation_uncertainty must be positive and finite")
    weights = (config.edge_weight_with_curves, config.curve_weight_with_curves)
    if not all(math.isfinite(value) and value >= 0 for value in weights):
        raise ValueError("objective weights must be finite and non-negative")
    if not math.isclose(sum(weights), 1.0, abs_tol=1e-12, rel_tol=0):
        raise ValueError("edge and curve weights must sum to one")
    if not math.isfinite(config.curve_unmatched_cost) or config.curve_unmatched_cost <= 0:
        raise ValueError("curve_unmatched_cost must be positive and finite")


def _camera(camera):
    if not isinstance(camera, Mapping) or "projection" not in camera or "origin" not in camera:
        raise ValueError("camera must declare projection and origin")
    projection = np.asarray(camera["projection"], dtype=float)
    origin = np.asarray(camera["origin"], dtype=float)
    if projection.shape != (2, 3) or origin.shape != (2,):
        raise ValueError("camera projection/origin shapes must be (2, 3)/(2,)")
    if not np.isfinite(projection).all() or not np.isfinite(origin).all():
        raise ValueError("camera projection and origin must be finite")
    return projection, origin, camera.get("padding")


def _items(items: Sequence[tuple], label: str) -> Tuple[Item, ...]:
    result = []
    for index, item in enumerate(items):
        if not isinstance(item, (tuple, list)) or len(item) != 3:
            raise ValueError(f"{label}[{index}] must be a part/color/transform triple")
        part, color, transform = item
        matrix = np.asarray(transform, dtype=float)
        if not isinstance(part, str) or not part or not isinstance(color, (int, np.integer)):
            raise ValueError(f"{label}[{index}] part/color is invalid")
        if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
            raise ValueError(f"{label}[{index}] transform must be finite 4x4")
        result.append((part, int(color), matrix))
    return tuple(result)


def _padding(scene, bounds, config, declared=None):
    rgb, mask = np.asarray(scene["rgb"]), np.asarray(scene["mask"])
    if rgb.ndim != 3 or rgb.shape[2] != 3 or mask.shape != rgb.shape[:2]:
        raise ValueError("scene must contain matching RGB and mask arrays")
    bounds = np.asarray(bounds, dtype=float).reshape(-1, 4)
    if not len(bounds) or not np.isfinite(bounds).all():
        raise ValueError("coverage must have finite projected bounds")
    height, width = mask.shape
    low = np.minimum(bounds[:, :2].min(axis=0), (0.0, 0.0))
    high = np.maximum(bounds[:, 2:].max(axis=0), (float(width), float(height)))
    spacing = config.padding_spacing
    left = int(math.ceil(max(0.0, -low[0]) / spacing) * spacing)
    top = int(math.ceil(max(0.0, -low[1]) / spacing) * spacing)
    right = int(math.ceil(max(0.0, high[0] - width) / spacing) * spacing)
    bottom = int(math.ceil(max(0.0, high[1] - height) / spacing) * spacing)
    minimum = (left, top, right, bottom)
    if declared is not None:
        try:
            supplied = tuple(int(value) for value in declared["padding"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("declared camera padding is invalid") from exc
        if (len(supplied) != 4 or any(value < 0 for value in supplied)
                or any(value % spacing for value in supplied)):
            raise ValueError("declared camera padding must be four non-negative spacing multiples")
        if any(actual < needed for actual, needed in zip(supplied, minimum)):
            raise ValueError("declared camera padding does not cover the candidate domain")
        left, top, right, bottom = supplied
    padded_width, padded_height = width + left + right, height + top + bottom
    record = {
        "native_size": [width, height], "padding": [left, top, right, bottom],
        "padded_size": [padded_width, padded_height], "spacing": spacing,
        "max_dimension": config.max_padded_dimension,
        "projected_union_bounds": [float(low[0]), float(low[1]),
                                   float(high[0]), float(high[1])],
    }
    if max(padded_width, padded_height) > config.max_padded_dimension:
        raise ValueError("declared coverage exceeds max_padded_dimension")
    if declared is not None:
        if (list(declared.get("native_size", ())) != [width, height]
                or list(declared.get("padded_size", ())) != [padded_width, padded_height]
                or int(declared.get("spacing", -1)) != spacing
                or bool(declared.get("refused", False))):
            raise ValueError("declared camera padding metadata disagrees with the scene/config")
    padded = dict(scene)
    padded_rgb = np.full((padded_height, padded_width, 3), config.padding_background,
                         dtype=rgb.dtype)
    padded_mask = np.zeros((padded_height, padded_width), dtype=mask.dtype)
    padded_rgb[top:top + height, left:left + width] = rgb
    padded_mask[top:top + height, left:left + width] = mask
    padded["rgb"], padded["mask"] = padded_rgb, padded_mask
    return padded, record


class FeatureEdgeRenderBackend:
    """Adapter around the production raster renderer used by sealed v8."""

    def create_renderer(self, scene):
        from placement_feature_edges import FeatureEdgeScorer
        return FeatureEdgeScorer(scene, span_tolerance=float("inf"), plane_depth=True)

    def projected_bounds(self, renderer, items, projection, origin):
        bounds = []
        for part, color, transform in items:
            projected = renderer._project_part(part, color, transform, projection)
            offset = projection @ transform[:3, 3] + origin
            low = np.asarray(projected["lo"], float) + offset
            high = np.asarray(projected["hi"], float) + offset
            bounds.append((*low.tolist(), *high.tolist()))
        return tuple(bounds)

    def render(self, renderer, items, projection, origin):
        from placement_mixed_batch_search import fixed_native_score
        evidence = fixed_native_score(renderer, items, projection, origin)
        counts = tuple(len(renderer.geometry[(part, str(color))]["triangles"])
                       for part, color, _ in items)
        return CompleteRenderBuffers(
            outline_rgb=np.asarray(renderer.last_outline),
            mask=np.asarray(renderer.last_layer["mask"][0]),
            triangle_owner=np.asarray(renderer.last_layer["owner"][0]),
            triangle_counts=counts,
            evidence=evidence,
        )


class CompleteObjectiveScorer:
    """Build once and score complete item lists on a fixed bounded canvas."""

    def __init__(self, scene, base, camera, coverage_items, *,
                 config: CompleteObjectiveConfig = CompleteObjectiveConfig(), backend=None):
        _validate_config(config)
        self.config = config
        self.projection, self.native_origin, declared_padding = _camera(camera)
        self.base = _items(base, "base")
        coverage = _items(coverage_items, "coverage_items")
        if not self.base and not coverage:
            raise ValueError("base plus coverage_items must be non-empty")
        self.backend = backend or FeatureEdgeRenderBackend()
        native_renderer = self.backend.create_renderer(scene)
        bounds = self.backend.projected_bounds(
            native_renderer, self.base + coverage, self.projection, self.native_origin)
        padded_scene, self.padding = _padding(scene, bounds, config, declared_padding)
        self.pad = np.asarray(self.padding["padding"][:2], dtype=float)
        self.padded_origin = self.native_origin + self.pad
        self.renderer = self.backend.create_renderer(padded_scene)
        self.observations = tuple(observed_tokens(
            scene["rgb"], scene["mask"], spacing=config.edge_spacing,
            uncertainty=config.observation_uncertainty))
        self.target_curves = tuple(curve_observations(scene["rgb"], scene["mask"]))

    def __call__(self, complete_items) -> CompleteObjectiveScore:
        items = _items(complete_items, "complete_items")
        if not items:
            raise ValueError("complete_items must be non-empty")
        bounds = self.backend.projected_bounds(
            self.renderer, items, self.projection, self.native_origin)
        low = np.asarray(bounds, float)[:, :2].min(axis=0) + self.pad
        high = np.asarray(bounds, float)[:, 2:].max(axis=0) + self.pad
        width, height = self.padding["padded_size"]
        if np.any(low < 0) or np.any(high > (width, height)):
            raise ValueError("complete_items fall outside declared coverage padding")
        rendered = self.backend.render(
            self.renderer, items, self.projection, self.padded_origin)
        owner = instance_owner(rendered.triangle_owner, rendered.triangle_counts)
        tokens, buffers = predicted_tokens(
            rendered.outline_rgb, rendered.mask, owner,
            spacing=self.config.edge_spacing, include_seams=True)
        shifted_tokens = tuple(type(token)(
            token_id=token.token_id, owner_ids=token.owner_ids,
            position=tuple(np.asarray(token.position, float) - self.pad),
            tangent=token.tangent, visible=token.visible,
            shared_boundary_id=token.shared_boundary_id,
            feature_kind=token.feature_kind, material_class=token.material_class)
            for token in tokens)
        edge = score_correspondence(
            shifted_tokens, self.observations, self.config.correspondence)
        curves = curve_observations(buffers["outline"], rendered.mask)
        curves = [dict(curve, center=(np.asarray(curve["center"], float) - self.pad).tolist())
                  for curve in curves]
        curve_score = score_curves(
            curves, self.target_curves, unmatched_cost=self.config.curve_unmatched_cost,
            max_curves=self.config.max_curves)
        if self.target_curves:
            edge_weight = self.config.edge_weight_with_curves
            curve_weight = self.config.curve_weight_with_curves
        else:
            edge_weight, curve_weight = 1.0, 0.0
        normalized = (edge_weight * edge.normalized_cost
                      + curve_weight * curve_score["normalized_cost"])
        visible = tuple(sorted({owner_id for token in shifted_tokens
                                for owner_id in token.owner_ids}))
        all_owners = tuple(f"part:{index}" for index in range(len(items)))
        hidden = tuple(owner_id for owner_id in all_owners if owner_id not in set(visible))
        if not math.isfinite(normalized):
            raise ValueError("complete objective produced a non-finite score")
        return CompleteObjectiveScore(
            normalized_cost=float(normalized), edge=edge, curves=curve_score,
            edge_weight=edge_weight, curve_weight=curve_weight,
            predicted_token_count=len(shifted_tokens), predicted_curve_count=len(curves),
            visible_owner_ids=visible, hidden_owner_ids=hidden,
            padding=dict(self.padding), config=asdict(self.config),
            raster_evidence=dict(rendered.evidence))


def score_complete_objective(scene, base, camera, complete_items, *, coverage_items=None,
                             config: CompleteObjectiveConfig = CompleteObjectiveConfig(),
                             backend=None):
    """One-shot convenience wrapper; reuse ``CompleteObjectiveScorer`` in search."""
    coverage = complete_items if coverage_items is None else coverage_items
    return CompleteObjectiveScorer(
        scene, base, camera, coverage, config=config, backend=backend)(complete_items)


__all__ = [
    "CompleteObjectiveConfig", "CompleteRenderBuffers", "CompleteObjectiveScore",
    "CompleteObjectiveScorer", "FeatureEdgeRenderBackend", "score_complete_objective",
]
