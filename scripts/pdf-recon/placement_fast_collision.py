"""A bit-exact vectorised stand-in for `recon_v8.assembly.Assembly.collision`.

Round six named finishing the candidate closure as the largest single lever on
both fixtures - `unreachable` is 8 of 34 in-scope failures on 40377 and 60 of 86
on 41624 - and called it "a number in a config". `placement_closure_profile`
measured what that number costs. On 40377 page 18, expanding 64 closure parents
takes 19.2 s, of which **18.87 s (98.3%) is inside `Assembly.collides`**; the
4x4 transform, the key rounding and the bank lookup together are 0.28 s. The
per-call cost is 6.3 ms, and finishing that page's own first round at 5,258
parents projects to 26 minutes for one page of one drawing of one page-run.

The reason is that the predicate is a pure-Python loop. `Placed.voxels()` walks
up to `MAX_PART_POINTS` = 4,000 surface samples doing nine multiplies, a floor
and a `set.add` each; `collision` then does a dict membership test per voxel;
and `core()` erodes the set with six more membership tests per voxel. Nothing
about the computation needs to be scalar.

This module does the same arithmetic on numpy arrays, and does it in the same
association order, so the answer is not merely close - it is the same answer:

* `w = r0*x + r1*y + r2*z + t` is evaluated as `(((r0*x) + (r1*y)) + (r2*z)) + t`
  elementwise, which is exactly how the scalar loop associates it. IEEE 754
  requires a correctly-rounded result for each individual multiply and add, and
  numpy's elementwise ufuncs do not contract them into an FMA, so every
  intermediate is bit-identical to the scalar version.
* `floor(w / 4.0)` is exact: dividing by a power of two is exact and `floor` is
  exact, so the integer voxel index cannot differ.
* The rotated point cloud is cached per (part, rotation) and only the
  translation is added per pose. `s = (((r0*x)+(r1*y))+(r2*z))` then `w = s + t`
  is the same expression tree, so caching changes nothing about the values.

The set semantics are reproduced rather than approximated: voxels are packed
into int64 keys and deduplicated with `np.unique`, which yields exactly the
distinct voxels the Python `set` would hold, and membership is a `searchsorted`
against the body's own sorted key array.

`collision()` computes both core terms unconditionally, because `candidates()`
stores the returned floats. `collides()` may short-circuit, and each exit is a
proven implication rather than a heuristic:

* `plain > COLLIDE_PLAIN` already decides the disjunction.
* `coreA / n > COLLIDE_CORE` already decides it.
* otherwise, `erode(vox)` is a subset of `vox`, so `coreB <= plain_count`; if
  `plain_count / n <= COLLIDE_CORE` then `coreB / n <= COLLIDE_CORE` and the
  erosion cannot change the verdict. Division is monotonic on non-negative
  values, so this holds in floating point as well as in the reals.

`accelerate(assembly)` binds the fast predicates onto one `Assembly` instance
and wraps `add` so the snapshot is rebuilt when the body changes. It patches an
instance, never the class, so nothing outside the caller's own object is
affected and `C:/git/clego` is not modified.

No reference model, set inventory or VLM participates: this is a geometric
predicate over the same LDraw surface samples the reference implementation uses.
"""
import sys
from pathlib import Path

import numpy as np

BASE = Path('C:/git/clego')
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from dbix_settle import VOX, part_points                       # noqa: E402
from recon_v8.assembly import COLLIDE_PLAIN, COLLIDE_CORE      # noqa: E402

# Packing must leave room for the six neighbour offsets to stay inside their own
# coordinate field, otherwise an erosion probe could wrap into the next one.
_PACK = 1 << 20
_OFF = 1 << 19
_LIMIT = _OFF - 4
_DX, _DY, _DZ = _PACK * _PACK, _PACK, 1
_N6 = (_DX, -_DX, _DY, -_DY, _DZ, -_DZ)

_points = {}
_rotated = {}


def _local(stem):
    """`part_points(stem)` as three cached float64 columns."""
    columns = _points.get(stem)
    if columns is None:
        array = np.asarray(part_points(stem), dtype=np.float64)
        if array.ndim != 2 or array.size == 0:
            array = np.zeros((1, 3), dtype=np.float64)
        columns = (np.ascontiguousarray(array[:, 0]),
                   np.ascontiguousarray(array[:, 1]),
                   np.ascontiguousarray(array[:, 2]))
        _points[stem] = columns
    return columns


def rotated_points(stem, rotation):
    """Cached `R @ p` for every local surface sample, in the scalar loop's order.

    `rotation` is the row-major 3x3 as a flat float64 array. The cache key is its
    exact bytes, so two poses share the cached cloud only when their rotations
    are bit-identical - a rotation that differs in the last ULP gets its own
    entry rather than silently borrowing another's.
    """
    key = (stem, rotation.tobytes())
    cached = _rotated.get(key)
    if cached is None:
        x, y, z = _local(stem)
        cached = (rotation[0] * x + rotation[1] * y + rotation[2] * z,
                  rotation[3] * x + rotation[4] * y + rotation[5] * z,
                  rotation[6] * x + rotation[7] * y + rotation[8] * z)
        _rotated[key] = cached
    return cached


def part_voxel_keys(part, T):
    """Packed, sorted, deduplicated voxel keys of `part` placed at `T`.

    Returns None when any coordinate leaves the packing range, so the caller can
    fall back to the reference implementation instead of packing a wrong key.
    """
    stem = str(part).lower().replace('.dat', '')
    T = np.asarray(T, dtype=np.float64)
    rotation = np.ascontiguousarray(T[:3, :3]).reshape(9)
    sx, sy, sz = rotated_points(stem, rotation)
    vx = np.floor((sx + T[0, 3]) / VOX)
    vy = np.floor((sy + T[1, 3]) / VOX)
    vz = np.floor((sz + T[2, 3]) / VOX)
    if (max(abs(float(vx.min())), abs(float(vx.max())), abs(float(vy.min())),
            abs(float(vy.max())), abs(float(vz.min())), abs(float(vz.max()))) > _LIMIT):
        return None
    keys = ((vx.astype(np.int64) + _OFF) * _DX + (vy.astype(np.int64) + _OFF) * _DY
            + (vz.astype(np.int64) + _OFF))
    return np.unique(keys)


def _present(haystack, needles):
    """Boolean mask of which sorted-unique `needles` occur in sorted `haystack`."""
    if haystack.size == 0 or needles.size == 0:
        return np.zeros(needles.size, dtype=bool)
    index = np.minimum(np.searchsorted(haystack, needles), haystack.size - 1)
    return haystack[index] == needles


def _count_present(haystack, needles):
    """|needles as a set INTERSECT haystack|, both already sorted and unique."""
    if haystack.size == 0 or needles.size == 0:
        return 0
    return int(np.count_nonzero(_present(haystack, needles)))


def _erode(keys, subset=None):
    """`assembly.erode` in packed form: members with all six 6-neighbours present.

    `subset` restricts which members are tested, without changing the set they
    are tested against. The only consumer of the erosion is
    `|erode(vox) INTERSECT occ|`, and a voxel outside `occ` cannot contribute to
    that count however interior it is - so passing `vox INTERSECT occ` computes
    the same number while testing about a third as many voxels. Erosion itself
    is still judged against the whole of `vox`, which is what makes the
    restriction exact rather than an approximation.
    """
    if keys.size == 0:
        return keys
    probes = keys if subset is None else subset
    if probes.size == 0:
        return probes
    keep = np.ones(probes.size, dtype=bool)
    for delta in _N6:
        probe = probes + delta
        index = np.minimum(np.searchsorted(keys, probe), keys.size - 1)
        keep &= keys[index] == probe
        if not keep.any():
            break
    return probes[keep]


class FastCollider:
    """Snapshot of one assembly's occupancy, with vectorised collision tests.

    The snapshot is valid only while the body is unchanged, which is exactly the
    situation the closure runs in: a page enumerates and expands against a body
    that is frozen for the whole page. `refresh()` rebuilds it, and `accelerate`
    wires that to `Assembly.add`.
    """

    def __init__(self, assembly):
        self.assembly = assembly
        self.refresh()

    def refresh(self):
        self.occ_keys = self._pack(self.assembly.occ.keys())
        self.core_keys = self._pack(self.assembly.corevox)
        self.parts = len(self.assembly.parts)
        self.exact_fallbacks = 0
        self.calls = 0

    @staticmethod
    def _pack(voxels):
        rows = list(voxels)
        if not rows:
            return np.zeros(0, dtype=np.int64)
        array = np.asarray(rows, dtype=np.int64)
        if np.abs(array).max() > _LIMIT:
            raise ValueError('Body voxels exceed the packing range')
        return np.unique(array[:, 0] * _DX + array[:, 1] * _DY + array[:, 2] * _DZ + _OFF *
                         (_DX + _DY + _DZ))

    def _terms(self, part, T):
        """(n, plain_count, coreA, keys, occupied) or None when the fast path declines."""
        keys = part_voxel_keys(part, T)
        if keys is None:
            return None
        occupied = keys[_present(self.occ_keys, keys)]
        return keys.size, occupied.size, _count_present(self.core_keys, keys), keys, occupied

    def _core_b(self, keys, occupied):
        return int(_erode(keys, occupied).size)

    def collision(self, part, t):
        """Byte-for-byte `Assembly.collision`, including both core terms."""
        self.calls += 1
        terms = self._terms(part, t)
        if terms is None:
            self.exact_fallbacks += 1
            return _reference_collision(self.assembly, part, t)
        n, plain_count, core_a, keys, occupied = terms
        if n == 0:
            return 0.0, 0.0
        return plain_count / n, max(core_a, self._core_b(keys, occupied)) / n

    def collides(self, part, t, plain=COLLIDE_PLAIN, core=COLLIDE_CORE):
        """`Assembly.collides` with proven short-circuits (see the module note)."""
        self.calls += 1
        terms = self._terms(part, t)
        if terms is None:
            self.exact_fallbacks += 1
            return _reference_collides(self.assembly, part, t, plain, core)
        n, plain_count, core_a, keys, occupied = terms
        if n == 0:
            return False
        if plain_count / n > plain:
            return True
        if core_a / n > core:
            return True
        if plain_count / n <= core:
            # erode(vox) is a subset of vox, so the second core term cannot
            # exceed the first plain count; the erosion cannot change the answer.
            return False
        return self._core_b(keys, occupied) / n > core


def _reference_collision(assembly, part, t):
    return type(assembly).collision(assembly, part, t)


def _reference_collides(assembly, part, t, plain, core):
    return type(assembly).collides(assembly, part, t, plain, core)


def accelerate(assembly):
    """Bind the fast predicates onto one `Assembly` instance and return it.

    `Assembly.candidates` calls `self.collision`, so patching the instance
    accelerates candidate enumeration as well as the closure without either
    caller knowing. `add` is wrapped so a body change rebuilds the snapshot
    rather than silently scoring against a stale one.
    """
    if getattr(assembly, '_fast_collider', None) is not None:
        return assembly._fast_collider
    collider = FastCollider(assembly)
    original_add = assembly.add

    def add(part, color, t):
        index = original_add(part, color, t)
        collider.refresh()
        return index

    assembly._fast_collider = collider
    assembly.collision = collider.collision
    assembly.collides = collider.collides
    assembly.add = add
    return collider
