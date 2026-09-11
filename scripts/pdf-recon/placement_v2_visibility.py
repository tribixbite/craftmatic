"""Cheap projected-sample visibility against a fixed rendered base layer.

This is soft pre-render ranking evidence only. It samples one base-depth pixel
per supplied projected point; sparse vertices can miss visible triangle faces,
silhouettes, and seams. The result is never a collision or geometry certificate.

Depth follows ``placement_cuda_layers``: larger values are nearer, background
pixels are identified by ``base_mask``, and a later candidate wins an exact
depth tie. ``margin`` tolerates a sample lying slightly behind the base.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence, Tuple

import numpy as np


@dataclass(frozen=True)
class SampleVisibility:
    visible_count: int
    occluded_count: int
    offcanvas_count: int
    visibility_fraction: float


def estimate_sample_visibility(
    sample_xy: Sequence[Sequence[float]],
    sample_depth: Sequence[float],
    base_depth: Sequence[Sequence[float]],
    base_mask: Sequence[Sequence[bool]],
    image_bounds: Tuple[int, int],
    margin: float = 0.0,
) -> SampleVisibility:
    """Classify projected samples using the nearest containing base pixel.

    ``image_bounds`` is ``(width, height)``. Coordinates use the renderer's
    image convention: x increases rightward and y downward. Pixel indices are
    obtained with floor, so the canvas covers ``[0,width) x [0,height)``.
    The returned fraction is visible/all supplied samples; off-canvas samples
    therefore cannot make a candidate rank as more visible.
    """
    xy = np.asarray(sample_xy, dtype=float)
    depths = np.asarray(sample_depth, dtype=float)
    layer_depth = np.asarray(base_depth, dtype=float)
    layer_mask = np.asarray(base_mask)

    if xy.ndim != 2 or xy.shape[1:] != (2,) or len(xy) == 0:
        raise ValueError("sample_xy must have non-empty shape (N, 2)")
    if depths.ndim != 1 or depths.shape[0] != xy.shape[0]:
        raise ValueError("sample_depth must have shape (N,) matching sample_xy")
    if not np.isfinite(xy).all() or not np.isfinite(depths).all():
        raise ValueError("sample coordinates and depths must be finite")
    if layer_depth.ndim != 2 or layer_mask.ndim != 2:
        raise ValueError("base_depth and base_mask must be two-dimensional")
    if layer_depth.shape != layer_mask.shape:
        raise ValueError("base_depth and base_mask shapes must match")
    if layer_mask.dtype.kind != "b":
        raise ValueError("base_mask must be boolean")
    if (not isinstance(image_bounds, (tuple, list)) or len(image_bounds) != 2
            or any(isinstance(value, bool) or not isinstance(value, (int, np.integer))
                   or value <= 0 for value in image_bounds)):
        raise ValueError("image_bounds must be positive integer (width, height)")
    width, height = map(int, image_bounds)
    if layer_depth.shape != (height, width):
        raise ValueError("base layers must match image_bounds (height, width)")
    if np.isnan(layer_depth).any() or np.isposinf(layer_depth).any():
        raise ValueError("base_depth cannot contain NaN or positive infinity")
    if not np.isfinite(layer_depth[layer_mask]).all():
        raise ValueError("occupied base depths must be finite")
    margin = float(margin)
    if not math.isfinite(margin) or margin < 0.0:
        raise ValueError("margin must be finite and non-negative")

    pixels = np.floor(xy).astype(np.int64)
    on_canvas = ((pixels[:, 0] >= 0) & (pixels[:, 0] < width)
                 & (pixels[:, 1] >= 0) & (pixels[:, 1] < height))
    offcanvas_count = int((~on_canvas).sum())
    visible_count = 0
    occluded_count = 0
    if on_canvas.any():
        indices = pixels[on_canvas]
        candidate_depth = depths[on_canvas]
        y, x = indices[:, 1], indices[:, 0]
        occupied = layer_mask[y, x]
        visible = ~occupied
        visible[occupied] = (candidate_depth[occupied] + margin
                             >= layer_depth[y[occupied], x[occupied]])
        visible_count = int(visible.sum())
        occluded_count = int(len(visible) - visible_count)
    return SampleVisibility(
        visible_count=visible_count,
        occluded_count=occluded_count,
        offcanvas_count=offcanvas_count,
        visibility_fraction=float(visible_count / len(xy)))


__all__ = ["SampleVisibility", "estimate_sample_visibility"]
