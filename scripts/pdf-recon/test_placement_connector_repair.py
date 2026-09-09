"""Offline tests for the anti-stud reference-point repair.

Synthetic connector records plus, where the real library is present, the two
parts the measurement came from. No GPU and no reference model.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np

from placement_connector_repair import (FACE_TOL, misplaced_anti_stud, repaired_connectors)

IDENTITY = [1., 0., 0., 0., 1., 0., 0., 0., 1.]
FLIPPED_Y = [1., 0., 0., 0., -1., 0., 0., 0., 1.]


def female(pos, ori=IDENTITY, axis=None, radius=6.0, length=4.0, gender='F', kind='CYL'):
    record = dict(kind=kind, gender=gender, pos=list(pos), ori=list(ori),
                  secs=[['R', radius, length]], radius=radius, length=length)
    if axis is not None:
        record['axis'] = list(axis)
    return record


def test_the_98138_shape_is_moved_to_the_face_and_its_axis_reversed():
    """pos (0,4,0) with axis -Y on a part whose bottom face is y=8."""
    record = female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.))
    position, ori, axis = misplaced_anti_stud(record, 8.0)
    assert position == [0., 8., 0.], position
    assert np.allclose(np.asarray(ori).reshape(3, 3), np.eye(3)), ori
    assert np.allclose(axis, [0., 1., 0.]), axis


def test_a_record_already_on_the_face_is_left_alone():
    assert misplaced_anti_stud(female((0., 8., 0.), axis=(0., 1., 0.)), 8.0) is None


def test_a_bore_that_is_not_an_anti_stud_is_left_alone():
    # Right geometry, wrong radius: a Technic axle bore must not be moved.
    assert misplaced_anti_stud(female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.),
                                      radius=5.0), 8.0) is None
    # Right radius, wrong depth.
    assert misplaced_anti_stud(female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.),
                                      length=12.0), 8.0) is None
    # A male connector is never an anti-stud.
    assert misplaced_anti_stud(female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.),
                                      gender='M'), 8.0) is None
    # A non-cylindrical joint.
    assert misplaced_anti_stud(female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.),
                                      kind='CLP'), 8.0) is None


def test_an_axis_that_is_not_vertical_is_left_alone():
    sideways = [0., 0., 1., 0., 1., 0., -1., 0., 0.]
    assert misplaced_anti_stud(female((4., 4., 0.), sideways, axis=(1., 0., 0.)), 8.0) is None


def test_a_female_whose_far_end_is_not_the_face_either_is_left_alone():
    """An internal cavity, e.g. a socket in the middle of a tall part."""
    assert misplaced_anti_stud(female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.)),
                               32.0) is None


def test_the_explicit_axis_field_wins_over_the_orientation():
    """The candidate generator reads `axis`, so a disagreement must follow it."""
    disagreeing = female((0., 4., 0.), IDENTITY, axis=(0., -1., 0.))
    position, _, axis = misplaced_anti_stud(disagreeing, 8.0)
    assert position == [0., 8., 0.]
    assert np.allclose(axis, [0., 1., 0.])
    # Without an axis field the orientation's +Y column is the fallback.
    assert misplaced_anti_stud(female((0., 4., 0.), IDENTITY), 8.0) is None


def test_the_face_tolerance_is_respected_on_both_ends():
    off = FACE_TOL + 0.2
    assert misplaced_anti_stud(female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.)),
                               8.0 + off) is None


def test_a_repaired_list_keeps_every_other_record_identical():
    records = [female((0., 4., 0.), FLIPPED_Y, axis=(0., -1., 0.)),
               dict(kind='CYL', gender='M', pos=[0., 0., 0.], ori=IDENTITY,
                    secs=[['R', 9.5, 8.]], radius=9.5, length=8., axis=[0., 1., 0.])]
    out, repairs = repaired_connectors('synthetic', records, ([0., 0., 0.], [0., 8., 0.]))
    assert len(out) == 2 and len(repairs) == 1
    assert out[1] is records[1]
    assert out[0]['repaired'] == 'anti_stud_face'
    assert out[0]['original_pos'] == [0., 4., 0.]


def test_the_real_parts_behave_as_measured_when_the_library_is_present():
    try:
        from recon_v8.connectors import part_bbox, part_connectors
    except Exception:                                                       # noqa: BLE001
        print('    (skipped: recon_v8 connector library unavailable)')
        return
    _, repairs = repaired_connectors('98138pb072')
    assert len(repairs) == 1, repairs
    assert repairs[0]['from_pos'] == [0., 4., 0.] and repairs[0]['to_pos'] == [0., 8., 0.]
    # The structurally identical part that already declares the convention must
    # be untouched, and so must a plate and a brick.
    for part in ('25269', '3024', '3023b', '6091', '3031'):
        _, none = repaired_connectors(part)
        assert none == [], (part, none)


if __name__ == '__main__':
    failures = 0
    for name, function in sorted(globals().items()):
        if name.startswith('test_') and callable(function):
            try:
                function()
                print('ok  ', name)
            except AssertionError as error:
                failures += 1
                print('FAIL', name, error)
    print('failures', failures)
    sys.exit(1 if failures else 0)
