import unittest

import numpy as np

from placement_v2_visibility import estimate_sample_visibility


def base():
    mask = np.zeros((3, 4), dtype=bool)
    depth = np.full(mask.shape, -np.inf)
    mask[1, 1] = True
    depth[1, 1] = 5.0
    return depth, mask


class SampleVisibilityTest(unittest.TestCase):
    def test_nearer_and_exact_tie_are_visible_but_farther_is_occluded(self):
        depth, mask = base()
        result = estimate_sample_visibility(
            [[1.2, 1.7], [1.8, 1.1], [1.1, 1.2]], [6.0, 5.0, 4.0],
            depth, mask, (4, 3))
        self.assertEqual((result.visible_count, result.occluded_count,
                          result.offcanvas_count), (2, 1, 0))
        self.assertAlmostEqual(result.visibility_fraction, 2 / 3)

    def test_background_sample_is_visible(self):
        depth, mask = base()
        result = estimate_sample_visibility([[2.5, 0.5]], [-100.0],
                                            depth, mask, (4, 3))
        self.assertEqual(result.visible_count, 1)
        self.assertEqual(result.visibility_fraction, 1.0)

    def test_offcanvas_samples_are_counted_and_reduce_fraction(self):
        depth, mask = base()
        result = estimate_sample_visibility(
            [[0.1, 0.1], [-0.1, 1.0], [4.0, 1.0], [1.0, 3.0]],
            [0.0, 0.0, 0.0, 0.0], depth, mask, (4, 3))
        self.assertEqual((result.visible_count, result.occluded_count,
                          result.offcanvas_count), (1, 0, 3))
        self.assertEqual(result.visibility_fraction, 0.25)

    def test_margin_softens_small_behind_base_difference(self):
        depth, mask = base()
        strict = estimate_sample_visibility([[1.0, 1.0]], [4.8],
                                            depth, mask, (4, 3))
        tolerant = estimate_sample_visibility([[1.0, 1.0]], [4.8],
                                              depth, mask, (4, 3), margin=0.2)
        self.assertEqual(strict.occluded_count, 1)
        self.assertEqual(tolerant.visible_count, 1)

    def test_malformed_arrays_and_parameters_are_rejected(self):
        depth, mask = base()
        bad_cases = [
            ([], [], depth, mask, (4, 3), 0),
            ([[0, 0, 0]], [1], depth, mask, (4, 3), 0),
            ([[0, 0]], [1, 2], depth, mask, (4, 3), 0),
            ([[np.nan, 0]], [1], depth, mask, (4, 3), 0),
            ([[0, 0]], [1], depth[:, :2], mask, (4, 3), 0),
            ([[0, 0]], [1], depth, mask.astype(np.uint8), (4, 3), 0),
            ([[0, 0]], [1], depth, mask, (3, 4), 0),
            ([[0, 0]], [1], depth, mask, (4, 3), -1),
        ]
        for args in bad_cases:
            with self.subTest(args=args[:2]):
                with self.assertRaises(ValueError):
                    estimate_sample_visibility(*args[:-1], margin=args[-1])


if __name__ == "__main__":
    unittest.main()
