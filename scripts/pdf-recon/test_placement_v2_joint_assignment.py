import unittest

from placement_v2_correspondence import ObservedFeatureToken, PredictedFeatureToken
from placement_v2_joint_assignment import BaseFeature, solve_joint_base_assignment
from placement_v2_pose_assignment import PoseOption


def predicted(token_id, x, owner=None, seam=None):
    return PredictedFeatureToken(token_id, (owner or token_id,), (float(x), 0.0),
                                 (1.0, 0.0), shared_boundary_id=seam)


def observed(token_id, x):
    return ObservedFeatureToken(token_id, (float(x), 0.0), (1.0, 0.0))


class JointBaseAssignmentTest(unittest.TestCase):
    def test_foreground_pose_reclaims_stroke_from_suppressed_base(self):
        result = solve_joint_base_assignment(
            [PoseOption("front", "piece", (predicted("front-edge", 0),))],
            [observed("ink", 0)], {"piece": 1},
            [BaseFeature("base-edge", (predicted("base-edge", 0),), ("front",))])
        self.assertEqual(result.selected_pose_ids, ("front",))
        self.assertEqual(result.suppressed_base_feature_ids, ("base-edge",))
        self.assertEqual(len(result.matches), 1)
        self.assertEqual(result.base_matches, ())
        self.assertEqual(result.total_cost, 0.0)

    def test_occluded_base_feature_has_no_false_unmatched_penalty(self):
        result = solve_joint_base_assignment(
            [PoseOption("front", "piece", (predicted("front-edge", 0),))],
            [], {"piece": 1},
            [BaseFeature("base-edge", (predicted("base-edge", 100),), ("front",))],
            minimum_matches_per_real_pose=0)
        self.assertEqual(result.total_cost, 2.0)  # front edge only
        self.assertEqual(result.suppressed_base_feature_ids, ("base-edge",))

    def test_base_and_real_pose_share_observation_capacity(self):
        result = solve_joint_base_assignment(
            [PoseOption("part", "piece", (predicted("part-edge", 0),))],
            [observed("only-ink", 0)], {"piece": 1},
            [BaseFeature("base-edge", (predicted("base-edge", 0),))],
            minimum_matches_per_real_pose=0)
        self.assertEqual(len(result.matches) + len(result.base_matches), 1)
        self.assertEqual(result.total_cost, 2.0)

    def test_no_occluder_forces_visible_base_state(self):
        result = solve_joint_base_assignment(
            [], [observed("ink", 0)], {},
            [BaseFeature("base-edge", (predicted("base-edge", 0),))])
        self.assertEqual(result.visible_base_feature_ids, ("base-edge",))
        self.assertEqual(result.suppressed_base_feature_ids, ())
        self.assertEqual(len(result.base_matches), 1)

    def test_real_quotas_and_conflicts_are_preserved(self):
        options = [
            PoseOption("a", "piece", (predicted("a-edge", 0),)),
            PoseOption("b", "piece", (predicted("b-edge", 10),)),
        ]
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_joint_base_assignment(
                options, [observed("a", 0), observed("b", 10)], {"piece": 2}, [],
                conflicts=(("a", "b"),))

    def test_base_seam_group_and_ids_are_validated(self):
        with self.assertRaisesRegex(ValueError, "shared-boundary group"):
            solve_joint_base_assignment([], [], {}, [BaseFeature(
                "bad", (predicted("one", 0), predicted("two", 0)))])
        with self.assertRaisesRegex(ValueError, "unknown occluding pose"):
            solve_joint_base_assignment([], [], {}, [BaseFeature(
                "bad", (predicted("one", 0),), ("missing",))])
        with self.assertRaisesRegex(ValueError, "split across base features"):
            solve_joint_base_assignment([], [], {}, [
                BaseFeature("left", (predicted("left", 0, seam="same"),)),
                BaseFeature("right", (predicted("right", 0, seam="same"),)),
            ])


if __name__ == "__main__":
    unittest.main()
