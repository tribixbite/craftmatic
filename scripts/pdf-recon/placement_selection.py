"""Preserve candidate identity across an image-localizer/assembler boundary.

Projected points are a lossy representation: different poses can project to
the same center. Localizers that score candidate windows must return their
candidate index (or an exact transform), not just the center of their winner.
"""
import numpy as np


def select_transform(transforms, location, projected_centers=None):
    """Return the chosen transform and index without discarding pose evidence.

    Older point-only localizers remain supported explicitly; ties are marked
    ambiguous. Callers should retain those alternatives in a beam search.
    """
    if not transforms:
        raise ValueError('No candidate transforms')
    if not location:
        return {'index': 0, 'transform': np.asarray(transforms[0]).copy(),
                'method': 'rank-fallback', 'ambiguous_indices': []}
    if 'candidate_index' in location:
        index = location['candidate_index']
        if isinstance(index, bool) or not isinstance(index, (int, np.integer)):
            raise ValueError('candidate_index must be an integer')
        if index < 0 or index >= len(transforms):
            raise ValueError('candidate_index outside the supplied candidate list')
        return {'index': int(index), 'transform': np.asarray(transforms[index]).copy(),
                'method': 'candidate-identity', 'ambiguous_indices': []}
    points = np.asarray(location.get('points', []), dtype=float)
    if points.size == 0:
        raise ValueError('Localizer supplied neither candidate_index nor points')
    centers = np.asarray(projected_centers, dtype=float)
    if centers.shape != (len(transforms), 2) or points.ndim != 2 or points.shape[1] != 2:
        raise ValueError('Expected finite 2D centers and points')
    if not np.isfinite(centers).all() or not np.isfinite(points).all():
        raise ValueError('Expected finite 2D centers and points')
    distances = np.linalg.norm(centers[:, None, :] - points[None, :, :], axis=2).min(axis=1)
    index = int(np.argmin(distances))
    tied = np.flatnonzero(np.isclose(distances, distances[index], atol=1e-7, rtol=0)).tolist()
    return {'index': index, 'transform': np.asarray(transforms[index]).copy(),
            'method': 'point-only', 'ambiguous_indices': tied if len(tied) > 1 else []}


def candidate_location(candidate_index, projected_centers, **metadata):
    """Build a lossless response while retaining points for old visualizers."""
    if isinstance(candidate_index, bool) or not isinstance(candidate_index, (int, np.integer)):
        raise ValueError('candidate_index must be an integer')
    if not 0 <= candidate_index < len(projected_centers):
        raise ValueError('candidate_index outside projected centers')
    return {**metadata, 'candidate_index': int(candidate_index),
            'points': [np.asarray(projected_centers[candidate_index], dtype=float).tolist()]}
