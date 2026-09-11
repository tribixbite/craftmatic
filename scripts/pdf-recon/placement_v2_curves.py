"""Exclusive whole-ellipse correspondence, independent of raster edge density.

Ellipses are observed curves, not automatically studs. A hole or decoration
can also qualify. Covariance describes projected shape without axis-order or
angle conventions. This channel tests topology lost by anonymous edge samples.
"""
import numpy as np
from scipy.optimize import linear_sum_assignment

from placement_studs import detect_studs


def curve_observations(rgb, mask):
    # Dark saturated surfaces can be below every grayscale threshold, merging
    # their outlines into one solid blob. The max-channel view already used by
    # the PDF camera detector preserves those outlines without a color model.
    rgb = np.asarray(rgb, np.uint8)
    value = np.repeat(rgb.max(axis=2)[:, :, None], 3, axis=2)
    detected = []
    for channel, image in [('gray', rgb), ('value', value)]:
        if channel == 'value' and np.array_equal(value, rgb):
            continue
        for curve in detect_studs(image, mask):
            item = dict(curve, channel=channel)
            match = next((i for i, old in enumerate(detected)
                          if np.linalg.norm(np.asarray(item['center']) - old['center']) < 3.), None)
            if match is None:
                detected.append(item)
            elif item['confidence'] > detected[match]['confidence']:
                detected[match] = item
    return sorted(detected, key=lambda c: (c['center'][1], c['center'][0]))


def covariance(curve):
    axes = np.asarray(curve['axes'], float)
    angle = np.radians(float(curve['angle']))
    if axes.shape != (2,) or not np.isfinite(axes).all() or np.any(axes <= 0) or not np.isfinite(angle):
        raise ValueError('Invalid ellipse geometry')
    rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    return rotation @ np.diag((axes / 2.) ** 2) @ rotation.T


def score_curves(predicted, observed, unmatched_cost=2., max_curves=512):
    """Partial one-to-one ellipse matching with explicit missing-curve costs.

    Position is normalized by 1/4 observed major diameter, shape by covariance
    magnitude. Constants are frozen defaults for this development experiment,
    not calibrated probabilities. Dense work is capped to at most 512 curves.
    """
    if not np.isfinite(unmatched_cost) or unmatched_cost <= 0:
        raise ValueError('Unmatched cost must be positive and finite')
    n, m = len(predicted), len(observed)
    if max(n, m) > max_curves:
        raise ValueError('Curve budget exceeded; no silent truncation')
    all_curves = list(predicted) + list(observed)
    for curve in all_curves:
        center = np.asarray(curve['center'], float)
        if center.shape != (2,) or not np.isfinite(center).all():
            raise ValueError('Invalid ellipse center')
        covariance(curve)
    if not n or not m:
        total = (n + m) * unmatched_cost
        return dict(normalized_cost=total / max(1, n+m), total_cost=total, matches=[],
                    predicted_count=n, observed_count=m, unmatched_predicted=n, unmatched_observed=m,
                    supported=bool(n and m))
    p = np.array([c['center'] for c in predicted])
    o = np.array([c['center'] for c in observed])
    pc = np.array([covariance(c) for c in predicted])
    oc = np.array([covariance(c) for c in observed])
    sigma = np.maximum(1.5, np.array([max(c['axes']) for c in observed]) * .25)
    position_cost = np.linalg.norm(p[:, None] - o[None], axis=2) / sigma[None]
    shape_cost = np.linalg.norm(pc[:, None] - oc[None], axis=(2, 3)) / np.maximum(
        1e-9, np.linalg.norm(oc, axis=(1, 2)))[None]
    cost = position_cost + shape_cost
    # Private unmatched columns guarantee feasibility. Subtract the saved
    # observation penalty from real edges; add the constant baseline later.
    augmented = np.full((n, m+n), np.inf)
    augmented[:, :m] = cost - unmatched_cost
    augmented[np.arange(n), m+np.arange(n)] = unmatched_cost
    ii, jj = linear_sum_assignment(augmented)
    matches = [dict(predicted=int(i), observed=int(j), cost=float(cost[i, j]),
                    position_cost=float(position_cost[i, j]), shape_cost=float(shape_cost[i, j]))
               for i, j in zip(ii, jj) if j < m]
    total = float(sum(c['cost'] for c in matches) + unmatched_cost * (n+m-2*len(matches)))
    return dict(normalized_cost=total/(n+m), total_cost=total, matches=matches,
                predicted_count=n, observed_count=m, unmatched_predicted=n-len(matches),
                unmatched_observed=m-len(matches), supported=True)
