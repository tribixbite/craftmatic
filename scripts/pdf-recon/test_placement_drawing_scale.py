"""Offline tests for drawing-to-drawing scale measurement. Synthetic masks only."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cv2
import numpy as np

from placement_drawing_scale import DEFAULT_LADDER, align, scaled_matrices


def blob(size=(140, 120), scale=1.0, shift=(0, 0)):
    mask = np.zeros(size, bool)
    cv2.rectangle(mask.view(np.uint8), (30, 40), (80, 100), 1, -1)
    cv2.circle(mask.view(np.uint8), (55, 35), 14, 1, -1)
    mask = mask.view(np.uint8) > 0
    if scale != 1.0:
        mask = cv2.resize(mask.astype(np.uint8), None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_NEAREST) > 0
    canvas = np.zeros(size, bool)
    dy, dx = shift
    h = min(size[0] - max(0, dy), mask.shape[0])
    w = min(size[1] - max(0, dx), mask.shape[1])
    canvas[max(0, dy):max(0, dy) + h, max(0, dx):max(0, dx) + w] = mask[:h, :w]
    return canvas


def test_identical_drawings_measure_scale_one():
    a = blob()
    result = align(a, a, scales=(0.9, 0.95, 1.0, 1.05, 1.1))
    assert result['scale'] == 1.0
    assert result['iou'] > .99


def test_a_translated_copy_is_still_scale_one():
    a = blob()
    b = blob(shift=(11, 7))
    result = align(a, b, scales=(0.95, 1.0, 1.05))
    assert result['scale'] == 1.0
    assert result['iou'] > .95
    assert result['offset'] == [7, 11]


def test_a_scaled_copy_recovers_its_scale():
    a = blob()
    b = blob(scale=1.2)
    result = align(a, b, scales=(1.0, 1.1, 1.2, 1.3))
    assert result['scale'] == 1.2, result['scale']
    assert result['iou'] > .9


def test_a_grown_drawing_still_prefers_a_scale_near_one():
    """A later page draws the same assembly plus a piece, not a bigger one."""
    a = blob()
    b = blob().copy()
    cv2.rectangle(b.view(np.uint8), (82, 60), (95, 78), 1, -1)
    result = align(a, b, scales=DEFAULT_LADDER)
    assert .98 <= result['scale'] <= 1.08, result['scale']


def test_empty_input_is_refused_and_the_ladder_is_validated():
    a = blob()
    for bad in (np.zeros_like(a), None):
        try:
            align(a, np.zeros_like(a) if bad is None else bad)
        except ValueError:
            pass
        else:
            raise AssertionError('An empty drawing must be refused')
    try:
        align(a, a, scales=(0.0,))
    except ValueError:
        pass
    else:
        raise AssertionError('A non-positive scale must be refused')


def test_the_ladder_is_retained_for_inspection():
    result = align(blob(), blob(), scales=(0.9, 1.0, 1.1))
    assert len(result['ladder']) == 3
    assert all('iou' in row and 'offset' in row for row in result['ladder'])
    assert result['truth_used'] is False and result['runtime_vlm_calls'] == 0


def test_scaled_matrices_abstains_near_one_and_scales_otherwise():
    matrix = [[1., 0., -1.], [.5, 1., .5]]
    assert scaled_matrices([matrix], 1.005) == []
    assert scaled_matrices([], 1.5) == []
    out = scaled_matrices([matrix], 1.03)
    assert len(out) == 1
    assert abs(out[0][0][0] - 1.03) < 1e-9


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
