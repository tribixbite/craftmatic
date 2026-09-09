"""The vectorised collision predicate must agree with the scalar one exactly.

A faster predicate that answers a slightly different question would change every
bank it touches while looking like a pure speedup, so the property under test is
equality - not closeness - against `recon_v8.assembly.Assembly`'s own methods,
over transforms taken from the same connector enumeration the closure uses.

These run against the local LDraw library (the surface-sample cache in
`C:/git/clego`), like the rest of this directory's geometry tests.
"""
import numpy as np
import pytest

import placement_fast_collision as fast
from placement_attach_group import make_assembly

Assembly = None


@pytest.fixture(scope='module')
def body():
    """A small stack of real bricks, with its reference and fast predicates."""
    global Assembly
    from recon_v8.assembly import Assembly as RealAssembly
    Assembly = RealAssembly
    items = [('3001', 15, np.eye(4)),
             ('3001', 4, np.array([[1., 0, 0, 0], [0, 1, 0, -24.], [0, 0, 1, 0], [0, 0, 0, 1]])),
             ('3024', 1, np.array([[1., 0, 0, 20.], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]))]
    assembly = make_assembly(items)
    return assembly, fast.FastCollider(assembly)


def transforms(assembly, part, limit=200):
    """Real mate transforms, plus deliberate deep overlaps and clean misses."""
    out = [candidate['T'] for candidate in
           assembly.candidates(part, kinds=('CYL', 'CLP', 'FGR', 'GEN'),
                               check_collision=False, check_occlusion=False)[:limit]]
    for offset in (0., 2., 4., 6., 10., 400.):
        T = np.eye(4)
        T[:3, 3] = (offset, -offset / 2, offset / 3)
        out.append(T)
    return out


@pytest.mark.parametrize('part', ['3024', '3001'])
def test_collision_tuple_is_identical(body, part):
    assembly, collider = body
    for T in transforms(assembly, part):
        assert Assembly.collision(assembly, part, T) == collider.collision(part, T)


@pytest.mark.parametrize('part', ['3024', '3001'])
def test_collides_verdict_is_identical(body, part):
    """The short-circuits in `collides` must not change a single verdict."""
    assembly, collider = body
    for T in transforms(assembly, part):
        assert Assembly.collides(assembly, part, T) == collider.collides(part, T)


def test_voxel_keys_match_the_scalar_voxelisation(body):
    """The packed key set is the same set the pure-Python loop builds."""
    from recon_v8.assembly import Placed
    assembly, _ = body
    for T in transforms(assembly, '3024', limit=20):
        scalar = Placed('3024', 0, T).voxels()
        keys = fast.part_voxel_keys('3024', T)
        assert keys is not None
        rebuilt = {(int(k // fast._DX) - fast._OFF,
                    int(k % fast._DX // fast._DY) - fast._OFF,
                    int(k % fast._DY) - fast._OFF) for k in keys}
        assert rebuilt == scalar


def test_erosion_matches_the_reference(body):
    """`_erode` reproduces `assembly.erode`, and the restricted form matches it."""
    from recon_v8.assembly import Placed, erode
    assembly, collider = body
    T = np.eye(4)
    T[:3, 3] = (0., -48., 0.)
    voxels = Placed('3001', 0, T).voxels()
    keys = fast.part_voxel_keys('3001', T)
    assert len(erode(voxels)) == fast._erode(keys).size
    # Restricting the probes to an arbitrary subset must not change which of
    # THOSE probes survive, because erosion is judged against the whole set.
    subset = keys[::3]
    assert set(fast._erode(keys, subset).tolist()) == set(fast._erode(keys).tolist()) & set(
        subset.tolist())


def test_accelerate_refreshes_when_the_body_changes(body):
    """A part added after acceleration must be visible to the fast predicate."""
    items = [('3001', 15, np.eye(4))]
    assembly = make_assembly(items)
    collider = fast.accelerate(assembly)
    before = collider.occ_keys.size
    T = np.eye(4)
    T[:3, 3] = (0., -24., 0.)
    assembly.add('3001', 4, T)
    assert collider.occ_keys.size > before
    probe = np.eye(4)
    probe[:3, 3] = (0., -48., 0.)
    assert Assembly.collides(assembly, '3001', probe) == assembly.collides('3001', probe)


def test_registry_bank_is_unchanged_by_acceleration():
    """The whole recorded bank must be identical with and without the fast path."""
    import placement_multi_shape_batch as multi
    base = [('3001', 15, np.eye(4)),
            ('3001', 4, np.array([[1., 0, 0, 0], [0, 1, 0, -24.], [0, 0, 1, 0], [0, 0, 0, 1]]))]
    pieces = [('3024', 1)]
    records = []
    for flag in (False, True):
        original = multi.FAST_COLLISION
        multi.FAST_COLLISION = flag
        try:
            records.append(multi.registry(base, pieces, closure_rounds=1,
                                          max_closure_parents=32, max_poses=512))
        finally:
            multi.FAST_COLLISION = original
    slow, quick = records
    for record in (slow, quick):
        record.pop('seconds')
    assert slow['poses'] == quick['poses']
    assert slow == quick
