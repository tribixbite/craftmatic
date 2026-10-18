"""Offline tests for drawing-to-drawing camera propagation. Synthetic masks only.

The property under test is arithmetic and exactly checkable: if a synthetic
"world" is drawn twice under known projections related by a uniform similarity,
propagating the first drawing's registration through the measured alignment must
recover the second drawing's projection and origin.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np

from placement_drawing_registration import MIN_IOU, propagate

WORLD = np.array([[0., 0., 0.], [40., 0., 0.], [40., 0., 40.], [0., 0., 40.],
                  [0., -24., 0.], [40., -24., 0.], [40., -24., 40.], [0., -24., 40.],
                  [20., -40., 20.], [8., -12., 32.]])
EXTRA = np.array([[52., -8., 20.], [52., -24., 20.], [60., -16., 28.]])
PROJECTION = np.array([[1.6, 0.0, -1.1], [0.7, 1.4, 0.6]])


def draw(points, projection, origin, size, radius=5):
    """Rasterise discs at `projection @ point + origin`, the same convention the
    registration uses."""
    mask = np.zeros(size, bool)
    pixels = np.asarray(points, float) @ np.asarray(projection, float).T + np.asarray(origin, float)
    ys, xs = np.mgrid[0:size[0], 0:size[1]]
    for x, y in pixels:
        mask |= (xs - x) ** 2 + (ys - y) ** 2 <= radius ** 2
    return mask


def test_a_pure_translation_between_drawings_moves_only_the_origin():
    origin = np.array([60., 70.])
    shift = np.array([13., -9.])
    previous = draw(WORLD, PROJECTION, origin, (200, 220))
    current = draw(WORLD, PROJECTION, origin + shift, (200, 220))
    result = propagate(previous, current, PROJECTION, origin, scales=(0.98, 1.0, 1.02))
    assert result['status'] == 'propagated'
    best = result['hypotheses'][0]
    assert best['drawing_scale'] == 1.0
    assert np.allclose(best['projection'], PROJECTION)
    assert np.allclose(best['origin'], origin + shift, atol=1.0), best['origin']


def test_a_scaled_drawing_recovers_both_the_projection_and_the_origin():
    origin = np.array([50., 60.])
    scale = 1.05
    previous = draw(WORLD, PROJECTION, origin, (220, 240))
    current = draw(WORLD, PROJECTION * scale, origin * scale + np.array([6., 4.]), (240, 260),
                   radius=int(round(5 * scale)))
    result = propagate(previous, current, PROJECTION, origin,
                       scales=(1.0, 1.03, 1.05, 1.07), keep=1)
    best = result['hypotheses'][0]
    assert best['drawing_scale'] == scale, best['drawing_scale']
    assert np.allclose(best['projection'], PROJECTION * scale)
    assert np.allclose(best['origin'], origin * scale + np.array([6., 4.]), atol=2.0), best['origin']


def test_the_pieces_a_step_adds_do_not_move_the_registration():
    """The later drawing holds the body plus new pieces; the body still aligns."""
    origin = np.array([55., 65.])
    previous = draw(WORLD, PROJECTION, origin, (220, 240))
    current = draw(np.vstack([WORLD, EXTRA]), PROJECTION, origin, (220, 240))
    result = propagate(previous, current, PROJECTION, origin, keep=1)
    best = result['hypotheses'][0]
    assert abs(best['drawing_scale'] - 1.0) <= 0.02, best['drawing_scale']
    assert np.allclose(best['origin'], origin, atol=2.0), best['origin']


def test_a_different_viewpoint_is_refused_rather_than_propagated():
    origin = np.array([60., 70.])
    other = np.array([[-1.6, 0.0, 1.1], [0.7, -1.4, 0.6]])
    previous = draw(WORLD, PROJECTION, origin, (220, 240))
    current = draw(WORLD, other, np.array([150., 150.]), (220, 240))
    result = propagate(previous, current, PROJECTION, origin)
    assert result['status'] == 'not_propagated'
    assert result['hypotheses'] == []
    assert 'viewpoint' in result['reason']


def test_the_body_is_never_consulted_and_bad_input_is_refused():
    origin = np.array([60., 70.])
    previous = draw(WORLD, PROJECTION, origin, (200, 220))
    assert propagate(previous, np.zeros_like(previous), PROJECTION,
                     origin)['status'] == 'not_propagated'
    for bad in (dict(projection=np.eye(3)), dict(origin=np.zeros(3)),
                dict(keep=0), dict(min_iou=1.5)):
        arguments = dict(projection=PROJECTION, origin=origin)
        arguments.update(bad)
        try:
            propagate(previous, previous, **arguments)
        except ValueError:
            continue
        raise AssertionError(f'Invalid input {bad} must be refused')


def test_the_unit_scale_is_offered_beside_a_growth_biased_optimum():
    """A drawing grown by new pieces optimises above the true camera ratio, so
    an unchanged camera must stay on the table."""
    origin = np.array([55., 65.])
    previous = draw(WORLD, PROJECTION, origin, (220, 240))
    current = draw(np.vstack([WORLD, EXTRA]), PROJECTION, origin, (220, 240))
    result = propagate(previous, current, PROJECTION, origin, keep=2)
    scales = [row['drawing_scale'] for row in result['hypotheses']]
    assert 1.0 in scales, scales
    assert len(set(scales)) == 2, scales
    unit = next(row for row in result['hypotheses'] if row['drawing_scale'] == 1.0)
    assert np.allclose(unit['projection'], PROJECTION)


def test_keeping_more_of_the_ladder_returns_ordered_alternatives():
    origin = np.array([60., 70.])
    previous = draw(WORLD, PROJECTION, origin, (220, 240))
    current = draw(WORLD, PROJECTION, origin, (220, 240))
    result = propagate(previous, current, PROJECTION, origin, keep=3)
    assert len(result['hypotheses']) == 3
    scores = [row['score'] for row in result['hypotheses']]
    # The contract is that the best agreement leads; the unit scale is inserted
    # next whatever its agreement, and the remainder follow by agreement.
    assert scores[0] == max(scores)
    assert scores[2:] == sorted(scores[2:], reverse=True)
    assert result['min_iou'] == MIN_IOU
    assert result['truth_used'] is False and result['runtime_vlm_calls'] == 0


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
