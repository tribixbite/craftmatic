"""Offline checks for the absent-allocated-colour measurement and its rule.

No GPU, no PDF and no reference model: the arrays are synthetic and the colours
are the two real LDraw entries the defect turns on.
"""
import numpy as np
import pytest

from placement_absent_class import (agreement, class_histogram, classify, composite_metric,
                                    one_placement_per_key, target_absent, withholding_verdict)


COLORS = [0, 1, 15, 19, 29, 71, 72, 191, 322]


def pin_silhouette(monkeypatch, areas):
    """Pin the denominator so the rule itself is what is under test."""
    import placement_exploded_page
    monkeypatch.setattr(placement_exploded_page, 'silhouette_area_range',
                        lambda part, color, projection, resolver=None: (areas[color],
                                                                        areas[color] * 2))


def test_class_histogram_counts_one_based_classes_and_the_unclassified():
    labels = np.array([[0, 1, 1], [8, 8, 3]], np.uint8)
    counts, unclassified = class_histogram(labels, COLORS)
    assert counts[0] == 2 and counts[191] == 2 and counts[15] == 1
    assert counts[322] == 0 and unclassified == 1


def test_page_twenty_six_is_absent_and_page_sixteen_is_not(monkeypatch):
    # 40377 page 26: the run's own target holds 0 pixels of class 191 against a
    # 1,960-pixel plate, while page 16's white is 11,896 against 11,139.
    pin_silhouette(monkeypatch, {191: 1959.6, 15: 11139.0})
    target = np.zeros((200, 200), np.uint8)
    target[:100] = 4  # 20,000 pixels of class 4, which is LDraw 19 (Tan)
    rows, withheld = target_absent(target, COLORS, [('3023b', 191)] * 4, np.eye(2, 3))
    assert [row['absent'] for row in rows] == [True]
    assert rows[0]['target_pixels'] == 0 and rows[0]['target_share'] == 0.0
    assert withheld == [['3023b', 191]] * 4

    target[:100] = 3  # class 3 is LDraw 15, and 20,000 pixels is 1.8 plates
    rows, withheld = target_absent(target, COLORS, [('3020', 15)], np.eye(2, 3))
    assert [row['absent'] for row in rows] == [False] and withheld == []


def test_an_allocated_colour_outside_the_bank_palette_is_refused(monkeypatch):
    pin_silhouette(monkeypatch, {5: 100.0})
    with pytest.raises(ValueError):
        target_absent(np.zeros((4, 4), np.uint8), COLORS, [('3020', 5)], np.eye(2, 3))


def test_an_invalid_share_is_rejected():
    with pytest.raises(ValueError):
        target_absent(np.zeros((4, 4), np.uint8), COLORS, [('3020', 15)], np.eye(2, 3),
                      min_share=0.0)
    with pytest.raises(ValueError):
        target_absent(np.zeros((4, 4), np.uint8), COLORS, [('3020', 15)], np.eye(2, 3),
                      min_share=1.0)


def test_withholding_the_whole_allocation_is_refused_on_both_shipped_gates():
    # 40377 page 26 allocates four pieces and all four are the absent colour, so
    # the split leaves nothing for the image search - and the page has no arrow
    # to place them with either.
    pieces = [('3023b', 191)] * 4
    verdict = withholding_verdict(pieces, pieces, arrows=[])
    assert not verdict['applicable'] and verdict['image_pieces'] == []
    assert any('fewer than two' in reason for reason in verdict['refusals'])
    assert any('no accepted arrowhead' in reason for reason in verdict['refusals'])


def test_withholding_is_applicable_only_with_two_kept_pieces_and_an_arrow():
    pieces = [('3023b', 191), ('3020', 15), ('3020', 15)]
    withheld = [('3023b', 191)]
    assert withholding_verdict(pieces, withheld, arrows=['a'])['applicable']
    assert not withholding_verdict(pieces, withheld, arrows=[])['applicable']
    assert not withholding_verdict(pieces, pieces[:2], arrows=['a'])['applicable']
    assert withholding_verdict(pieces, [], arrows=['a'])['refusals'] == [
        'no allocated colour is absent from the target']


def _bank(base_label, candidate_labels, in_front=True):
    """A bank of explicit label layers: unpainted pixels carry no depth."""
    base_label = np.asarray(base_label, np.uint8)
    base_depth = np.where(base_label > 0, 1., -np.inf)
    labels = np.asarray(candidate_labels, np.uint8)
    depths = np.where(labels > 0, 2. if in_front else 0., -np.inf)
    return base_depth, base_label, depths, labels


# The page-26 shape: class 8 is the allocated colour, class 3 the body's. The
# body explains the class-3 ink and paints nothing where the class-8 ink is.
TARGET_WITH_ORANGE = np.array([[8, 8, 3], [3, 3, 3], [0, 0, 0]], np.uint8)
TARGET_WITHOUT_ORANGE = np.array([[4, 4, 3], [3, 3, 3], [0, 0, 0]], np.uint8)
BODY = [[0, 0, 3], [3, 3, 3], [0, 0, 0]]
ON_ITS_INK = [[[8, 8, 0], [0, 0, 0], [0, 0, 0]]]
OVER_THE_BODY = [[[0, 0, 8], [8, 8, 8], [0, 0, 0]]]
OUTSIDE_EVERYTHING = [[[0, 0, 0], [0, 0, 0], [8, 8, 8]]]


def test_a_class_absent_from_the_target_can_only_occlude_never_agree():
    # Why every page-26 candidate scores zero agreement: with 8 unclassified in
    # the target it adds nothing, and over correctly labelled body ink it removes.
    bank = _bank(BODY, OVER_THE_BODY)
    before = composite_metric(*bank, (), TARGET_WITHOUT_ORANGE)
    after = composite_metric(*bank, (0,), TARGET_WITHOUT_ORANGE)
    assert after < before
    assert agreement(np.asarray(OVER_THE_BODY[0]), TARGET_WITHOUT_ORANGE) == 0.0


def test_painting_an_unscored_class_where_the_body_paints_nothing_is_exactly_neutral():
    # 40377 page 26's three locatable reference poses, to the bit: their visible
    # pixels fall outside the body, so no scored class's intersection or union
    # changes and the composite is identical.
    bank = _bank(BODY, OUTSIDE_EVERYTHING)
    assert (composite_metric(*bank, (0,), TARGET_WITHOUT_ORANGE)
            == composite_metric(*bank, (), TARGET_WITHOUT_ORANGE))
    # And it stays neutral once the class IS scored, because a zero intersection
    # is a zero IoU however large the union grows.
    assert (composite_metric(*bank, (0,), TARGET_WITH_ORANGE)
            == composite_metric(*bank, (), TARGET_WITH_ORANGE))


def test_scoring_the_class_rewards_only_a_pose_that_lands_on_its_own_ink():
    # Repairing the classifier moves a pose over the drawing's orange and does
    # not move one that is nowhere near it - which is the measured page-26 split
    # between the run's wrong picks and the reference poses.
    on_ink = _bank(BODY, ON_ITS_INK)
    assert (composite_metric(*on_ink, (0,), TARGET_WITH_ORANGE)
            > composite_metric(*on_ink, (), TARGET_WITH_ORANGE))
    # Unscored, the same pose is worth nothing at all.
    assert (composite_metric(*on_ink, (0,), TARGET_WITHOUT_ORANGE)
            == composite_metric(*on_ink, (), TARGET_WITHOUT_ORANGE))


def test_a_pose_behind_the_body_changes_nothing_either_way():
    bank = _bank(BODY, OVER_THE_BODY, in_front=False)
    assert (composite_metric(*bank, (0,), TARGET_WITH_ORANGE)
            == composite_metric(*bank, (), TARGET_WITH_ORANGE))


def test_a_target_with_no_scored_class_is_refused():
    bank = _bank(BODY, ON_ITS_INK)
    with pytest.raises(ValueError):
        composite_metric(*bank, (), np.zeros((3, 3), np.uint8))


def test_ldraw_19_and_191_tie_on_hue_so_palette_order_decides_the_winner():
    # The root cause, on the real colours: an image of pure Bright Light Orange
    # classifies as Tan when Tan is listed first, and as itself when it is.
    from placement_colored_cad import _rgb
    orange = np.tile(np.asarray(_rgb(191), np.uint8), (3, 3, 1))
    tan = np.tile(np.asarray(_rgb(19), np.uint8), (3, 3, 1))
    mask = np.ones((3, 3), bool)
    assert set(np.unique(classify(orange, mask, [19, 191]))) == {1}    # -> 19
    assert set(np.unique(classify(orange, mask, [191, 19]))) == {1}    # -> 191
    assert set(np.unique(classify(tan, mask, [19, 191]))) == {1}       # -> 19
    assert set(np.unique(classify(tan, mask, [191, 19]))) == {1}       # -> 191, wrongly


def test_the_saturation_tiebreak_makes_both_palette_orders_agree():
    from placement_colored_cad import _rgb
    orange = np.tile(np.asarray(_rgb(191), np.uint8), (3, 3, 1))
    tan = np.tile(np.asarray(_rgb(19), np.uint8), (3, 3, 1))
    mask = np.ones((3, 3), bool)
    assert set(np.unique(classify(orange, mask, [19, 191], 0.01))) == {2}   # -> 191
    assert set(np.unique(classify(orange, mask, [191, 19], 0.01))) == {1}   # -> 191
    assert set(np.unique(classify(tan, mask, [19, 191], 0.01))) == {1}      # -> 19
    assert set(np.unique(classify(tan, mask, [191, 19], 0.01))) == {2}      # -> 19


def test_a_real_hue_difference_is_never_overridden_by_the_tiebreak():
    from placement_colored_cad import _rgb
    blue = np.tile(np.asarray(_rgb(1), np.uint8), (3, 3, 1))
    mask = np.ones((3, 3), bool)
    assert set(np.unique(classify(blue, mask, [1, 19, 191], 0.01))) == {1}


def test_the_light_bank_keeps_one_candidate_per_part_and_colour():
    placements = [dict(items=[('3023b', 191, np.eye(4))]),
                  dict(items=[('3023b', 191, np.eye(4) * 2)]),
                  dict(items=[('43722', 191, np.eye(4))])]
    kept = one_placement_per_key(placements)
    assert [entry['items'][0][0] for entry in kept] == ['3023b', '43722']
    assert kept[0] is placements[0]
