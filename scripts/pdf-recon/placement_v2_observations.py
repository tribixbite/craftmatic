"""Deterministic native-pixel edge observations and visible instance ownership.

This first implementation uses raster edge tokens, not recovered semantic part
segments. Both PDF and rendered outlines use the same Canny/sampling process.
No reference models or VLM. Coplanar boundaries between physical instances are
explicitly drawn; tessellation within one instance is not a seam.
"""
import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt

from placement_v2_correspondence import ObservedFeatureToken, PredictedFeatureToken


def instance_owner(triangle_owner, triangle_counts):
    """Convert renderer's one-based triangle IDs to one-based physical IDs."""
    owner = np.asarray(triangle_owner)
    counts = np.asarray(triangle_counts)
    if (owner.ndim != 2 or not np.issubdtype(owner.dtype, np.integer)
            or counts.ndim != 1 or not np.issubdtype(counts.dtype, np.integer)
            or np.any(counts < 0) or np.any(owner < 0)
            or np.any(owner > counts.sum())):
        raise ValueError('Invalid triangle ownership/counts')
    result = np.zeros(owner.shape, np.int32)
    valid = owner > 0
    result[valid] = np.searchsorted(np.cumsum(counts), owner[valid], side='left') + 1
    return result


def instance_seams(owner):
    """One pixel on the lower/right side of each visible inter-instance seam."""
    owner = np.asarray(owner)
    if owner.ndim != 2 or np.any(owner < 0):
        raise ValueError('Expected nonnegative 2D instance ownership')
    seams = np.zeros(owner.shape, bool)
    seams[1:] |= (owner[1:] > 0) & (owner[:-1] > 0) & (owner[1:] != owner[:-1])
    seams[:, 1:] |= (owner[:, 1:] > 0) & (owner[:, :-1] > 0) & (owner[:, 1:] != owner[:, :-1])
    return seams


def edge_samples(rgb, mask, spacing=3):
    """One deterministic edge sample per native-pixel cell, with local tangent.

    Sampling bounds graph size without selecting points by candidate score.
    Grid phase is native-image anchored and is a measured discretization limit.
    """
    rgb, mask = np.asarray(rgb), np.asarray(mask, bool)
    if rgb.shape != (*mask.shape, 3) or mask.ndim != 2 or spacing < 1 or int(spacing) != spacing:
        raise ValueError('Expected RGB image, matching mask, positive integer spacing')
    if not np.isfinite(rgb).all():
        raise ValueError('Image must be finite')
    image = np.asarray(rgb, np.uint8).copy()
    image[~mask] = 245
    gray = cv2.GaussianBlur(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY), (3, 3), .6)
    edges = cv2.Canny(gray, 35, 85) > 0
    band = cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    edges &= band
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    yy, xx = np.nonzero(edges)
    if not len(xx):
        return [], edges
    # Choose strongest gradient within each cell, stable coordinate tie-break.
    cells = (yy // spacing) * ((mask.shape[1] + spacing - 1) // spacing) + xx // spacing
    strength = gx[yy, xx] ** 2 + gy[yy, xx] ** 2
    order = np.lexsort((xx, yy, -strength, cells))
    ordered_cells = cells[order]
    kept = order[np.r_[True, ordered_cells[1:] != ordered_cells[:-1]]]
    samples = []
    for index in kept:
        y, x = int(yy[index]), int(xx[index])
        tangent = np.array([-gy[y, x], gx[y, x]], float)
        norm = np.linalg.norm(tangent)
        if norm <= 1e-9:
            tangent = np.array([1., 0.])
        else:
            tangent /= norm
        samples.append((x, y, tuple(tangent)))
    return samples, edges


def observed_tokens(rgb, mask, spacing=3, uncertainty=1.5):
    samples, _ = edge_samples(rgb, mask, spacing)
    return [ObservedFeatureToken(token_id=f'o:{y}:{x}', position=(float(x), float(y)),
                                 tangent=tangent, uncertainty=uncertainty)
            for x, y, tangent in samples]


def predicted_tokens(outline_rgb, mask, owner, spacing=3, include_seams=True):
    """Sample the visible outlined render, retaining adjacent instance IDs.

    A seam contributes one observed boundary stream rather than independently
    rewarding each adjacent instance. Completely occluded instances have no
    tokens and must be reported as unsupported by the caller.
    """
    mask, owner = np.asarray(mask, bool), np.asarray(owner)
    if owner.shape != mask.shape or np.any(owner[mask] <= 0) or np.any(owner[~mask] != 0):
        raise ValueError('Ownership must match visible mask')
    outline = np.asarray(outline_rgb, np.uint8).copy()
    seams = instance_seams(owner)
    if include_seams:
        outline[seams] = 20
    samples, edges = edge_samples(outline, mask, spacing)
    if not mask.any():
        return [], dict(outline=outline, edges=edges, seams=seams)
    nearest = distance_transform_edt(~mask, return_distances=False, return_indices=True)
    tokens = []
    h, w = mask.shape
    for x, y, tangent in samples:
        ids = np.unique(owner[max(0, y-1):min(h, y+2), max(0, x-1):min(w, x+2)])
        ids = ids[ids > 0]
        if not len(ids):
            ids = [owner[nearest[0, y, x], nearest[1, y, x]]]
        owners = tuple(f'part:{int(i)-1}' for i in ids)
        tokens.append(PredictedFeatureToken(token_id=f'p:{y}:{x}', owner_ids=owners,
                                            position=(float(x), float(y)), tangent=tangent))
    return tokens, dict(outline=outline, edges=edges, seams=seams)
