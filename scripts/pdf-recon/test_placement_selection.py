import unittest
import numpy as np
from placement_selection import candidate_location, select_transform


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.a = np.eye(4)
        self.b = np.eye(4)
        self.b[:3, :3] = np.diag([-1, 1, -1])
        self.ts = [self.a, self.b]
        self.centers = np.array([[100, 200], [100, 200]])

    def test_winning_orientation_survives_identical_projection(self):
        loc = candidate_location(1, self.centers)
        old_index = int(np.argmin(np.linalg.norm(self.centers - loc['points'][0], axis=1)))
        self.assertEqual(old_index, 0)  # Reproduce the actual lossy boundary.
        chosen = select_transform(self.ts, loc, self.centers)
        self.assertEqual(chosen['index'], 1)
        np.testing.assert_array_equal(chosen['transform'], self.b)

    def test_old_point_only_tie_is_explicit(self):
        self.assertEqual(select_transform(self.ts, {'points': [[100, 200]]}, self.centers)['ambiguous_indices'], [0, 1])

    def test_invalid_index_cannot_silently_fallback(self):
        for index in (-1, 2, 1.2, True):
            with self.assertRaises(ValueError):
                select_transform(self.ts, {'candidate_index': index}, self.centers)

    def test_identity_selection_does_not_mutate_candidate(self):
        result = select_transform(self.ts, {'candidate_index': 1})
        result['transform'][0, 0] = 5
        self.assertEqual(self.b[0, 0], -1)


if __name__ == '__main__':
    unittest.main()
