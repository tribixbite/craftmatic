"""Tests pinning the population table's classification and its thresholds."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from placement_population_table import ABSOLUTE_VISIBILITY_FLOOR, classify


class ClassifyTests(unittest.TestCase):
    def test_a_pose_outside_the_bank_is_unreachable_however_visible(self):
        self.assertEqual(classify(False, 50_000, 1_000), 'unreachable')
        self.assertEqual(classify(False, 0, 1_000), 'unreachable')

    def test_an_unmeasured_pose_is_never_silently_classified(self):
        self.assertEqual(classify(True, None, 1_000), 'unmeasured')

    def test_the_absolute_floor_is_the_stated_one(self):
        self.assertEqual(classify(True, ABSOLUTE_VISIBILITY_FLOOR - 1, None),
                         'visibility_limited')
        self.assertEqual(classify(True, ABSOLUTE_VISIBILITY_FLOOR, None), 'mis_selected')

    def test_the_ratio_test_is_against_what_the_run_itself_selected(self):
        # 40377 page 24: 29 px against a 669 px rival is visibility-limited;
        # 1,196 against the same rival is not.
        self.assertEqual(classify(True, 29, 669), 'visibility_limited')
        self.assertEqual(classify(True, 1196, 669), 'mis_selected')

    def test_page_23_reproduces_round_fives_reading(self):
        # 523 px against a 619 px rival: comparable areas, so the failure is a
        # selection one at this body, not an evidence shortage.
        self.assertEqual(classify(True, 523, 619), 'mis_selected')

    def test_a_page_with_no_rival_falls_back_to_the_floor_alone(self):
        self.assertEqual(classify(True, 199, None), 'visibility_limited')
        self.assertEqual(classify(True, 201, None), 'mis_selected')

    def test_the_ratio_is_adjustable_without_touching_the_floor(self):
        self.assertEqual(classify(True, 300, 1_000, visibility_ratio=0.25), 'mis_selected')
        self.assertEqual(classify(True, 300, 1_000, visibility_ratio=0.5), 'visibility_limited')


if __name__ == '__main__':
    unittest.main()
