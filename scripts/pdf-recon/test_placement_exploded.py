"""Tests for exploded-piece detection and arrow-directed attachment.

Detection is tested on synthetic images with the CAD area band stubbed, so the
gate's logic is checked without a PDF. Attachment is tested against real
universal connector geometry with synthetic arrowheads placed exactly on
recipient stud caps, which is the same control `placement_arrow_contacts`
uses. No reference model, set inventory or VLM participates.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cv2
import numpy as np

import placement_exploded_page as module
from placement_exploded_page import detached_pieces, withhold
from placement_exploded_attach import attach_detached


class _StubPalette(dict):
    pass


def scene_with(blobs, size=(200, 160)):
    """White page, black-filled rectangles, mask from non-background pixels."""
    rgb = np.full((size[0], size[1], 3), 245, np.uint8)
    for x0, y0, x1, y1 in blobs:
        cv2.rectangle(rgb, (x0, y0), (x1, y1), (30, 30, 30), -1)
    return dict(rgb=rgb, mask=(rgb != 245).any(2))


def stub_bands(monkey, bands):
    module.silhouette_area_range = lambda part, color, projection, resolver=None: bands[
        (str(part), int(color))]
    return monkey


def with_stub(bands, function):
    original = module.silhouette_area_range
    module.silhouette_area_range = lambda part, color, projection, resolver=None: bands[
        (str(part), int(color))]
    palette_original = module.part_palette
    module.part_palette = lambda pieces: dict(rgb=[], complete=True)
    try:
        return function()
    finally:
        module.silhouette_area_range = original
        module.part_palette = palette_original


IDENTITY = np.array([[1., 0., 0.], [0., 1., 0.]])


def test_a_single_drawn_component_withholds_nothing():
    scene = scene_with([(10, 10, 100, 120)])
    record = with_stub({('3005', 15): (500., 900.)},
                       lambda: detached_pieces(scene, [('3005', 15)], IDENTITY,
                                               require_arrow=False))
    assert record['count'] == 0 and record['reason'] == 'single_drawn_component'


def test_a_detached_component_matching_one_allocated_shape_is_withheld():
    scene = scene_with([(10, 40, 110, 150), (30, 4, 60, 24)])
    record = with_stub({('3005', 15): (500., 900.)},
                       lambda: detached_pieces(scene, [('3005', 15), ('3005', 15)], IDENTITY,
                                               require_arrow=False))
    assert record['count'] == 1, record
    assert record['withheld'] == ['3005:15']
    assert record['withheld_keys'] == [['3005', 15]]


def test_debris_far_below_the_body_is_not_a_piece():
    scene = scene_with([(10, 40, 110, 150), (150, 5, 152, 8)])
    record = with_stub({('3005', 15): (2., 20.)},
                       lambda: detached_pieces(scene, [('3005', 15), ('3005', 15)], IDENTITY,
                                               require_arrow=False))
    assert record['count'] == 0
    assert record['components'][0]['verdict'] == 'below_body_fraction'


def test_a_component_matching_two_shapes_refuses_the_page():
    scene = scene_with([(10, 40, 110, 150), (30, 4, 60, 24)])
    record = with_stub({('3005', 15): (500., 900.), ('3010', 15): (500., 900.)},
                       lambda: detached_pieces(scene, [('3005', 15), ('3010', 15)], IDENTITY,
                                               require_arrow=False))
    assert record['count'] == 0
    assert record['reason'] == 'ambiguous_detached_component'


def test_withholding_every_allocated_piece_is_refused():
    scene = scene_with([(10, 40, 110, 150), (30, 4, 60, 24)])
    record = with_stub({('3005', 15): (500., 900.)},
                       lambda: detached_pieces(scene, [('3005', 15)], IDENTITY,
                                               require_arrow=False))
    assert record['count'] == 0
    assert record['reason'] == 'every_allocated_piece_is_detached'


def test_an_arrowless_page_is_left_alone_by_default():
    scene = scene_with([(10, 40, 110, 150), (30, 4, 60, 24)])
    record = with_stub({('3005', 15): (500., 900.)},
                       lambda: detached_pieces(scene, [('3005', 15), ('3005', 15)], IDENTITY))
    assert record['count'] == 0 and record['reason'] == 'no_accepted_arrow'


def test_withhold_partitions_the_allocation():
    pieces = [('3005', 15), ('3005', 15), ('3010', 4)]
    kept, taken = withhold(pieces, [['3005', 15]])
    assert taken == [('3005', 15)]
    assert kept == [('3005', 15), ('3010', 4)]
    assert len(kept) + len(taken) == len(pieces)
    try:
        withhold(pieces, [['9999', 0]])
    except ValueError:
        pass
    else:
        raise AssertionError('A withheld piece outside the allocation must raise')


def _stud_arrows(part, base, M, origin, count):
    from placement_arrow_contacts import transformed_connectors
    males = [c for c in transformed_connectors(part, base, 'M') if c['radius'] == 6]
    caps = [c['pos'] - c['axis'] * c['length'] for c in males][:count]
    direction = (M @ np.array([0., 1., 0.])).tolist()
    return [dict(head=(M @ cap + origin).tolist(), direction=direction) for cap in caps]


def test_attachment_selects_the_arrow_supported_pose():
    M = np.array([[1., 0, -1.], [.5, 1., .5]])
    origin = np.array([100., 100.])
    base = np.eye(4)
    stacked = np.eye(4)
    stacked[1, 3] = -8.
    elsewhere = np.eye(4)
    elsewhere[0, 3] = 60.
    poses = [dict(part='2420', T=elsewhere.tolist()), dict(part='2420', T=stacked.tolist())]
    arrows = _stud_arrows('2420', base, M, origin, 2)
    placed, record = attach_detached([('2420', 15, base)], [('2420', 15)], poses,
                                     M, origin, arrows)
    assert record['status'] == 'placed', record
    assert len(placed) == 1
    assert np.allclose(placed[0][2], stacked)
    assert record['steps'][0]['mean_head_error_px'] < 1e-6


def test_attachment_abstains_when_no_pose_has_contact_support():
    M = np.array([[1., 0, -1.], [.5, 1., .5]])
    origin = np.array([100., 100.])
    base = np.eye(4)
    far = np.eye(4)
    far[0, 3] = 400.
    arrows = _stud_arrows('2420', base, M, origin, 2)
    placed, record = attach_detached([('2420', 15, base)], [('2420', 15)],
                                     [dict(part='2420', T=far.tolist())], M, origin, arrows)
    assert placed == [] and record['status'] == 'abstained'
    assert record['reason'] == 'no_contact_support'


def test_attachment_abstains_when_the_shape_has_no_enumerated_pose():
    M = np.array([[1., 0, -1.], [.5, 1., .5]])
    origin = np.array([100., 100.])
    arrows = _stud_arrows('2420', np.eye(4), M, origin, 2)
    placed, record = attach_detached([('2420', 15, np.eye(4))], [('3005', 15)],
                                     [dict(part='2420', T=np.eye(4).tolist())], M, origin, arrows)
    assert placed == [] and record['reason'] == 'no_enumerated_pose'


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
