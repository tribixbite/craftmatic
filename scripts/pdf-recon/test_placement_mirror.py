"""Tests for the mirror-completion channel and its mould table."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from placement_mirror_completion import detect_plane, frames_equal, mirror_transform
from placement_part_mirror_table import printed, reflections


def placement(x, y, z, R=None):
    T = np.eye(4)
    T[:3, 3] = (x, y, z)
    if R is not None:
        T[:3, :3] = R
    return T


class MirrorTableTests(unittest.TestCase):
    def test_reflections_are_improper_and_involutive_on_the_axes(self):
        for part in ('3020', '3024', '3031'):
            group = reflections(part)
            self.assertTrue(group, f'{part} should admit a reflection')
            for Q in group:
                self.assertAlmostEqual(float(np.linalg.det(Q)), -1.0, places=6)

    def test_printed_moulds_are_never_granted_a_reflection(self):
        # The evaluation's own detector misses the Studio-lineage `pzt` suffix,
        # which is why this channel carries a stricter test of its own.
        for part in ('3010py3', '98138pz0', '3010pzt'):
            self.assertTrue(printed(part))
            self.assertEqual(reflections(part), ())

    def test_a_chiral_mould_admits_none(self):
        self.assertEqual(reflections('43722'), ())
        self.assertEqual(reflections('43723'), ())


class MirrorTransformTests(unittest.TestCase):
    def test_reflecting_twice_returns_the_original_placement(self):
        Q = reflections('3020')[0]
        start = placement(30.0, -8.0, 12.0)
        once = mirror_transform(start, 2, 0.0, Q)
        twice = mirror_transform(once, 2, 0.0, Q)
        self.assertTrue(np.allclose(twice[:3, 3], start[:3, 3]))
        # Q is an involution on this mould's axes, so the frame returns exactly.
        self.assertTrue(frames_equal(twice[:3, :3], start[:3, :3], [np.eye(3)]))

    def test_the_realised_frame_is_proper(self):
        for part in ('3020', '3024', '3031'):
            for Q in reflections(part):
                out = mirror_transform(placement(10.0, 0.0, 7.0), 0, 3.0, Q)
                self.assertGreater(float(np.linalg.det(out[:3, :3])), 0.99)

    def test_the_offset_is_the_plane_not_a_translation(self):
        Q = reflections('3020')[0]
        out = mirror_transform(placement(0.0, 0.0, 25.0), 2, 10.0, Q)
        self.assertAlmostEqual(out[2, 3], -5.0)


class PlaneDetectionTests(unittest.TestCase):
    def symmetric_body(self, n=6, plane=0.0):
        items = []
        for k in range(n):
            items.append(('3020', 15, placement(20.0 * k, 0.0, plane + 30.0)))
            items.append(('3020', 15, placement(20.0 * k, 0.0, plane - 30.0)))
        return items

    def test_it_finds_the_plane_a_symmetric_body_implies(self):
        result = detect_plane(self.symmetric_body(plane=10.0))
        self.assertTrue(result['accepted'])
        self.assertEqual(result['axis'], 2)
        self.assertAlmostEqual(result['offset'], 10.0)
        self.assertEqual(result['fraction'], 1.0)

    def test_it_refuses_a_body_with_no_plane(self):
        items = [('3020', 15, placement(0.0, 0.0, 0.0)),
                 ('3024', 15, placement(37.0, -8.0, 13.0)),
                 ('3031', 15, placement(-11.0, 24.0, 61.0)),
                 ('3020', 15, placement(93.0, 16.0, -7.0)),
                 ('3024', 15, placement(5.0, 40.0, 29.0)),
                 ('3031', 15, placement(-63.0, 8.0, 3.0)),
                 ('3020', 15, placement(17.0, -24.0, 45.0)),
                 ('3024', 15, placement(71.0, 32.0, -19.0)),
                 ('3031', 15, placement(-29.0, 48.0, 23.0)),
                 ('3020', 15, placement(41.0, -40.0, 67.0))]
        result = detect_plane(items)
        self.assertFalse(result['accepted'])

    def test_it_abstains_when_too_few_parts_are_eligible(self):
        # Three parts agree with almost any plane; 41624's opening body reached
        # agreement 1.000 on a meaningless one before this guard existed.
        result = detect_plane(self.symmetric_body(n=1))
        self.assertFalse(result['accepted'])
        self.assertIn('too few', result['reason'])

    def test_chiral_and_printed_parts_do_not_veto_a_real_plane(self):
        items = self.symmetric_body() + [('43722', 0, placement(500.0, 0.0, 900.0))]
        result = detect_plane(items)
        self.assertTrue(result['accepted'])
        self.assertEqual(result['eligible'], 12)
        self.assertEqual(result['parts'], 13)


if __name__ == '__main__':
    unittest.main()
