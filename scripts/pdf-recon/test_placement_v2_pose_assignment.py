import unittest

from placement_v2_correspondence import (
    CorrespondenceConfig, ObservedFeatureToken, PredictedFeatureToken,
)
from placement_v2_pose_assignment import PoseOption, solve_pose_assignment


def predicted(token_id, x, tangent=(1.0, 0.0)):
    return PredictedFeatureToken(token_id, (token_id,), (float(x), 0.0), tangent)


def observed(token_id, x, tangent=(1.0, 0.0)):
    return ObservedFeatureToken(token_id, (float(x), 0.0), tangent)


class PoseAssignmentTest(unittest.TestCase):
    def test_joint_assignment_avoids_reusing_independent_local_winner_stroke(self):
        # Each duplicate pose wins its own local comparison at x=0, but both
        # cannot claim that ink. The joint optimum uses the complementary pose.
        options = [
            PoseOption("a-duplicate", "a", (predicted("pa0", 0),)),
            PoseOption("a-complement", "a", (predicted("pa1", 10),)),
            PoseOption("b-duplicate", "b", (predicted("pb0", 0),)),
            PoseOption("b-complement", "b", (predicted("pb1", 10),)),
        ]
        result = solve_pose_assignment(options, [observed("left", 0), observed("right", 10)],
                                       {"a": 1, "b": 1})
        selected = set(result.selected_pose_ids)
        self.assertEqual(len(selected & {"a-duplicate", "b-duplicate"}), 1)
        self.assertEqual(len(selected & {"a-complement", "b-complement"}), 1)
        self.assertEqual({match.observed_token_id for match in result.matches}, {"left", "right"})
        self.assertEqual(result.total_cost, 0.0)

    def test_exact_quotas_and_conflicts(self):
        options = [
            PoseOption("a", "piece", (predicted("a", 0),)),
            PoseOption("b", "piece", (predicted("b", 0),)),
            PoseOption("c", "piece", (predicted("c", 5),)),
        ]
        result = solve_pose_assignment(options, [observed("zero", 0), observed("five", 5)],
                                       {"piece": 2}, conflicts=(("a", "b"),))
        self.assertEqual(len(result.selected_pose_ids), 2)
        self.assertIn("c", result.selected_pose_ids)
        self.assertFalse({"a", "b"} <= set(result.selected_pose_ids))

    def test_disconnected_support_cycle_is_infeasible(self):
        options = [
            PoseOption("a", "piece", (), False, ("b",)),
            PoseOption("b", "piece", (), False, ("a",)),
        ]
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_pose_assignment(options, [], {"piece": 2})

    def test_rooted_support_cycle_is_accepted(self):
        options = [
            PoseOption("root", "piece", ()),
            PoseOption("a", "piece", (), False, ("root", "b")),
            PoseOption("b", "piece", (), False, ("a",)),
        ]
        result = solve_pose_assignment(options, [], {"piece": 3})
        self.assertEqual(result.selected_pose_ids, ("a", "b", "root"))

    def test_infeasible_quota_has_no_dummy_pose_result(self):
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_pose_assignment([PoseOption("only", "piece", ())], [], {"piece": 2})

    def test_small_exact_objective_uses_core_distance_and_unmatched_costs(self):
        config = CorrespondenceConfig(distance_weight=1.0, tangent_weight=1.0,
                                      unmatched_visible_prediction_cost=2.0,
                                      unmatched_observation_cost=2.0)
        result = solve_pose_assignment(
            [PoseOption("pose", "piece", (predicted("near", 1),
                                                   predicted("unmatched", 100)))],
            [observed("ink", 0)], {"piece": 1}, config=config)
        # distance residual 1 + one unmatched visible prediction at cost 2.
        self.assertAlmostEqual(result.total_cost, 3.0)
        self.assertTrue(result.optimal)
        self.assertEqual(result.status, "optimal")
        self.assertEqual(result.mip_gap, 0.0)
        self.assertEqual(len(result.matches), 1)

    def test_non_base_pose_requires_a_selected_parent(self):
        options = [
            PoseOption("root", "root", ()),
            PoseOption("child", "child", (), False, ("root",)),
        ]
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_pose_assignment(options, [], {"root": 0, "child": 1})

    def test_unknown_support_parent_is_still_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown support pose"):
            solve_pose_assignment(
                [PoseOption("child", "piece", (), False, ("missing",))],
                [], {"piece": 0})

    def test_match_floor_is_opt_in_and_default_allows_zero_token_pose(self):
        result = solve_pose_assignment(
            [PoseOption("physical-only", "piece", ())], [], {"piece": 1})
        self.assertEqual(result.selected_pose_ids, ("physical-only",))

    def test_match_floor_avoids_zero_token_pose_when_visible_option_exists(self):
        options = [
            PoseOption("physical-only", "piece", ()),
            PoseOption("drawn", "piece", (predicted("edge", 0),)),
        ]
        result = solve_pose_assignment(
            options, [observed("ink", 0)], {"piece": 1},
            minimum_matches_per_selected_pose=1)
        self.assertEqual(result.selected_pose_ids, ("drawn",))
        self.assertEqual(len(result.matches), 1)

    def test_match_floor_makes_unsupported_exact_quota_infeasible(self):
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_pose_assignment(
                [PoseOption("physical-only", "piece", ())], [], {"piece": 1},
                minimum_matches_per_selected_pose=1)

    def test_invalid_match_floor_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "minimum_matches"):
            solve_pose_assignment([], [], {}, minimum_matches_per_selected_pose=-1)

    def test_per_pose_match_floor_override_exempts_auxiliary_pose(self):
        options = [
            PoseOption("real", "real", (predicted("edge", 0),)),
            PoseOption("aux", "aux", ()),
        ]
        result = solve_pose_assignment(
            options, [observed("ink", 0)], {"real": 1, "aux": 1},
            minimum_matches_per_selected_pose=1,
            minimum_matches_by_pose={"aux": 0})
        self.assertEqual(result.selected_pose_ids, ("aux", "real"))

    def test_unknown_match_floor_override_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown minimum-match"):
            solve_pose_assignment([], [], {}, minimum_matches_by_pose={"missing": 0})

    def test_kdtree_radius_keeps_far_observation_with_large_uncertainty(self):
        observations = [
            ObservedFeatureToken("near-but-ineligible", (5.0, 0.0), (1.0, 0.0),
                                 uncertainty=1.0),
            ObservedFeatureToken("far-but-eligible", (10.0, 0.0), (1.0, 0.0),
                                 uncertainty=3.0),
        ]
        result = solve_pose_assignment(
            [PoseOption("pose", "piece", (predicted("edge", 0),))],
            observations, {"piece": 1})
        self.assertEqual(result.matches[0].observed_token_id, "far-but-eligible")
        self.assertAlmostEqual(result.matches[0].distance_sigma, 10 / 3)


if __name__ == "__main__":
    unittest.main()
