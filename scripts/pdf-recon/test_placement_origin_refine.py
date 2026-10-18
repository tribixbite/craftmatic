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


def test_proportional_allowance_accepts_overflow_from_a_flawed_body():
    # 1% of a 1000-pixel body is a 10-pixel allowance; the exact origin is one
    # step away and overflows by 7.
    result = refine([], [dict(projection=IDENTITY, origin=[10, 12], score=0.9,
                              rotation_index=0)],
                    None, window=2, tolerance=0, fraction=0.01,
                    screen_fn=make_screen([10, 13]))
    assert result['retained'] == 1
    assert result['hypotheses'][0]['outside_pixels'] == 7
    assert result['proportional_allowance'] == 0.01


def test_fallback_returns_the_least_overflowing_view_flagged_uncontained():
    hypotheses = [dict(projection=ROTATED, origin=[0, 0], score=0.9, rotation_index=9),
                  dict(projection=ROTATED, origin=[5, 5], score=0.4, rotation_index=3)]
    strict = refine([], hypotheses, None, window=1, screen_fn=make_screen([0, 0]))
    assert strict['retained'] == 0
    lenient = refine([], hypotheses, None, window=1, fallback=1,
                     screen_fn=make_screen([0, 0]))
    assert lenient['retained'] == 1
    assert lenient['containment_fallback_used'] is True
    best = lenient['hypotheses'][0]
    assert best['contained'] is False
    assert best['containment_fallback'] is True
    assert best['outside_pixels'] == 200


def test_fallback_is_not_used_when_something_is_contained():
    result = refine([], [dict(projection=IDENTITY, origin=[10, 13], score=0.9,
                              rotation_index=0)],
                    None, window=1, fallback=4, screen_fn=make_screen([10, 13]))
    assert result['containment_fallback_used'] is False
    assert result['hypotheses'][0]['contained'] is True


def test_invalid_allowances_are_rejected():
    with pytest.raises(ValueError):
        refine([], [], None, fraction=1.5, screen_fn=make_screen([0, 0]))
    with pytest.raises(ValueError):
        refine([], [], None, fallback=-1, screen_fn=make_screen([0, 0]))
    with pytest.raises(ValueError):
        refine([], [], None, relative_multiple=-1, screen_fn=make_screen([0, 0]))
    with pytest.raises(ValueError):
        refine([], [], None, relative_cap=1.0, screen_fn=make_screen([0, 0]))


def fixed_screen(table):
    """Screen returning a stated (outside, occupied, covered) per origin.

    Keys are the integer origin the caller probes; anything else is far worse,
    so each hypothesis's best offset is the one the table names.
    """
    def screen_fn(base, placements, projection, origin, scorer):
        key = (int(round(origin[0])), int(round(origin[1])))
        outside, occupied, covered = table.get(key, (10 ** 6, 1000, 0))
        return dict(base=dict(outside_pixels=outside, occupied_pixels=occupied,
                              covered_pixels=covered, target_pixels=1000,
                              allowed=outside == 0))
    return screen_fn


# Page index 22 of 40377, to the pixel: two propagated registrations that cover
# 92.4% and 90.3% of the drawing and overflow by 1,199 and 669 pixels, against
# body-template alternatives that are contained and cover 76-80%.
PAGE22 = fixed_screen({(0, 0): (1199, 57638, 55026),
                       (10, 0): (669, 55333, 53777),
                       (20, 0): (147, 46380, 45953),
                       (30, 0): (273, 48244, 47540)})
PAGE22_HYPOTHESES = [dict(projection=IDENTITY, origin=[0, 0], score=0.892, rotation_index=3),
                     dict(projection=IDENTITY, origin=[10, 0], score=0.890, rotation_index=3),
                     dict(projection=IDENTITY, origin=[20, 0], score=0.306, rotation_index=23),
                     dict(projection=IDENTITY, origin=[30, 0], score=0.310, rotation_index=23)]


def test_the_absolute_allowance_alone_keeps_only_the_small_registrations():
    result = refine([], PAGE22_HYPOTHESES, None, window=0, fraction=0.01,
                    screen_fn=PAGE22)
    kept = {row['source_index'] for row in result['hypotheses']}
    assert kept == {2, 3}
    assert result['relative_admissions'] == 0


def test_the_within_page_rule_admits_the_high_coverage_registration():
    result = refine([], PAGE22_HYPOTHESES, None, window=0, fraction=0.01,
                    relative_multiple=4.0, screen_fn=PAGE22)
    kept = {row['source_index'] for row in result['hypotheses']}
    # 669/55,333 is 1.209% against a 0.317% floor; 1,199/57,638 is 2.081% and
    # stays out, so the rule is not "admit everything".
    assert kept == {1, 2, 3}
    admitted = next(row for row in result['hypotheses'] if row['source_index'] == 1)
    assert admitted['admission'] == 'relative'
    assert admitted['outside_pixels'] == 669
    assert result['relative_admissions'] == 1


def test_coverage_ordering_prefers_the_ninety_per_cent_registration():
    result = refine([], PAGE22_HYPOTHESES, None, window=0, fraction=0.01,
                    relative_multiple=4.0, coverage_order=True, screen_fn=PAGE22)
    assert [row['source_index'] for row in result['hypotheses']] == [1, 3, 2]


def test_the_rule_is_inert_when_something_is_cleanly_contained():
    # A page whose best hypothesis overflows by nothing has a zero floor, so the
    # relative allowance collapses to the absolute one and admits nothing extra.
    screen = fixed_screen({(0, 0): (0, 40000, 39000), (10, 0): (900, 50000, 48000)})
    hypotheses = [dict(projection=IDENTITY, origin=[0, 0], score=0.5, rotation_index=0),
                  dict(projection=IDENTITY, origin=[10, 0], score=0.9, rotation_index=0)]
    strict = refine([], hypotheses, None, window=0, fraction=0.01, screen_fn=screen)
    loose = refine([], hypotheses, None, window=0, fraction=0.01, relative_multiple=4.0,
                   screen_fn=screen)
    assert ({r['source_index'] for r in strict['hypotheses']}
            == {r['source_index'] for r in loose['hypotheses']} == {0})
    assert loose['overflow_ratio_floor'] == 0.0
    assert loose['relative_admissions'] == 0


def test_a_page_with_no_registration_worth_comparing_against_is_left_alone():
    # 40377 page index 26's second drawing: the best hypothesis overflows by
    # 7.3% of its own area, so there is no reference and the rule withholds.
    screen = fixed_screen({(0, 0): (2072, 28369, 25596), (10, 0): (9825, 36976, 26386)})
    hypotheses = [dict(projection=IDENTITY, origin=[0, 0], score=0.4, rotation_index=0),
                  dict(projection=IDENTITY, origin=[10, 0], score=0.9, rotation_index=0)]
    result = refine([], hypotheses, None, window=0, fraction=0.01, relative_multiple=4.0,
                    screen_fn=screen)
    assert result['hypotheses'] == []
    assert result['relative_ratio_ceiling'] is None
    assert round(result['overflow_ratio_floor'], 5) == round(2072 / 28369, 5)


def test_the_cap_bounds_the_relative_allowance():
    # A 1% floor would admit 4% at multiple four; the cap holds it to 3%.
    screen = fixed_screen({(0, 0): (100, 10000, 9000), (10, 0): (350, 10000, 9500),
                           (20, 0): (250, 10000, 9400)})
    hypotheses = [dict(projection=IDENTITY, origin=[o, 0], score=0.5, rotation_index=0)
                  for o in (0, 10, 20)]
    result = refine([], hypotheses, None, window=0, tolerance=0, relative_multiple=4.0,
                    relative_cap=0.03, screen_fn=screen)
    assert {row['source_index'] for row in result['hypotheses']} == {0, 2}
    assert result['relative_ratio_ceiling'] == 0.03
