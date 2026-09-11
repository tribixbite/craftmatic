"""Bounded image-plane translation refinement for v2 feature tokens.

The observed drawing stays fixed.  Every candidate is evaluated on the same
deterministic 3x3 grid at each caller-supplied step size, and a move is accepted
only when the exclusive correspondence cost decreases.  This module does not
change token identity, ownership, visibility, tangent, or feature metadata.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import math
from typing import Iterable, Sequence, Tuple

from placement_v2_correspondence import (
    CorrespondenceConfig,
    CorrespondenceScore,
    ObservedFeatureToken,
    PredictedFeatureToken,
    score_correspondence,
)


@dataclass(frozen=True)
class TranslationRegistration:
    offset: Tuple[float, float]
    initial_cost: float
    cost: float
    improved: bool
    accepted_offsets: Tuple[Tuple[float, float], ...]
    evaluations: int
    shifted_tokens: Tuple[PredictedFeatureToken, ...]
    correspondence: CorrespondenceScore


def _steps(values: Sequence[float]) -> Tuple[float, ...]:
    result = tuple(float(value) for value in values)
    if any(not math.isfinite(value) or value <= 0.0 for value in result):
        raise ValueError("registration steps must be finite and positive")
    return result


def _shift(tokens: Tuple[PredictedFeatureToken, ...],
           offset: Tuple[float, float]) -> Tuple[PredictedFeatureToken, ...]:
    dx, dy = offset
    return tuple(replace(token, position=(float(token.position[0]) + dx,
                                          float(token.position[1]) + dy))
                 for token in tokens)


def align_tokens(
    predicted: Iterable[PredictedFeatureToken],
    observed: Iterable[ObservedFeatureToken],
    config: CorrespondenceConfig = CorrespondenceConfig(),
    steps: Sequence[float] = (8.0, 4.0, 2.0, 1.0, 0.5),
) -> TranslationRegistration:
    """Refine one candidate's translation with monotonic exclusive scoring.

    ``steps`` are pixel (or caller-coordinate) grid radii.  At each radius the
    eight neighboring translations and the current translation are scored.
    Exact cost ties retain the current translation, avoiding unsupported motion
    when all features are hidden or the drawing supplies no usable evidence.
    """
    step_values = _steps(steps)
    predictions = tuple(predicted)
    observations = tuple(observed)
    current = (0.0, 0.0)
    current_tokens = _shift(predictions, current)
    current_score = score_correspondence(current_tokens, observations, config)
    initial_cost = current_score.total_cost
    evaluations = 1
    accepted = []

    for step in step_values:
        candidates = sorted({
            (current[0] + x * step, current[1] + y * step)
            for x in (-1.0, 0.0, 1.0) for y in (-1.0, 0.0, 1.0)
        })
        scored = []
        for offset in candidates:
            if offset == current:
                score, shifted = current_score, current_tokens
            else:
                shifted = _shift(predictions, offset)
                score = score_correspondence(shifted, observations, config)
                evaluations += 1
            # The second key makes the current offset win every exact-cost tie.
            scored.append((score.total_cost, offset != current, offset,
                           score, shifted))
        _, _, best_offset, best_score, best_tokens = min(
            scored, key=lambda item: (item[0], item[1], item[2]))
        if best_score.total_cost < current_score.total_cost:
            current = best_offset
            current_score = best_score
            current_tokens = best_tokens
            accepted.append(current)

    return TranslationRegistration(
        offset=current, initial_cost=float(initial_cost),
        cost=float(current_score.total_cost),
        improved=current_score.total_cost < initial_cost,
        accepted_offsets=tuple(accepted), evaluations=evaluations,
        shifted_tokens=current_tokens, correspondence=current_score)


__all__ = ["TranslationRegistration", "align_tokens"]
