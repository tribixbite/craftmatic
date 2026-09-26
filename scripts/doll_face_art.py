#!/usr/bin/env python3
"""
Face ART for a MINI-DOLL head no LDraw library prints, from LEGO's own render
of that element (the image Rebrickable serves at
`cdn.rebrickable.com/media/parts/elements/<element>.jpg`).

That render shows the head in a THREE-QUARTER view (turned ~39 degrees, seen
~28 degrees from above), so the face cannot be cropped out of it the way a
BrickLink minifig-head photo is (`gen-face-art.py`). Instead the head's own
LDraw mesh (`92198.dat`, or `92240.dat` for the male mould) is fitted to the
photo and the face is read off the fitted surface:

  1. Camera: orthographic, rotation Rx(pitch) Ry(yaw), scale and offset. For
     each yaw/pitch on a grid the mesh is projected, scaled to the photo
     silhouette's width and aligned on the chin (the photo's top carries a neck
     pin), and scored by silhouette IoU. Measured on LEGO's renders: IoU 0.95 -
     0.97 at yaw 39, pitch 28 on every head tried.
  2. A head is left-right symmetric, so its silhouette cannot tell yaw from
     -yaw; the face can. Both are sampled and the one whose dark ink is the
     more mirror-symmetric wins.
  3. The art is the head seen FACE-ON over its whole front bounds (LDraw x, y;
     `FACE_PX_PER_LDU` = 4 texels per LDU, the size head-face.ts draws): each
     texel's front surface point is projected into the photo and sampled, where
     the surface faces the camera at all (a far cheek seen at over ~83 degrees
     is left empty rather than smeared).
  4. Ink, as for a minifig photo: a texel far from the median skin is ink; ink
     lighter than the skin (eye whites) is kept only beside dark ink; the rim
     (the photo's own shading) is eroded away.

What it cannot do, stated: the far half of the face is seen at 60-80 degrees,
so its eye is drawn from a third of the photo pixels the near eye gets, and a
moulded nose is not in the LDraw mesh, so its outline lands a texel or two off.
The art is for LOCAL builds only (the images are LEGO's; see
docs/bedrock-addon-guide.md "Faces").

Usage (library): doll_art(photo_path, mould_stem) -> PIL RGBA image or None.
Measured against three heads LDraw DOES print (92198p18/p25/p27): the
before/after sheet is output/dolls-0926/face-measure/_photo_vs_ldraw.png.
"""
from __future__ import annotations

import math
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CLEGO = Path('C:/') / 'git' / 'clego'
LIBRARY = [CLEGO / 'ldraw_ref' / s / d for s in ('official', 'unofficial') for d in ('parts', 'p')] + \
          [CLEGO / 'extracted' / 'studio_release' / 'app' / 'ldraw' / d for d in ('parts', 'p')]
FACE_PX_PER_LDU = 4            # head-face.ts FACE_PX_PER_LDU
BACKGROUND_MIN = 232           # a photo pixel whose every channel is above this is background
YAWS = np.radians(np.arange(-66, 67, 3))
PITCHES = np.radians(np.arange(-52, 53, 4))
# Camera perspective, 1 / distance in LDU: LEGO's 2023 renders (41732's heads)
# are pinhole shots close enough to foreshorten the far cheek; 0 is orthographic.
PERSPECTIVES = (0.0, 0.006, 0.012, 0.02)
MIN_FACING = 0.12              # |cos| of the angle between a texel's normal and the camera, below which it is not read
INK_DISTANCE = 45              # RGB distance from the skin that makes a texel ink (as gen-face-art.py)
MIN_FIT_IOU = 0.85             # a worse silhouette fit is not this mould in this pose: no art
SPECKLE_MIN = 3                # ink blobs smaller than this (texels) are photo noise
HUE_INK = 0.05                 # chromaticity distance from the skin that makes LIGHT ink a print, not a highlight
FILL_NEIGHBOURS = 5            # a non-ink texel with this many ink neighbours (of 8) is a hole in a feature
# A texel seen less squarely than MIRROR_BELOW takes its mirror image when that was seen at MIRROR_FROM or better.
MIRROR_BELOW, MIRROR_FROM = 0.45, 0.6
# Half the distance between a doll's eyes, as a share of the head's width (median of 38 LDraw doll prints).
DOLL_EYE_DX = 0.22
STUD_PRIMITIVE = re.compile(r'^(stud[0-9a-z]*|stug[0-9a-z-]*)$')   # ldraw-part-geometry.ts SKIP_PRIMITIVE


def _find(name: str) -> Path | None:
    n = name.replace('\\', '/').lower()
    return next((d / n for d in LIBRARY if (d / n).exists()), None)


def _triangles(name: str, M=np.eye(3), t=np.zeros(3), depth: int = 0, studs: bool = False) -> list[np.ndarray]:
    """Every triangle of an LDraw file, flattened through its subfiles (quads split).

    Stud and anti-stud primitives are skipped exactly as ldraw-part-geometry.ts
    skips them (`SKIP_PRIMITIVE`), so the bounds here ARE the bounds head-face.ts
    maps the art onto (a doll head's neck stud would otherwise add 4 LDU on top).
    `studs=True` keeps them: the camera fit matches the photo's WHOLE silhouette,
    neck stud included.
    """
    if not studs and STUD_PRIMITIVE.match(Path(name.replace('\\', '/')).stem.lower()):
        return []
    f = _find(name)
    if f is None or depth > 12:
        return []
    out: list[np.ndarray] = []
    for ln in f.read_text(encoding='utf-8', errors='replace').splitlines():
        s = ln.split()
        if not s:
            continue
        if s[0] == '1' and len(s) >= 15:
            v = list(map(float, s[2:14]))
            out += _triangles(' '.join(s[14:]), M @ np.array(v[3:12]).reshape(3, 3), M @ np.array(v[0:3]) + t, depth + 1, studs)
        elif s[0] in ('3', '4'):
            n = 3 if s[0] == '3' else 4
            p = np.array(list(map(float, s[2:2 + 3 * n]))).reshape(n, 3) @ M.T + t
            out.append(p[[0, 1, 2]])
            if n == 4:
                out.append(p[[0, 2, 3]])
    return out


@lru_cache(maxsize=4)
def _mould(stem: str):
    """(triangles, lo, hi, front depth map, front normal map) of a head mould, face-on from LDraw -Z."""
    tris = _triangles(f'{stem}.dat')
    if not tris:
        return None
    V = np.concatenate(tris)
    lo, hi = V.min(axis=0), V.max(axis=0)
    W = int(round((hi[0] - lo[0]) * FACE_PX_PER_LDU))
    H = int(round((hi[1] - lo[1]) * FACE_PX_PER_LDU))
    depth = np.full((H, W), np.inf)
    normal = np.zeros((H, W, 3))
    for tri in tris:
        a, b, c = tri
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            continue
        n = n / ln
        n = n if n[2] < 0 else -n                 # the side facing the viewer at -Z
        P = (tri[:, :2] - lo[:2]) * FACE_PX_PER_LDU
        area = (P[1, 0] - P[0, 0]) * (P[2, 1] - P[0, 1]) - (P[1, 1] - P[0, 1]) * (P[2, 0] - P[0, 0])
        if abs(area) < 1e-9:
            continue
        x0, y0 = np.floor(P.min(axis=0)).astype(int)
        x1, y1 = np.ceil(P.max(axis=0)).astype(int)
        xs, ys = np.meshgrid(np.arange(max(0, x0), min(W, x1 + 1)), np.arange(max(0, y0), min(H, y1 + 1)))
        sx, sy = xs + 0.5, ys + 0.5
        w0 = ((P[1, 0] - sx) * (P[2, 1] - sy) - (P[1, 1] - sy) * (P[2, 0] - sx)) / area
        w1 = ((P[2, 0] - sx) * (P[0, 1] - sy) - (P[2, 1] - sy) * (P[0, 0] - sx)) / area
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        z = w0 * a[2] + w1 * b[2] + w2 * c[2]
        yy, xx = ys[inside], xs[inside]
        zz = z[inside]
        nearer = zz < depth[yy, xx]
        depth[yy[nearer], xx[nearer]] = zz[nearer]
        normal[yy[nearer], xx[nearer]] = n
    return tris, lo, hi, depth, normal


def _rot(yaw: float, pitch: float) -> np.ndarray:
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    return np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]]) @ np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])


def _project(Q: np.ndarray, persp: float) -> np.ndarray:
    """Camera-frame points (x, y, depth) to the image plane: a pinhole `persp` = 1 / distance (LDU^-1), 0 = orthographic."""
    return Q[:, :2] / (1.0 + persp * Q[:, 2:3])


def _fit(tris, sil: np.ndarray):
    V = np.concatenate(tris)
    ys, xs = np.where(sil)
    px0, px1, py1 = xs.min(), xs.max(), ys.max()
    best = None
    for persp in PERSPECTIVES:
        for yaw in YAWS:
            for pitch in PITCHES:
                R = _rot(yaw, pitch)
                Q = _project(V @ R.T, persp)
                s = (px1 - px0) / (Q[:, 0].max() - Q[:, 0].min())
                tx, ty = px0 - s * Q[:, 0].min(), py1 - s * Q[:, 1].max()   # width-scaled, aligned on the chin
                img = Image.new('1', (sil.shape[1], sil.shape[0]), 0)
                d = ImageDraw.Draw(img)
                for tri in tris:
                    q = _project(tri @ R.T, persp)
                    d.polygon([(s * p[0] + tx, s * p[1] + ty) for p in q], fill=1)
                m = np.asarray(img, bool)
                iou = (m & sil).sum() / max(1, (m | sil).sum())
                if best is None or iou > best[0]:
                    best = (iou, yaw, pitch, s, tx, ty, persp)
    return best


def _sample(photo, sil, mould, yaw, pitch, s, tx, ty, persp=0.0) -> tuple[np.ndarray, np.ndarray]:
    """The face-on art read off the photo, and how squarely each texel faced the camera (0 = unseen)."""
    _, lo, _, depth, normal = mould
    H, W = depth.shape
    R = _rot(yaw, pitch)
    ys, xs = np.nonzero(np.isfinite(depth))
    P = np.stack([lo[0] + (xs + 0.5) / FACE_PX_PER_LDU, lo[1] + (ys + 0.5) / FACE_PX_PER_LDU, depth[ys, xs]], axis=1)
    facing = -(normal[ys, xs] @ R.T)[:, 2]
    Q = _project(P @ R.T, persp)
    u = np.rint(s * Q[:, 0] + tx).astype(int)
    v = np.rint(s * Q[:, 1] + ty).astype(int)
    ok = (facing >= MIN_FACING) & (u >= 0) & (v >= 0) & (u < photo.shape[1]) & (v < photo.shape[0])
    ok[ok] &= sil[v[ok], u[ok]]
    out = np.zeros((H, W, 4), np.uint8)
    out[ys[ok], xs[ok], :3] = photo[v[ok], u[ok]]
    out[ys[ok], xs[ok], 3] = 255
    seen = np.zeros((H, W))
    seen[ys[ok], xs[ok]] = facing[ok]
    return out, seen


def _mirror_far_side(art: np.ndarray, seen: np.ndarray) -> tuple[np.ndarray, float]:
    """Fill the texels the photo saw badly (or not at all) from their MIRROR image across the
    face's own centre line, where that was seen squarely.

    LEGO renders a doll head turned 39-60 degrees, so the far eye is seen at
    60-85 degrees: a sliver, or nothing (41732's heads). A mini-doll's eyes,
    brows and mouth are drawn symmetric, so the near half is the better witness
    for the far one. The centre line is NOT the image's middle column - a yaw a
    few degrees off moves the whole face sideways - but is found from the NEAR
    eye: the largest dark blob at eye height on the well-seen side sits
    `DOLL_EYE_DX` of the width from the centre (measured on 38 LDraw doll
    prints, `_doll_face_measure.ts`). With no near eye found nothing is
    mirrored. This is a STATED approximation - an asymmetric print (a wink, a
    star on one cheek) comes out symmetric on the far half - and the share of
    texels it wrote is returned for the fit report.
    """
    H, W = seen.shape
    near_left = seen[:, : W // 2].mean() >= seen[:, W // 2:].mean()
    lum = art[..., :3].astype(float) @ np.array([0.299, 0.587, 0.114])
    opaque = art[..., 3] > 0
    if not opaque.any():
        return art, 0.0
    skin_lum = float(np.median(lum[opaque]))
    band = np.zeros((H, W), bool)
    band[int(H * 0.45):int(H * 0.75), : W // 2] = near_left
    band[int(H * 0.45):int(H * 0.75), W // 2:] = not near_left
    eye = band & opaque & (lum < 0.6 * skin_lum) & (seen >= MIRROR_FROM)
    if eye.sum() < 12:
        return art, 0.0
    from scipy import ndimage
    lab, n = ndimage.label(eye)
    sizes = ndimage.sum(eye, lab, range(1, n + 1))
    ys, xs = np.nonzero(lab == int(np.argmax(sizes)) + 1)
    ex = xs.mean()
    centre = ex + DOLL_EYE_DX * W if near_left else ex - DOLL_EYE_DX * W
    gx = np.arange(W)
    src = np.rint(2 * centre - gx).astype(int)
    valid = (src >= 0) & (src < W)
    mirror = np.zeros_like(art)
    mirror_seen = np.zeros_like(seen)
    mirror[:, valid] = art[:, src[valid]]
    mirror_seen[:, valid] = seen[:, src[valid]]
    far = (gx > centre) if near_left else (gx < centre)
    take = far[None, :] & (seen < MIRROR_BELOW) & (mirror_seen >= MIRROR_FROM)
    out = art.copy()
    out[take] = mirror[take]
    face = (seen > 0) | take
    return out, float(take.sum() / max(1, face.sum()))


def _face_side(photo: np.ndarray, sil: np.ndarray) -> float:
    """Which way the face is turned in the photo: the dark print's centroid minus the silhouette's, in x."""
    lum = photo @ np.array([0.299, 0.587, 0.114])
    dark = sil & (lum < np.percentile(lum[sil], 8))
    ys, xs = np.nonzero(sil)
    dy, dx = np.nonzero(dark)
    return float(dx.mean() - xs.mean()) if dx.size else 0.0


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def _skin_field(rgb: np.ndarray, opaque: np.ndarray) -> np.ndarray:
    """The SHADED skin colour at every texel: a quadratic in (x, y) per channel, fitted to the
    texels that are skin, re-fitted with the print left out (three passes).

    LEGO's renders light the head from one side, so the far cheek is up to ~60
    levels darker than the near one - more than the ink threshold. Against one
    median skin that shading read as ink and drew a brown half-mask on the face;
    against the fitted field only the print stands out.
    """
    H, W = opaque.shape
    ys, xs = np.nonzero(opaque)
    x, y = xs / W - 0.5, ys / H - 0.5
    A = np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], axis=1)
    vals = rgb[ys, xs].astype(float)
    keep = np.ones(len(xs), bool)
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(A[keep], vals[keep], rcond=None)
        resid = np.sqrt(((vals - A @ coef) ** 2).sum(axis=1))
        keep = resid < max(12.0, float(np.percentile(resid, 60)))
    gy, gx = np.mgrid[0:H, 0:W]
    G = np.stack([np.ones(H * W), (gx.ravel() / W - 0.5), (gy.ravel() / H - 0.5), (gx.ravel() / W - 0.5) ** 2,
                  (gx.ravel() / W - 0.5) * (gy.ravel() / H - 0.5), (gy.ravel() / H - 0.5) ** 2], axis=1)
    return (G @ coef).reshape(H, W, 3)


def _ink(art: np.ndarray) -> np.ndarray:
    """Keep only the print: shaded skin (`_skin_field`) and the silhouette rim go transparent."""
    opaque = art[..., 3] > 0
    if opaque.sum() < 64:
        return art
    rgb = art[..., :3].astype(np.int32)
    skin = _skin_field(rgb, opaque)
    dist = np.sqrt(((rgb - skin) ** 2).sum(axis=2))
    w = np.array([0.299, 0.587, 0.114])
    lum, skin_lum = rgb @ w, skin @ w
    ink = (dist > INK_DISTANCE) & opaque
    if float(np.median(skin_lum[opaque])) < 90:
        keep = ink
    else:
        dark = ink & (lum < skin_lum)
        # Light ink is kept beside dark ink (eye whites, teeth) or when its HUE
        # differs from the skin's (42703's gold cheek stars, 41732's pink
        # lips); a studio highlight is lighter skin of the same hue and goes.
        chroma = lambda c: c / np.maximum(1.0, c.sum(axis=-1, keepdims=True))
        hue_off = np.sqrt(((chroma(rgb.astype(float)) - chroma(skin)) ** 2).sum(axis=2)) > HUE_INK
        keep = dark | (ink & ~dark & (_dilate(dark, 2) | hue_off))
    r = max(2, art.shape[1] // 26)
    padded = np.pad(opaque, r, constant_values=False)
    inner = ~_dilate(~padded, r)[r:-r, r:-r]
    keep &= inner
    # Speckle: a photo's JPEG ringing and anti-aliased edges leave single ink
    # texels and one-texel holes, which the device draws as a dotted, mottled
    # face. Ink blobs under SPECKLE_MIN texels go; a hole ringed by ink
    # (FILL_NEIGHBOURS of its 8 neighbours) is filled with their mean colour.
    from scipy import ndimage
    lab, n = ndimage.label(keep, structure=np.ones((3, 3)))
    if n:
        sizes = ndimage.sum(keep, lab, range(1, n + 1))
        keep &= np.isin(lab, np.nonzero(sizes >= SPECKLE_MIN)[0] + 1)
    k = keep.astype(np.int32)
    neighbours = sum(np.roll(np.roll(k, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx)
    holes = ~keep & opaque & (neighbours >= FILL_NEIGHBOURS)
    out = art.copy()
    if holes.any():
        rgbk = art[..., :3].astype(np.int64) * k[..., None]
        total = sum(np.roll(np.roll(rgbk, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx)
        out[holes, :3] = (total[holes] / neighbours[holes][:, None]).astype(np.uint8)
    out[..., 3] = np.where(keep | holes, 255, 0).astype(np.uint8)
    return out


def _symmetry(art: np.ndarray) -> float:
    lum = art[..., :3].astype(float) @ np.array([0.299, 0.587, 0.114])
    dark = (lum < 100) & (art[..., 3] > 0)
    m = dark[:, ::-1]
    return float((dark & m).sum() / max(1, (dark | m).sum()))


def doll_art(photo_path: Path, mould_stem: str) -> tuple[Image.Image | None, dict]:
    """Face-on RGBA art over the mould's whole front bounds, and the fit that made it."""
    mould = _mould(mould_stem)
    if mould is None:
        return None, {'error': f'no mesh for {mould_stem}'}
    photo = np.asarray(Image.open(photo_path).convert('RGB')).astype(np.int32)
    sil = ~(photo.min(axis=2) > BACKGROUND_MIN)
    if sil.sum() < 500:
        return None, {'error': 'no head in the photo'}
    iou, yaw, pitch, s, tx, ty, persp = _fit(_triangles(f'{mould_stem}.dat', studs=True), sil)
    info = {'iou': round(float(iou), 3), 'pitch': round(math.degrees(pitch), 1), 'perspective': persp}
    if iou < MIN_FIT_IOU:
        return None, {**info, 'error': 'silhouette does not fit the mould'}
    # The silhouette cannot tell yaw from -yaw; the print can: the face centre
    # (the mould's front at eye height) must project to the side of the
    # silhouette the dark print sits on.
    _, lo, hi, depth, _ = mould
    cx, cy = int(depth.shape[1] / 2), int(depth.shape[0] * 0.6)
    centre = np.array([(lo[0] + hi[0]) / 2, lo[1] + (cy + 0.5) / FACE_PX_PER_LDU, depth[cy, cx]])
    side = _face_side(photo, sil)
    sil_x = float(np.nonzero(sil)[1].mean())
    projected = lambda y: s * _project((_rot(y, pitch) @ centre)[None, :], persp)[0, 0] + tx - sil_x
    yaw = yaw if projected(yaw) * side >= projected(-yaw) * side else -yaw
    art, seen = _sample(photo, sil, mould, yaw, pitch, s, tx, ty, persp)
    art, mirrored = _mirror_far_side(art, seen)
    info.update(yaw=round(math.degrees(yaw), 1), mirrored=round(mirrored, 3), symmetry=round(_symmetry(_ink(art)), 3))
    return Image.fromarray(_ink(art), 'RGBA'), info
