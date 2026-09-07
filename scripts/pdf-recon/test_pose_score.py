import unittest
import numpy as np
from pose_score import score


class PoseScoreTest(unittest.TestCase):
    def fixture(self):
        return [(str(i), i, np.array(p, float), np.eye(3))
                for i, p in enumerate([(0, 0, 0), (20, 0, 0), (0, 24, 0), (0, 0, 40)])]

    def test_rigid_frame_is_invariant(self):
        truth = self.fixture()
        r = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]])
        recon = [(p, c, r @ pos + 123, r @ rot) for p, c, pos, rot in truth]
        self.assertEqual(score(recon, truth)['coverage'], 1)

    def test_wrong_color_and_rotation_fail(self):
        truth = self.fixture()
        recon = list(truth)
        p, c, pos, rot = recon[1]
        recon[1] = (p, 99, pos, rot)
        p, c, pos, rot = recon[2]
        recon[2] = (p, c, pos, np.diag([-1, -1, 1]))
        self.assertEqual(score(recon, truth)['matched'], 2)

    def test_stud_offset_is_not_accurate(self):
        truth = self.fixture()
        recon = list(truth)
        p, c, pos, rot = recon[1]
        recon[1] = (p, c, pos + [20, 0, 0], rot)
        self.assertEqual(score(recon, truth)['matched'], 3)

    def test_reflection_does_not_pass(self):
        truth = self.fixture()
        m = np.diag([-1, 1, 1])
        recon = [(p, c, m @ pos, m @ rot) for p, c, pos, rot in truth]
        self.assertEqual(score(recon, truth)['matched'], 0)

    def test_duplicate_cannot_cover_two_truth_parts(self):
        truth = self.fixture()
        self.assertEqual(score([truth[0], truth[0]], truth)['matched'], 1)


if __name__ == '__main__':
    unittest.main()
