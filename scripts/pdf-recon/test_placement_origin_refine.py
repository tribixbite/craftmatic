"""Offline checks for containment-based registration refinement."""
import numpy as np
import pytest

from placement_origin_refine import refine


def make_screen(true_origin, overflow_at_distance=200):
    """Synthetic screen: overflow grows with distance from one true origin."""
    def screen_fn(base, placements, projection, origin, scorer):
        offset = np.asarray(origin, float) - np.asarray(true_origin, float)
        distance = int(round(abs(offset[0]) + abs(offset[1])))
        rotated = not np.allclose(projection, np.eye(2, 3), atol=1e-9)
        outside = overflow_at_distance if rotated else distance * 7
        return dict(base=dict(outside_pixels=outside, occupied_pixels=1000,
                              allowed=outside == 0))
    return screen_fn


IDENTITY = np.eye(2, 3).tolist()
ROTATED = (np.eye(2, 3) * 2).tolist()


def test_recovers_quantized_origin_with_smallest_correction():
    result = refine([], [dict(projection=IDENTITY, origin=[10, 10], score=0.9,
                              rotation_index=0)],
                    None, window=3, tolerance=0, screen_fn=make_screen([10, 13]))
    assert result['retained'] == 1
    best = result['hypotheses'][0]
    assert best['origin'] == [10, 13]
    assert best['applied_offset'] == [0, 3]
    assert best['outside_pixels'] == 0


def test_rejects_orientation_that_cannot_contain_the_body():
    result = refine([], [dict(projection=ROTATED, origin=[0, 0], score=0.8,
                              rotation_index=9)],
                    None, window=2, tolerance=0, screen_fn=make_screen([0, 0]))
    assert result['retained'] == 0
    assert result['rejected'] == 1
    assert result['evaluated'][0]['best_containment']['outside_pixels'] == 200


def test_distinct_hypotheses_converging_to_one_origin_are_deduplicated():
    hypotheses = [dict(projection=IDENTITY, origin=[10, 10], score=0.9, rotation_index=0),
                  dict(projection=IDENTITY, origin=[11, 12], score=0.7, rotation_index=0)]
    result = refine([], hypotheses, None, window=3, tolerance=0,
                    screen_fn=make_screen([10, 13]))
    assert result['retained'] == 1
    assert result['duplicates'] == 1
    assert result['evaluated'][1]['duplicate_of'] == 0


def test_tolerance_accepts_bounded_overflow_but_still_prefers_small_offsets():
    result = refine([], [dict(projection=IDENTITY, origin=[10, 10], score=0.9,
                              rotation_index=0)],
                    None, window=3, tolerance=7, screen_fn=make_screen([10, 13]))
    best = result['hypotheses'][0]
    # Overflow grows by 7 per pixel of distance, so the nearest offset within a
    # 7-pixel tolerance is one short of the exact origin, not the exact origin.
    assert best['outside_pixels'] == 7
    assert best['applied_offset'] == [0, 2]


def test_invalid_search_parameters_are_rejected():
    with pytest.raises(ValueError):
        refine([], [], None, window=-1, screen_fn=make_screen([0, 0]))
    with pytest.raises(ValueError):
        refine([], [], None, window=1, tolerance=-1, screen_fn=make_screen([0, 0]))


def test_zero_window_only_tests_the_supplied_origin():
    calls = []

    def screen_fn(base, placements, projection, origin, scorer):
        calls.append(tuple(np.asarray(origin, float)))
        return dict(base=dict(outside_pixels=0, occupied_pixels=10, allowed=True))

    result = refine([], [dict(projection=IDENTITY, origin=[4, 5], score=1.0,
                              rotation_index=0)], None, window=0, screen_fn=screen_fn)
    assert calls == [(4.0, 5.0)]
    assert result['hypotheses'][0]['origin'] == [4, 5]
