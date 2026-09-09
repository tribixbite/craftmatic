"""Offline checks that target colour classes are decided on channel spread.

The regression these pin: LDraw black #05131D differs by only 24 levels across
its channels, but at V=29 that reads as HSV saturation 211, so the classifier
treated it as a hue. Drawn black (median saturation 0) then matched nothing,
the "actual black is allowed" flag never fired, and every dark neutral target
pixel was discarded as invalid.
"""
import numpy as np
import pytest

from placement_palette_classes import NEUTRAL_CHANNEL_SPREAD, palette_labels

BLACK = (5, 19, 29)
WHITE = (255, 255, 255)
LIGHT_GREY = (160, 165, 169)
DARK_GREY = (108, 110, 104)
BLUE = (0, 85, 191)
RED = (201, 26, 9)
TAN = (228, 205, 158)


def field(color, shape=(8, 8)):
    image = np.zeros(shape + (3,), np.uint8)
    image[:, :] = color
    return image, np.ones(shape, bool)


def test_ldraw_black_is_treated_as_neutral():
    palette = np.asarray([BLACK, WHITE], np.uint8)
    image, mask = field((20, 20, 20))  # drawn black: dark, unsaturated
    labels, valid = palette_labels(image, mask, palette)
    assert valid.all(), 'dark neutral target pixels must not be discarded'
    assert (labels == 1).all(), 'drawn black must classify as the black entry'


def test_without_the_spread_rule_black_is_missed():
    palette = np.asarray([BLACK, WHITE], np.uint8)
    image, mask = field((20, 20, 20))
    labels, valid = palette_labels(image, mask, palette, neutral_spread=0)
    assert not (labels == 1).any(), 'this is the behaviour the fix replaces'


def test_hue_bearing_colours_stay_chromatic():
    palette = np.asarray([BLACK, WHITE, BLUE, RED, TAN], np.uint8)
    for index, color in ((3, BLUE), (4, RED), (5, TAN)):
        labels, _ = palette_labels(*field(color), palette)
        assert (labels == index).all(), f'{color} must keep its own class'


def test_the_grey_family_separates_by_value():
    palette = np.asarray([BLACK, WHITE, LIGHT_GREY, DARK_GREY], np.uint8)
    for index, color in ((1, (18, 18, 18)), (2, (250, 250, 250)),
                         (3, LIGHT_GREY), (4, DARK_GREY)):
        labels, _ = palette_labels(*field(color), palette)
        assert (labels == index).all(), f'{color} must land on entry {index}'


def test_a_palette_without_black_still_discards_dark_neutrals():
    """Unchanged behaviour: nothing in the assembly can explain drawn black."""
    palette = np.asarray([WHITE, LIGHT_GREY], np.uint8)
    _, valid = palette_labels(*field((20, 20, 20)), palette)
    assert not valid.any()


def test_default_spread_is_the_documented_one():
    assert NEUTRAL_CHANNEL_SPREAD == 30
    palette = np.asarray([BLACK], np.uint8)
    spread = int(palette.max()) - int(palette.min())
    assert spread <= NEUTRAL_CHANNEL_SPREAD < int(max(BLUE)) - int(min(BLUE))


def test_invalid_inputs_are_rejected():
    palette = np.asarray([WHITE], np.uint8)
    with pytest.raises(ValueError):
        palette_labels(*field(WHITE), palette, neutral_spread=-1)
    with pytest.raises(ValueError):
        palette_labels(*field(WHITE), np.zeros((0, 3), np.uint8))
