"""Tests for the opt-in saturation tie-break in palette_labels."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from placement_palette_classes import palette_labels

# LDraw 19 (Tan) and 191 (Bright Light Orange): both convert to OpenCV hue 20,
# and their saturations are 78 and 192.
TAN = (228, 205, 158)
ORANGE = (248, 187, 61)
BLUE = (0, 85, 191)


def image(color, size=8):
    return np.tile(np.asarray(color, np.uint8), (size, size, 1))


class SaturationTiebreakTests(unittest.TestCase):
    def classify(self, pixel, palette, weight=0.0):
        rgb = image(pixel)
        mask = np.ones(rgb.shape[:2], bool)
        labels, _valid = palette_labels(rgb, mask, np.asarray(palette, np.uint8),
                                        saturation_tiebreak=weight)
        return int(np.bincount(labels.reshape(-1), minlength=len(palette) + 1).argmax())

    def test_without_it_palette_order_decides_a_shared_hue(self):
        self.assertEqual(self.classify(ORANGE, [TAN, ORANGE]), 1)
        self.assertEqual(self.classify(ORANGE, [ORANGE, TAN]), 1)
        # Same pixel, opposite verdicts: index 1 is tan in the first list and
        # orange in the second.

    def test_with_it_the_verdict_is_the_same_either_way(self):
        self.assertEqual(self.classify(ORANGE, [TAN, ORANGE], 0.01), 2)
        self.assertEqual(self.classify(ORANGE, [ORANGE, TAN], 0.01), 1)
        self.assertEqual(self.classify(TAN, [TAN, ORANGE], 0.01), 1)
        self.assertEqual(self.classify(TAN, [ORANGE, TAN], 0.01), 2)

    def test_it_does_not_override_a_real_hue_difference(self):
        self.assertEqual(self.classify(BLUE, [BLUE, ORANGE], 0.05), 1)
        self.assertEqual(self.classify(BLUE, [ORANGE, BLUE], 0.05), 2)

    def test_it_never_changes_which_pixels_are_accepted(self):
        rgb = np.stack([image(c) for c in (TAN, ORANGE, BLUE, (10, 10, 10))]).reshape(-1, 8, 3)
        mask = np.ones(rgb.shape[:2], bool)
        palette = np.asarray([TAN, ORANGE, BLUE], np.uint8)
        base = palette_labels(rgb, mask, palette)[0] > 0
        for weight in (0.01, 0.05, 0.2):
            self.assertTrue(np.array_equal(base, palette_labels(
                rgb, mask, palette, saturation_tiebreak=weight)[0] > 0))

    def test_a_negative_weight_is_refused(self):
        with self.assertRaises(ValueError):
            palette_labels(image(TAN), np.ones((8, 8), bool),
                           np.asarray([TAN], np.uint8), saturation_tiebreak=-1.0)

    def test_the_default_is_off(self):
        rgb, mask = image(ORANGE), np.ones((8, 8), bool)
        palette = np.asarray([TAN, ORANGE], np.uint8)
        self.assertTrue(np.array_equal(palette_labels(rgb, mask, palette)[0],
                                       palette_labels(rgb, mask, palette,
                                                      saturation_tiebreak=0.0)[0]))


if __name__ == '__main__':
    unittest.main()
